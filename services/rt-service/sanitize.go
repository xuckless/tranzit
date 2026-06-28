package main

// sanitize.go repairs Calgary's live GTFS-RT TripUpdates before they are published to OpenTripPlanner.
//
// OTP rejects a whole trip's realtime update with NEGATIVE_HOP_TIME when the predicted stop times
// are not monotonically non-decreasing along the trip. Calgary's raw feed emits such updates
// constantly (~57% of our updates were dropped, almost all at stopIndex=0), which silently reverts
// those trips to the static schedule. The dominant cause is a delay at an early stop that exceeds the
// scheduled hop to the next stop while that next stop carries no update — clamping the provided stops
// alone cannot fix it, so we rebuild a dense timetable: take each provided stop's delay, forward-fill
// it across the scheduled stops, add it to the scheduled times, and clamp so times never go backwards.
// The result is a complete set of StopTimeUpdates OTP can apply without interpolation.

import (
	"context"
	"math"
	"strings"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"
)

// schedStop is one static scheduled stop. arrSec/depSec are seconds since service-day midnight and
// are normalized in loadSchedules so both are always >= 0 (one filled from the other when absent).
type schedStop struct {
	seq    uint32
	stopID string
	arrSec int64
	depSec int64
}

// sanitizeStopTimes rewrites the StopTimeUpdates of every live entity whose trip matches the static
// schedule, into a dense monotonic timetable OTP will accept. Best-effort: on any DB error it returns
// the error and leaves live unchanged so rebuild still publishes the (unsanitized) feed.
func sanitizeStopTimes(ctx context.Context, q querier, live *gtfs.FeedMessage) error {
	seen := map[string]bool{}
	var tripIDs []string
	for _, e := range live.GetEntity() {
		tu := e.GetTripUpdate()
		if tu == nil || len(tu.StopTimeUpdate) == 0 {
			continue
		}
		if id := tu.GetTrip().GetTripId(); id != "" && !seen[id] {
			seen[id] = true
			tripIDs = append(tripIDs, id)
		}
	}
	if len(tripIDs) == 0 {
		return nil
	}

	schedules, err := loadSchedules(ctx, q, tripIDs)
	if err != nil {
		return err
	}

	for _, e := range live.GetEntity() {
		tu := e.GetTripUpdate()
		if tu == nil || len(tu.StopTimeUpdate) == 0 {
			continue
		}
		sched := schedules[tu.GetTrip().GetTripId()]
		if len(sched) == 0 {
			// Unscheduled / ADDED trip: OTP resolves its stops by stop_id (no static schedule
			// to match by sequence), so an empty stop_id is fatal — "Missing mandatory id on
			// FeedScopeId" drops the whole update. Strip the STUs Calgary sent without a stop_id;
			// pass the rest through untouched.
			kept := tu.StopTimeUpdate[:0]
			for _, stu := range tu.StopTimeUpdate {
				if strings.TrimSpace(stu.GetStopId()) != "" {
					kept = append(kept, stu)
				}
			}
			tu.StopTimeUpdate = kept
			continue
		}
		if rebuilt := rebuildTimetable(tu, sched); rebuilt != nil {
			tu.StopTimeUpdate = rebuilt
		}
	}
	return nil
}

// loadSchedules batch-loads the static scheduled stop times for the given trips, ordered by sequence.
func loadSchedules(ctx context.Context, q querier, tripIDs []string) (map[string][]schedStop, error) {
	rows, err := q.Query(ctx, `
		SELECT trip_id, stop_sequence, stop_id, arrival_secs, departure_secs
		FROM gtfs_stop_times
		WHERE trip_id = ANY($1)
		ORDER BY trip_id, stop_sequence`, tripIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string][]schedStop, len(tripIDs))
	for rows.Next() {
		var (
			tid    string
			seq    *int32
			stopID *string
			arr    *int32
			dep    *int32
		)
		if err := rows.Scan(&tid, &seq, &stopID, &arr, &dep); err != nil {
			return nil, err
		}
		if seq == nil {
			continue
		}
		s := schedStop{seq: uint32(*seq), arrSec: -1, depSec: -1}
		if stopID != nil {
			s.stopID = *stopID
		}
		if arr != nil {
			s.arrSec = int64(*arr)
		}
		if dep != nil {
			s.depSec = int64(*dep)
		}
		if s.arrSec < 0 && s.depSec < 0 {
			continue // a stop with neither scheduled time is unusable
		}
		if s.arrSec < 0 {
			s.arrSec = s.depSec
		}
		if s.depSec < 0 {
			s.depSec = s.arrSec
		}
		out[tid] = append(out[tid], s)
	}
	return out, rows.Err()
}

