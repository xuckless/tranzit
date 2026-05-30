package main

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/proto"
)

type prevPos struct {
	lat, lon float64
	ts       int64
}

func getRTFeed(appToken, url string, retries int) (*gtfs.FeedMessage, []byte) {
	for attempt := 1; attempt <= retries; attempt++ {
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			fmt.Printf("  RT build request error (%d/%d): %v\n", attempt, retries, err)
			continue
		}
		req.Header.Set("X-App-Token", appToken)

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			fmt.Printf("  RT fetch error (%d/%d) %s: %v\n", attempt, retries, url, err)
			time.Sleep(time.Duration(1<<attempt) * time.Second)
			continue
		}
		content, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil || resp.StatusCode >= 400 {
			fmt.Printf("  RT read error (%d/%d) %s: status=%d\n", attempt, retries, url, resp.StatusCode)
			time.Sleep(time.Duration(1<<attempt) * time.Second)
			continue
		}

		decoders := []func([]byte) ([]byte, error){
			func(c []byte) ([]byte, error) { return c, nil },
			func(c []byte) ([]byte, error) {
				r, err := gzip.NewReader(bytes.NewReader(c))
				if err != nil {
					return nil, err
				}
				defer r.Close()
				return io.ReadAll(r)
			},
			func(c []byte) ([]byte, error) {
				r, err := zlib.NewReader(bytes.NewReader(c))
				if err != nil {
					return nil, err
				}
				defer r.Close()
				return io.ReadAll(r)
			},
		}

		for _, decode := range decoders {
			decoded, err := decode(content)
			if err != nil {
				continue
			}
			feed := &gtfs.FeedMessage{}
			if err := proto.Unmarshal(decoded, feed); err != nil {
				continue
			}
			return feed, decoded
		}

		fmt.Printf("  RT parse error (%d/%d): could not decode — %d bytes\n", attempt, retries, len(content))
		time.Sleep(time.Duration(1<<attempt) * time.Second)
	}
	return nil, nil
}

