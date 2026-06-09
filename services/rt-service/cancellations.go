package main

// cancellations.go builds the GTFS-RT *TripUpdates* feed that OpenTripPlanner consumes.
//
// OTP treats the static GTFS schedule as authoritative: a scheduled trip with no realtime
// update is assumed to be running on time. The only way OTP drops a scheduled-but-not-running
// trip is if the TripUpdates feed explicitly marks it CANCELED. Calgary's live feed only tells
// us which trips ARE running, so this file derives the inverse — scheduled trips that should be
// mid-route right now but are absent from the live feed — and emits synthesized CANCELED entries.
//
// The result (Calgary's live TripUpdates, unchanged, plus the synthesized cancellations) is
// cached as a marshaled protobuf and served over HTTP at /gtfs-rt/trip-updates. OTP's
// stop-time-updater polls that endpoint instead of Calgary's raw feed.
//
// Cancellation synthesis requires the static GTFS tables (loaded via --load-gtfs). Without them
// the endpoint is a straight passthrough of the live feed.

import (
	"context"
	"sync"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"github.com/jackc/pgx/v5"
	"google.golang.org/protobuf/proto"
)

// cancelConfirmPolls is how many consecutive scrapes a scheduled trip must be missing from the
// live feed before we cancel it. This rides out transient single-poll feed gaps so we don't
// flap a legitimately-running trip out of OTP because one fetch came back short.
const cancelConfirmPolls = 2

// calgaryTZ is the agency timezone. GTFS stop_times are seconds since *service-day* midnight in
// this zone, so "now" must be measured here to decide which trips should currently be mid-route.
var calgaryTZ = func() *time.Location {
	loc, err := time.LoadLocation("America/Edmonton")
	if err != nil {
		return time.UTC
	}
	return loc
}()

// querier is the subset of pgx we need; *pgxpool.Conn satisfies it.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// missingTrip is a scheduled trip that should be running now but is absent from the live feed.
type missingTrip struct {
	tripID      string
	routeID     string
	serviceDate string // YYYYMMDD, for the GTFS-RT TripDescriptor.start_date
}

// tripUpdateFeed caches the marshaled OTP-facing feed and tracks how long each scheduled trip
// has been missing (for the confirm-before-cancel guard).
type tripUpdateFeed struct {
	gtfsLoaded bool // set once at startup; when false the feed is a live passthrough

	mu    sync.RWMutex
	bytes []byte

	counts map[string]int // trip_id -> consecutive scrapes missing from the live feed
}

func newTripUpdateFeed() *tripUpdateFeed {
	return &tripUpdateFeed{counts: make(map[string]int)}
}

// rebuild composes the OTP-facing feed from the live TripUpdates feed and (when static GTFS is
// loaded) the synthesized cancellations, marshals it, and swaps it into the cache.
func (f *tripUpdateFeed) rebuild(ctx context.Context, q querier, live *gtfs.FeedMessage) error {
	entities := live.GetEntity()

	// Cancellation synthesis is best-effort: if the query fails we still publish the live feed
	// as a passthrough. The augmentation must never be able to take down the whole feed (which
	// would leave OTP with no trip updates at all).
	var augErr error
	if f.gtfsLoaded {
		missing, err := missingActiveTrips(ctx, q)
		if err != nil {
			augErr = err
		} else if confirmed := f.confirm(missing); len(confirmed) > 0 {
			merged := make([]*gtfs.FeedEntity, 0, len(entities)+len(confirmed))
			merged = append(merged, entities...)
			for _, m := range confirmed {
				merged = append(merged, cancelEntity(m))
			}
			entities = merged
		}
	}

	out := &gtfs.FeedMessage{Header: live.GetHeader(), Entity: entities}
	b, err := proto.Marshal(out)
	if err != nil {
		return err
	}
	f.mu.Lock()
	f.bytes = b
	f.mu.Unlock()
	return augErr
}

// confirm advances the consecutive-missing counters and returns only the trips that have been
// missing for at least cancelConfirmPolls scrapes. Trips that reappeared have their counter reset.
func (f *tripUpdateFeed) confirm(missing []missingTrip) []missingTrip {
	seen := make(map[string]bool, len(missing))
	var confirmed []missingTrip
	for _, m := range missing {
		seen[m.tripID] = true
		f.counts[m.tripID]++
		if f.counts[m.tripID] >= cancelConfirmPolls {
			confirmed = append(confirmed, m)
		}
	}
	for id := range f.counts {
		if !seen[id] {
			delete(f.counts, id)
		}
	}
	return confirmed
}