// rebuildTimetable returns a dense, monotonic []*StopTimeUpdate for tu by forward-filling each
// provided stop's delay across the scheduled stops. Returns nil when no provided update can be
// interpreted (caller then leaves the trip's updates untouched).
func rebuildTimetable(tu *gtfs.TripUpdate, sched []schedStop) []*gtfs.TripUpdate_StopTimeUpdate {
	serviceMidnight := serviceMidnightUnix(tu.GetTrip().GetStartDate())

	schedBySeq := make(map[uint32]schedStop, len(sched))
	for _, s := range sched {
		schedBySeq[s.seq] = s
	}

	// Implied delay (seconds) per stop_sequence: explicit Delay if present, else predicted Time minus
	// scheduled time. Departure is preferred over arrival.
	provided := make(map[uint32]int64)
	for _, stu := range tu.StopTimeUpdate {
		if stu.StopSequence == nil {
			continue
		}
		s, ok := schedBySeq[stu.GetStopSequence()]
		if !ok {
			continue
		}
		if d, ok := eventDelay(stu.Departure, serviceMidnight+s.depSec); ok {
			provided[s.seq] = d
		} else if d, ok := eventDelay(stu.Arrival, serviceMidnight+s.arrSec); ok {
			provided[s.seq] = d
		}
	}
	if len(provided) == 0 {
		return nil
	}

	// Seed the running delay with the earliest provided one so stops before the first update shift
	// with it (this is what removes the stopIndex=0 negative hop), then forward-fill and clamp.
	var curDelay int64
	for _, s := range sched {
		if d, ok := provided[s.seq]; ok {
			curDelay = d
			break
		}
	}

	out := make([]*gtfs.TripUpdate_StopTimeUpdate, 0, len(sched))
	floor := int64(math.MinInt64)
	for _, s := range sched {
		if d, ok := provided[s.seq]; ok {
			curDelay = d
		}
		arr := serviceMidnight + s.arrSec + curDelay
		dep := serviceMidnight + s.depSec + curDelay
		if arr < floor {
			arr = floor
		}
		if dep < arr {
			dep = arr
		}
		floor = dep

		stu := &gtfs.TripUpdate_StopTimeUpdate{
			StopSequence:         proto.Uint32(s.seq),
			Arrival:              &gtfs.TripUpdate_StopTimeEvent{Time: proto.Int64(arr)},
			Departure:            &gtfs.TripUpdate_StopTimeEvent{Time: proto.Int64(dep)},
			ScheduleRelationship: gtfs.TripUpdate_StopTimeUpdate_SCHEDULED.Enum(),
		}
		if s.stopID != "" {
			stu.StopId = proto.String(s.stopID)
		}
		out = append(out, stu)
	}
	return out
}

// eventDelay returns the delay (seconds) implied by a StopTimeEvent: its explicit Delay if present,
// otherwise Time minus the scheduled absolute time. ok is false when neither is usable.
func eventDelay(ev *gtfs.TripUpdate_StopTimeEvent, schedAbs int64) (int64, bool) {
	if ev == nil {
		return 0, false
	}
	if ev.Delay != nil {
		return int64(ev.GetDelay()), true
	}
	if ev.Time != nil && ev.GetTime() > 0 {
		return ev.GetTime() - schedAbs, true
	}
	return 0, false
}

// serviceMidnightUnix returns the Unix time of service-day midnight (Calgary local) for a GTFS
// start_date "YYYYMMDD", falling back to today when the date is missing or unparseable.
func serviceMidnightUnix(startDate string) int64 {
	if startDate != "" {
		if t, err := time.ParseInLocation("20060102", startDate, calgaryTZ); err == nil {
			return t.Unix()
		}
	}
	now := time.Now().In(calgaryTZ)
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, calgaryTZ).Unix()
}