func scrapeRealtime(ctx context.Context, pool *pgxpool.Pool, hub *wsHub, appToken string) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	// --- 1. Trip Updates + Stop Time Updates (PARENTS) ---
	fmt.Println("Updating trip updates...")
	feed, raw := getRTFeed(appToken, urlRTTrips, 3)
	if feed != nil {
		hub.broadcast("trips", raw)

		tripBatch := &pgx.Batch{}
		stuBatch := &pgx.Batch{}
		tripCount, stuCount := 0, 0

		for _, entity := range feed.Entity {
			if entity.TripUpdate == nil {
				continue
			}
			tu := entity.TripUpdate
			schedRel := enumStr(tripScheduleRel, int(tu.Trip.GetScheduleRelationship()), "SCHEDULED")
			tripBatch.Queue(`
             INSERT INTO trip_updates (trip_id, route_id, schedule_relationship, timestamp)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (trip_id) DO UPDATE SET
                route_id              = COALESCE(EXCLUDED.route_id, trip_updates.route_id),
                schedule_relationship = EXCLUDED.schedule_relationship,
                timestamp             = EXCLUDED.timestamp`,
				tu.Trip.GetTripId(),
				nullStr(tu.Trip.GetRouteId()),
				schedRel,
				int64(feed.Header.GetTimestamp()),
			)
			tripCount++

			for _, stu := range tu.StopTimeUpdate {
				var arrTime, depTime *int64
				if stu.Arrival != nil {
					if t := stu.Arrival.GetTime(); t > 0 {
						arrTime = &t
					}
				}
				if stu.Departure != nil {
					if t := stu.Departure.GetTime(); t > 0 {
						depTime = &t
					}
				}
				rel := enumStr(stopScheduleRel, int(stu.GetScheduleRelationship()), "SCHEDULED")
				stuBatch.Queue(`
                INSERT INTO stop_time_updates
                   (trip_id, stop_sequence, stop_id,
                    arrival_time, departure_time,
                    arrival_delay, departure_delay,
                    schedule_relationship,
                    scheduled_arrival_time, scheduled_departure_time)
                VALUES ($1,$2,$3,$4,$5,0,0,$6,$4,$5)
                ON CONFLICT (trip_id, stop_sequence) DO UPDATE SET
                   stop_id                  = COALESCE(EXCLUDED.stop_id, stop_time_updates.stop_id),
                   arrival_time             = COALESCE(EXCLUDED.arrival_time, stop_time_updates.arrival_time),
                   departure_time           = COALESCE(EXCLUDED.departure_time, stop_time_updates.departure_time),
                   arrival_delay            = EXCLUDED.arrival_time - stop_time_updates.scheduled_arrival_time,
                   departure_delay          = EXCLUDED.departure_time - stop_time_updates.scheduled_departure_time,
                   schedule_relationship    = EXCLUDED.schedule_relationship,
                   scheduled_arrival_time   = COALESCE(stop_time_updates.scheduled_arrival_time, EXCLUDED.arrival_time),
                   scheduled_departure_time = COALESCE(stop_time_updates.scheduled_departure_time, EXCLUDED.departure_time)`,
					tu.Trip.GetTripId(),
					int(stu.GetStopSequence()),
					stu.GetStopId(),
					arrTime, depTime, rel,
				)
				stuCount++
			}
		}

		if err := conn.SendBatch(ctx, tripBatch).Close(); err != nil {
			return fmt.Errorf("trip_updates upsert: %w", err)
		}
		if err := conn.SendBatch(ctx, stuBatch).Close(); err != nil {
			return fmt.Errorf("stop_time_updates upsert: %w", err)
		}
		fmt.Printf("  %d trips, %d stop time updates.\n", tripCount, stuCount)
	}

	// --- 2. Vehicle Positions (CHILDREN) ---
	prevPositions := make(map[string]prevPos)
	rows, err := conn.Query(ctx, "SELECT vehicle_id, latitude, longitude, timestamp FROM vehicle_positions")
	if err == nil {
		for rows.Next() {
			var vid string
			var p prevPos
			if err := rows.Scan(&vid, &p.lat, &p.lon, &p.ts); err == nil {
				prevPositions[vid] = p
			}
		}
		rows.Close()
	}

	fmt.Println("Updating vehicle positions...")
	feed, raw = getRTFeed(appToken, urlRTVehicles, 3)
	if feed != nil {
		hub.broadcast("vehicles", raw)

		batch := &pgx.Batch{}
		count := 0
		for _, entity := range feed.Entity {
			if entity.Vehicle == nil {
				continue
			}
			v := entity.Vehicle
			vid := v.Vehicle.GetId()
			if vid == "" {
				vid = entity.GetId()
			}
			lat := float64(v.Position.GetLatitude())
			lon := float64(v.Position.GetLongitude())
			ts := int64(v.GetTimestamp())
			if ts == 0 {
				ts = int64(feed.Header.GetTimestamp())
			}

			var bearing, speed *float64
			if prev, ok := prevPositions[vid]; ok && ts > prev.ts {
				dt := ts - prev.ts
				b := calcBearing(prev.lat, prev.lon, lat, lon)
				bearing = &b
				if s, ok := calcSpeed(prev.lat, prev.lon, lat, lon, dt); ok {
					speed = &s
				}
			}

			routeID := v.Trip.GetRouteId()
			tripID := v.Trip.GetTripId()
			congestion := enumStr(congestionLevel, int(v.GetCongestionLevel()), "UNKNOWN_CONGESTION_LEVEL")
			occupancy := enumStr(occupancyStatus, int(v.GetOccupancyStatus()), "UNKNOWN")

			// Ensure the trip_id exists to satisfy the foreign key constraint
			if tripID != "" {
				batch.Queue(`INSERT INTO trip_updates (trip_id) VALUES ($1) ON CONFLICT (trip_id) DO NOTHING`, tripID)
			}

			batch.Queue(`
             INSERT INTO vehicle_positions
                (vehicle_id, trip_id, route_id, latitude, longitude,
                 bearing, speed, timestamp, congestion_level, occupancy_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (vehicle_id) DO UPDATE SET
                trip_id          = COALESCE(EXCLUDED.trip_id, vehicle_positions.trip_id),
                route_id         = COALESCE(EXCLUDED.route_id, vehicle_positions.route_id),
                latitude         = EXCLUDED.latitude,
                longitude        = EXCLUDED.longitude,
                bearing          = COALESCE(EXCLUDED.bearing, vehicle_positions.bearing),
                speed            = COALESCE(EXCLUDED.speed, vehicle_positions.speed),
                timestamp        = EXCLUDED.timestamp,
                congestion_level = COALESCE(EXCLUDED.congestion_level, vehicle_positions.congestion_level),
                occupancy_status = COALESCE(EXCLUDED.occupancy_status, vehicle_positions.occupancy_status)`,
				vid, nullStr(tripID), nullStr(routeID), lat, lon,
				bearing, speed, ts, congestion, occupancy,
			)
			count++
		}
		if err := conn.SendBatch(ctx, batch).Close(); err != nil {
			return fmt.Errorf("vehicle_positions upsert: %w", err)
		}
		fmt.Printf("  %d vehicle positions updated.\n", count)
	}

	// --- 3. Impute route_id into vehicle_positions ---
	if _, err := conn.Exec(ctx, `
          UPDATE vehicle_positions vp
          SET route_id = tu.route_id
          FROM trip_updates tu
          WHERE vp.trip_id = tu.trip_id
            AND vp.route_id IS NULL
            AND tu.route_id IS NOT NULL`); err != nil {
		return fmt.Errorf("impute route_id: %w", err)
	}

	// --- 4. Alerts ---
	fmt.Println("Updating alerts...")
	feed, raw = getRTFeed(appToken, urlRTAlerts, 3)
	if feed != nil {
		hub.broadcast("alerts", raw)
		batch := &pgx.Batch{}
		count := 0
		for _, entity := range feed.Entity {
			if entity.Alert == nil {
				continue
			}
			a := entity.Alert
			header := firstTranslation(a.HeaderText)
			desc := firstTranslation(a.DescriptionText)
			alertURL := firstTranslation(a.Url)

			var periodStart, periodEnd *int64
			if len(a.ActivePeriod) > 0 {
				s := int64(a.ActivePeriod[0].GetStart())
				e := int64(a.ActivePeriod[0].GetEnd())
				periodStart = &s
				periodEnd = &e
			}
			var agencyID, routeID, stopID *string
			if len(a.InformedEntity) > 0 {
				ie := a.InformedEntity[0]
				agencyID = nullStr(ie.GetAgencyId())
				routeID = nullStr(ie.GetRouteId())
				stopID = nullStr(ie.GetStopId())
			}

			cause := enumStr(alertCause, int(a.GetCause()), "")
			effect := enumStr(alertEffect, int(a.GetEffect()), "")
			severity := enumStr(alertSeverity, int(a.GetSeverityLevel()), "")

			batch.Queue(`
             INSERT INTO alerts
                (alert_id, active_period_start, active_period_end,
                 informed_agency_id, informed_route_id, informed_stop_id,
                 header_text, description_text, cause, effect, url, severity_level)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (alert_id) DO UPDATE SET
                active_period_start = COALESCE(EXCLUDED.active_period_start, alerts.active_period_start),
                active_period_end   = COALESCE(EXCLUDED.active_period_end, alerts.active_period_end),
                informed_agency_id  = COALESCE(EXCLUDED.informed_agency_id, alerts.informed_agency_id),
                informed_route_id   = COALESCE(EXCLUDED.informed_route_id, alerts.informed_route_id),
                informed_stop_id    = COALESCE(EXCLUDED.informed_stop_id, alerts.informed_stop_id),
                header_text         = COALESCE(EXCLUDED.header_text, alerts.header_text),
                description_text    = COALESCE(EXCLUDED.description_text, alerts.description_text),
                cause               = COALESCE(EXCLUDED.cause, alerts.cause),
                effect              = COALESCE(EXCLUDED.effect, alerts.effect),
                url                 = COALESCE(EXCLUDED.url, alerts.url),
                severity_level      = COALESCE(EXCLUDED.severity_level, alerts.severity_level)`,
				entity.GetId(),
				periodStart, periodEnd,
				agencyID, routeID, stopID,
				nullStr(header), nullStr(desc),
				nullStr(cause), nullStr(effect), nullStr(alertURL),
				nullStr(severity),
			)
			count++
		}
		if err := conn.SendBatch(ctx, batch).Close(); err != nil {
			return fmt.Errorf("alerts upsert: %w", err)
		}
		fmt.Printf("  %d alerts updated.\n", count)
	}

	return nil
}

func firstTranslation(t *gtfs.TranslatedString) string {
	if t == nil || len(t.Translation) == 0 {
		return ""
	}
	return t.Translation[0].GetText()
}

// nullStr returns nil if s is empty, otherwise &s.
func nullStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