// cancelEntity builds a GTFS-RT FeedEntity that cancels one trip.
func cancelEntity(m missingTrip) *gtfs.FeedEntity {
	td := &gtfs.TripDescriptor{
		TripId:               proto.String(m.tripID),
		ScheduleRelationship: gtfs.TripDescriptor_CANCELED.Enum(),
	}
	if m.serviceDate != "" {
		td.StartDate = proto.String(m.serviceDate)
	}
	if m.routeID != "" {
		td.RouteId = proto.String(m.routeID)
	}
	return &gtfs.FeedEntity{
		Id:         proto.String("rt-cancel-" + m.tripID),
		TripUpdate: &gtfs.TripUpdate{Trip: td},
	}
}

// missingActiveTrips returns scheduled trips whose service is active for the current service
// date, whose scheduled span [first departure, last arrival] contains "now", and which are not
// present in the live trip_updates table.
//
// Two service-day windows are considered: today, and yesterday shifted forward 86400s (to catch
// after-midnight trips whose stop_times exceed 24:00:00 and belong to yesterday's service day).
func missingActiveTrips(ctx context.Context, q querier) ([]missingTrip, error) {
	now := time.Now().In(calgaryTZ)
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, calgaryTZ)
	nowSecs := int(now.Sub(midnight).Seconds())

	today := midnight.Format("2006-01-02")
	yesterday := midnight.AddDate(0, 0, -1).Format("2006-01-02")

	const sql = `
WITH windows(service_date, now_secs) AS (
    VALUES ($1::date, $2::int), ($3::date, $4::int)
),
active AS (
    SELECT w.service_date, w.now_secs, c.service_id
    FROM windows w
    JOIN gtfs_calendar c
      ON w.service_date BETWEEN c.start_date AND c.end_date
     AND CASE EXTRACT(DOW FROM w.service_date)::int
            WHEN 0 THEN c.sunday
            WHEN 1 THEN c.monday
            WHEN 2 THEN c.tuesday
            WHEN 3 THEN c.wednesday
            WHEN 4 THEN c.thursday
            WHEN 5 THEN c.friday
            WHEN 6 THEN c.saturday
         END
     AND NOT EXISTS (
            SELECT 1 FROM gtfs_calendar_dates cd
            WHERE cd.service_id = c.service_id
              AND cd.date = w.service_date
              AND cd.exception_type = 2)
    UNION
    SELECT w.service_date, w.now_secs, cd.service_id
    FROM windows w
    JOIN gtfs_calendar_dates cd
      ON cd.date = w.service_date
     AND cd.exception_type = 1
),
spans AS (
    SELECT t.trip_id,
           MAX(t.route_id)        AS route_id,
           a.service_date,
           a.now_secs,
           MIN(st.departure_secs) AS first_dep,
           MAX(st.arrival_secs)   AS last_arr
    FROM active a
    JOIN gtfs_trips t       ON t.service_id = a.service_id
    JOIN gtfs_stop_times st ON st.trip_id   = t.trip_id
    GROUP BY t.trip_id, a.service_date, a.now_secs
)
SELECT DISTINCT ON (s.trip_id)
       s.trip_id,
       COALESCE(s.route_id, ''),
       to_char(s.service_date, 'YYYYMMDD')
FROM spans s
WHERE s.first_dep <= s.now_secs
  AND s.last_arr  >= s.now_secs
  AND NOT EXISTS (SELECT 1 FROM trip_updates tu WHERE tu.trip_id = s.trip_id)
ORDER BY s.trip_id, s.service_date DESC`

	rows, err := q.Query(ctx, sql, today, nowSecs, yesterday, nowSecs+86400)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []missingTrip
	for rows.Next() {
		var m missingTrip
		if err := rows.Scan(&m.tripID, &m.routeID, &m.serviceDate); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// isGTFSLoaded reports whether the static GTFS tables exist and are populated, which is the
// prerequisite for cancellation synthesis.
func isGTFSLoaded(ctx context.Context, q querier) (bool, error) {
	rows, err := q.Query(ctx, `SELECT to_regclass('public.gtfs_trips')::text`)
	if err != nil {
		return false, err
	}
	var reg *string
	for rows.Next() {
		if err := rows.Scan(&reg); err != nil {
			rows.Close()
			return false, err
		}
	}
	rows.Close()
	if reg == nil {
		return false, nil
	}

	rows, err = q.Query(ctx, `SELECT COUNT(*) FROM gtfs_trips`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	var n int64
	for rows.Next() {
		if err := rows.Scan(&n); err != nil {
			return false, err
		}
	}
	return n > 0, rows.Err()
}
