package main

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const arrivedRadiusM = 20.0

type prevPos struct {
	lat, lon float64
	ts       int64
}

type departedObs struct {
	stopID  string
	routeID string
	delay   int64
	dwell   int64
}

type stateUpdate struct {
	newState      string
	arrivalTime   *int64
	departureTime *int64
	observedDelay *int64
	minDist       float64
	tripID        string
	stopSeq       int
}

func updateGeospatialObservations(ctx context.Context, pool *pgxpool.Pool, prevPositions map[string]prevPos, dwellMap map[[2]string]float64) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	rows, err := conn.Query(ctx, `
		SELECT
			vp.vehicle_id, vp.trip_id,
			vp.latitude, vp.longitude, vp.timestamp,
			tsd.stop_sequence, tsd.stop_id, tsd.transit_state,
			tsd.min_distance_recorded, tsd.actual_arrival_time,
			cts.point AS stop_wkt,
			stu.arrival_time AS scheduled_arrival,
			tsd.route_id
		FROM vehicle_positions vp
		CROSS JOIN LATERAL (
			SELECT stop_sequence, stop_id, transit_state,
			       min_distance_recorded, actual_arrival_time, route_id
			FROM trip_stop_delays
			WHERE trip_id = vp.trip_id
			  AND transit_state IN ('APPROACHING', 'ARRIVED')
			  AND stop_id ~ '^\d+$'
			ORDER BY stop_sequence
			LIMIT 1
		) tsd
		JOIN calgary_transit_stops cts
			ON cts.teleride_number = tsd.stop_id::BIGINT
		LEFT JOIN stop_time_updates stu
			ON stu.trip_id = vp.trip_id
		   AND stu.stop_sequence = tsd.stop_sequence
		WHERE vp.trip_id IS NOT NULL AND vp.trip_id != ''
		  AND vp.latitude IS NOT NULL AND vp.longitude IS NOT NULL
	`)
	if err != nil {
		return fmt.Errorf("geospatial query: %w", err)
	}
	defer rows.Close()

	var updates []stateUpdate
	var newlyDeparted []departedObs
	nArrived, nDirect, nInterp := 0, 0, 0

	for rows.Next() {
		var (
			vid, tripID      string
			lat, lon         float64
			ts               int64
			stopSeq          int
			stopID, state    string
			minDistPtr       *float64
			storedArrival    *int64
			stopWKT          string
			scheduledArrival *int64
			routeID          *string
		)
		if err := rows.Scan(
			&vid, &tripID,
			&lat, &lon, &ts,
			&stopSeq, &stopID, &state,
			&minDistPtr, &storedArrival,
			&stopWKT, &scheduledArrival, &routeID,
		); err != nil {
			continue
		}

		sLat, sLon, ok := parseWKTPoint(stopWKT)
		if !ok {
			continue
		}

		dist := haversineM(lat, lon, sLat, sLon)
		minDist := dist
		if minDistPtr != nil && *minDistPtr < minDist {
			minDist = *minDistPtr
		}

		prev, hasPrev := prevPositions[vid]

		newState := state
		actualArrival := storedArrival
		var actualDeparture *int64
		var observedDelay *int64

		switch state {
		case "APPROACHING":
			if dist <= arrivedRadiusM {
				newState = "ARRIVED"
				actualArrival = &ts
				nArrived++
			} else if hasPrev && ts > prev.ts {
				prevDist := haversineM(prev.lat, prev.lon, sLat, sLon)
				if prevDist < dist && prevDist < 300 {
					interpTS, ok := closestPointTime(
						prev.lat, prev.lon, prev.ts,
						lat, lon, ts,
						sLat, sLon,
					)
					if ok {
						rid := ""
						if routeID != nil {
							rid = *routeID
						}
						avgDwell := dwellMap[[2]string{stopID, rid}]
						if avgDwell == 0 {
							avgDwell = 30
						}
						newState = "DEPARTED"
						actualArrival = &interpTS
						dep := interpTS + int64(math.Round(avgDwell))
						actualDeparture = &dep
						if scheduledArrival != nil {
							d := interpTS - *scheduledArrival
							observedDelay = &d
						}
						nInterp++
					}
				}
			}

		case "ARRIVED":
			if dist > arrivedRadiusM {
				newState = "DEPARTED"
				actualDeparture = &ts
				if storedArrival != nil && scheduledArrival != nil {
					d := *storedArrival - *scheduledArrival
					observedDelay = &d
				}
				nDirect++
			}
		}

		if newState != state || minDist != func() float64 {
			if minDistPtr != nil {
				return *minDistPtr
			}
			return math.MaxFloat64
		}() {
			updates = append(updates, stateUpdate{
				newState:      newState,
				arrivalTime:   actualArrival,
				departureTime: actualDeparture,
				observedDelay: observedDelay,
				minDist:       minDist,
				tripID:        tripID,
				stopSeq:       stopSeq,
			})
		}

		if newState == "DEPARTED" && state != "DEPARTED" && observedDelay != nil {
			var dwell int64
			if actualDeparture != nil && actualArrival != nil {
				dwell = *actualDeparture - *actualArrival
			}
			rid := ""
			if routeID != nil {
				rid = *routeID
			}
			newlyDeparted = append(newlyDeparted, departedObs{
				stopID:  stopID,
				routeID: rid,
				delay:   *observedDelay,
				dwell:   dwell,
			})
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	if len(updates) > 0 {
		batch := &pgx.Batch{}
		const q = `
			UPDATE trip_stop_delays SET
				transit_state          = $1,
				actual_arrival_time    = $2,
				actual_departure_time  = $3,
				observed_delay_seconds = $4,
				min_distance_recorded  = $5
			WHERE trip_id = $6 AND stop_sequence = $7`
		for _, u := range updates {
			batch.Queue(q,
				u.newState, u.arrivalTime, u.departureTime,
				u.observedDelay, u.minDist,
				u.tripID, u.stopSeq,
			)
		}
		if err := conn.SendBatch(ctx, batch).Close(); err != nil {
			return fmt.Errorf("state updates: %w", err)
		}
	}

	if len(newlyDeparted) > 0 {
		type agg struct {
			n                      int64
			totalDelay, totalDwell float64
			lastDelay, lastDwell   int64
		}
		aggMap := make(map[[2]string]*agg)
		for _, d := range newlyDeparted {
			k := [2]string{d.stopID, d.routeID}
			a := aggMap[k]
			if a == nil {
				a = &agg{}
				aggMap[k] = a
			}
			a.n++
			a.totalDelay += float64(d.delay)
			a.totalDwell += float64(d.dwell)
			a.lastDelay = d.delay
			a.lastDwell = d.dwell
		}

		now := time.Now().Unix()
		abatch := &pgx.Batch{}
		const aq = `
			INSERT INTO stop_analytics
				(stop_id, route_id, sample_count,
				 avg_delay_seconds, avg_dwell_seconds, congestion_score,
				 last_delay_seconds, last_dwell_seconds, last_updated)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
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
				last_updated       = EXCLUDED.last_updated`
		for k, a := range aggMap {
			avgD := a.totalDelay / float64(a.n)
			avgW := a.totalDwell / float64(a.n)
			score := math.Min(100, math.Max(0, avgD/6.0))
			abatch.Queue(aq, k[0], k[1], a.n, avgD, avgW, score, a.lastDelay, a.lastDwell, now)
		}
		if err := conn.SendBatch(ctx, abatch).Close(); err != nil {
			return fmt.Errorf("analytics upsert: %w", err)
		}
	}

	_, err = conn.Exec(ctx, `
		UPDATE trip_stop_delays tsd
		SET
			historical_avg_delay = sa.avg_delay_seconds,
			historical_avg_dwell = sa.avg_dwell_seconds,
			congestion_score     = sa.congestion_score
		FROM stop_analytics sa
		WHERE tsd.stop_id = sa.stop_id
		  AND tsd.route_id = sa.route_id
	`)
	if err != nil {
		return fmt.Errorf("refresh denorm: %w", err)
	}

	fmt.Printf("  Geospatial: %d arrived, %d departed (direct), %d departed (interpolated).\n",
		nArrived, nDirect, nInterp)
	return nil
}
