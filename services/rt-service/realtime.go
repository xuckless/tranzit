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

		// Try raw, then gzip, then zlib.
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

	// Pre-fetch previous positions and dwell history before overwriting.
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

	dwellMap := make(map[[2]string]float64)
	drows, err := conn.Query(ctx, "SELECT stop_id, route_id, avg_dwell_seconds FROM stop_analytics WHERE avg_dwell_seconds > 0")
	if err == nil {
		for drows.Next() {
			var sid, rid string
			var avg float64
			if err := drows.Scan(&sid, &rid, &avg); err == nil {
				dwellMap[[2]string{sid, rid}] = avg
			}
		}
		drows.Close()
	}

	// --- Vehicle Positions ---
	fmt.Println("Updating vehicle positions...")
	feed, raw := getRTFeed(appToken, urlRTVehicles, 3)
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

			batch.Queue(`
				INSERT INTO vehicle_positions
					(vehicle_id, trip_id, route_id, latitude, longitude,
					 bearing, speed, timestamp, congestion_level, occupancy_status)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
				ON CONFLICT (vehicle_id) DO UPDATE SET
					trip_id          = EXCLUDED.trip_id,
					route_id         = EXCLUDED.route_id,
					latitude         = EXCLUDED.latitude,
					longitude        = EXCLUDED.longitude,
					bearing          = EXCLUDED.bearing,
					speed            = EXCLUDED.speed,
					timestamp        = EXCLUDED.timestamp,
					congestion_level = EXCLUDED.congestion_level,
					occupancy_status = EXCLUDED.occupancy_status`,
				vid, tripID, nullStr(routeID), lat, lon,
				bearing, speed, ts, congestion, occupancy,
			)
			count++
		}
		if err := conn.SendBatch(ctx, batch).Close(); err != nil {
			return fmt.Errorf("vehicle_positions upsert: %w", err)
		}
		fmt.Printf("  %d vehicle positions updated.\n", count)
	}

	// --- Trip Updates + Stop Time Updates ---
	fmt.Println("Updating trip updates...")
	feed, raw = getRTFeed(appToken, urlRTTrips, 3)
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
					route_id              = EXCLUDED.route_id,
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
				var arrDelay, depDelay *int32
				if stu.Arrival != nil {
					t := stu.Arrival.GetTime()
					arrTime = &t
					d := stu.Arrival.GetDelay()
					arrDelay = &d
				}
				if stu.Departure != nil {
					t := stu.Departure.GetTime()
					depTime = &t
					d := stu.Departure.GetDelay()
					depDelay = &d
				}
				rel := enumStr(stopScheduleRel, int(stu.GetScheduleRelationship()), "SCHEDULED")
				stuBatch.Queue(`
					INSERT INTO stop_time_updates
						(trip_id, stop_sequence, stop_id,
						 arrival_time, departure_time,
						 arrival_delay, departure_delay,
						 schedule_relationship)
					VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
					ON CONFLICT (trip_id, stop_sequence) DO UPDATE SET
						stop_id               = EXCLUDED.stop_id,
						arrival_time          = EXCLUDED.arrival_time,
						departure_time        = EXCLUDED.departure_time,
						arrival_delay         = EXCLUDED.arrival_delay,
						departure_delay       = EXCLUDED.departure_delay,
						schedule_relationship = EXCLUDED.schedule_relationship`,
					tu.Trip.GetTripId(),
					int(stu.GetStopSequence()),
					stu.GetStopId(),
					arrTime, depTime, arrDelay, depDelay, rel,
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

		// Impute route_id into vehicle_positions.
		if _, err := conn.Exec(ctx, `
			UPDATE vehicle_positions vp
			SET route_id = tu.route_id
			FROM trip_updates tu
			WHERE vp.trip_id = tu.trip_id
			  AND tu.route_id IS NOT NULL`); err != nil {
			return fmt.Errorf("impute route_id: %w", err)
		}

		// Incremental stop_analytics from scheduled GTFS data.
		if _, err := conn.Exec(ctx, `
			WITH batch AS (
				SELECT
					stu.stop_id,
					tu.route_id,
					COUNT(*)                                              AS batch_count,
					AVG(COALESCE(stu.arrival_delay, 0))                   AS batch_avg_delay,
					AVG(CASE WHEN stu.departure_time IS NOT NULL
					          AND stu.arrival_time  IS NOT NULL
					          AND stu.departure_time > stu.arrival_time
					         THEN (stu.departure_time - stu.arrival_time)::REAL
					         ELSE 0 END)                                  AS batch_avg_dwell,
					MAX(stu.arrival_delay)                                AS last_delay,
					MAX(CASE WHEN stu.departure_time IS NOT NULL
					          AND stu.arrival_time  IS NOT NULL
					          AND stu.departure_time > stu.arrival_time
					         THEN (stu.departure_time - stu.arrival_time)::INTEGER END) AS last_dwell
				FROM stop_time_updates stu
				JOIN trip_updates tu ON stu.trip_id = tu.trip_id
				WHERE tu.route_id IS NOT NULL
				  AND stu.arrival_delay IS NOT NULL
				GROUP BY stu.stop_id, tu.route_id
			)
			INSERT INTO stop_analytics
				(stop_id, route_id, sample_count,
				 avg_delay_seconds, avg_dwell_seconds, congestion_score,
				 last_delay_seconds, last_dwell_seconds, last_updated)
			SELECT
				stop_id, route_id, batch_count,
				batch_avg_delay, batch_avg_dwell,
				LEAST(100, GREATEST(0, batch_avg_delay / 6.0)),
				last_delay, last_dwell,
				EXTRACT(EPOCH FROM NOW())::BIGINT
			FROM batch
			ON CONFLICT (stop_id, route_id) DO UPDATE SET
				sample_count       = stop_analytics.sample_count + EXCLUDED.sample_count,
				avg_delay_seconds  = (stop_analytics.avg_delay_seconds * stop_analytics.sample_count
				                      + EXCLUDED.avg_delay_seconds      * EXCLUDED.sample_count)
				                     / (stop_analytics.sample_count + EXCLUDED.sample_count),
				avg_dwell_seconds  = (stop_analytics.avg_dwell_seconds * stop_analytics.sample_count
				                      + EXCLUDED.avg_dwell_seconds      * EXCLUDED.sample_count)
				                     / (stop_analytics.sample_count + EXCLUDED.sample_count),
				congestion_score   = LEAST(100, GREATEST(0,
				                       (stop_analytics.avg_delay_seconds * stop_analytics.sample_count
				                        + EXCLUDED.avg_delay_seconds      * EXCLUDED.sample_count)
				                       / (stop_analytics.sample_count + EXCLUDED.sample_count) / 6.0
				                     )),
				last_delay_seconds = EXCLUDED.last_delay_seconds,
				last_dwell_seconds = EXCLUDED.last_dwell_seconds,
				last_updated       = EXCLUDED.last_updated`); err != nil {
			return fmt.Errorf("stop_analytics update: %w", err)
		}

		// Seed new trip_stop_delays rows; ON CONFLICT DO NOTHING preserves geospatial state.
		if _, err := conn.Exec(ctx, `
			INSERT INTO trip_stop_delays
				(trip_id, stop_sequence, stop_id, route_id,
				 delay_seconds, historical_avg_delay, historical_avg_dwell,
				 congestion_score, dwell_seconds, transit_state)
			SELECT
				stu.trip_id, stu.stop_sequence, stu.stop_id, tu.route_id,
				stu.arrival_delay,
				sa.avg_delay_seconds, sa.avg_dwell_seconds, sa.congestion_score,
				CASE WHEN stu.departure_time IS NOT NULL AND stu.arrival_time IS NOT NULL
				          AND stu.departure_time > stu.arrival_time
				     THEN (stu.departure_time - stu.arrival_time)::INTEGER END,
				'APPROACHING'
			FROM stop_time_updates stu
			LEFT JOIN trip_updates tu ON stu.trip_id = tu.trip_id
			LEFT JOIN stop_analytics sa
				   ON stu.stop_id = sa.stop_id
				  AND tu.route_id = sa.route_id
			ON CONFLICT (trip_id, stop_sequence) DO NOTHING`); err != nil {
			return fmt.Errorf("seed trip_stop_delays: %w", err)
		}
	}

	// --- Geospatial engine ---
	fmt.Println("Running geospatial observation engine...")
	if err := updateGeospatialObservations(ctx, pool, prevPositions, dwellMap); err != nil {
		return fmt.Errorf("geospatial: %w", err)
	}

	// --- Alerts ---
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
					active_period_start = EXCLUDED.active_period_start,
					active_period_end   = EXCLUDED.active_period_end,
					informed_agency_id  = EXCLUDED.informed_agency_id,
					informed_route_id   = EXCLUDED.informed_route_id,
					informed_stop_id    = EXCLUDED.informed_stop_id,
					header_text         = EXCLUDED.header_text,
					description_text    = EXCLUDED.description_text,
					cause               = EXCLUDED.cause,
					effect              = EXCLUDED.effect,
					url                 = EXCLUDED.url,
					severity_level      = EXCLUDED.severity_level`,
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
