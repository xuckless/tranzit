package main

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newPool(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	// sslmode=require must be in DSN; pgx honours it automatically.
	return pgxpool.NewWithConfig(ctx, cfg)
}

func waitForDB(ctx context.Context, pool *pgxpool.Pool, retries int, delay time.Duration) error {
	for i := 1; i <= retries; i++ {
		if err := pool.Ping(ctx); err != nil {
			fmt.Printf("Supabase connection failed (%d/%d): %v\n", i, retries, err)
			time.Sleep(delay)
			continue
		}
		fmt.Println("Supabase connection established.")
		return nil
	}
	return fmt.Errorf("could not connect to Supabase after %d retries", retries)
}

func setupSchema(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	_, err = conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS calgary_transit_stops (
			teleride_number INTEGER,
			stop_name       TEXT,
			status          TEXT,
			create_dt_utc   TEXT,
			mod_dt_utc      TEXT,
			globalid        TEXT PRIMARY KEY,
			point           TEXT
		);

		CREATE TABLE IF NOT EXISTS calgary_transit_routes (
			route_category   TEXT,
			route_short_name TEXT,
			route_long_name  TEXT,
			create_dt_utc    TEXT,
			mod_dt_utc       TEXT,
			globalid         TEXT PRIMARY KEY,
			multilinestring  TEXT
		);

		CREATE TABLE IF NOT EXISTS calgary_train_stations (
			station_name TEXT PRIMARY KEY,
			leg          TEXT,
			dist_nb      INT,
			dist_sb      INT,
			dist_eb      INT,
			dist_wb      INT,
			route        INT,
			status       INT,
			point        TEXT
		);
	`)
	if err != nil {
		return fmt.Errorf("create static tables: %w", err)
	}

	_, err = conn.Exec(ctx, `
		COMMENT ON COLUMN calgary_transit_stops.teleride_number IS 'STOP_ID — the canonical stop identifier; maps to stop_time_updates.stop_id';
		COMMENT ON COLUMN calgary_transit_stops.status          IS 'ACTIVE or INACTIVE';
		COMMENT ON COLUMN calgary_transit_stops.point           IS 'WKT: POINT(longitude latitude)';
		COMMENT ON COLUMN calgary_transit_routes.multilinestring IS 'WKT route geometry for map rendering';
	`)
	if err != nil {
		return fmt.Errorf("static table comments: %w", err)
	}

	// Realtime tables are dropped and recreated on every startup.
	_, err = conn.Exec(ctx, `
		DROP TABLE IF EXISTS trip_updates CASCADE;
		DROP TABLE IF EXISTS stop_time_updates CASCADE;
		DROP TABLE IF EXISTS vehicle_positions CASCADE;
		DROP TABLE IF EXISTS alerts CASCADE;
		DROP TABLE IF EXISTS trip_stop_delays CASCADE;

		CREATE TABLE trip_updates (
			trip_id               TEXT PRIMARY KEY,
			route_id              TEXT,
			schedule_relationship TEXT,
			timestamp             BIGINT
		);

		CREATE TABLE stop_time_updates (
			trip_id               TEXT,
			stop_sequence         INTEGER,
			stop_id               TEXT,
			arrival_time          BIGINT,
			departure_time        BIGINT,
			arrival_delay         INTEGER,
			departure_delay       INTEGER,
			schedule_relationship TEXT,
			PRIMARY KEY (trip_id, stop_sequence)
		);

		CREATE TABLE vehicle_positions (
			vehicle_id       TEXT PRIMARY KEY,
			trip_id          TEXT,
			route_id         TEXT,
			latitude         REAL,
			longitude        REAL,
			bearing          REAL,
			speed            REAL,
			timestamp        BIGINT,
			congestion_level TEXT,
			occupancy_status TEXT
		);

		CREATE TABLE alerts (
			alert_id              TEXT PRIMARY KEY,
			active_period_start   BIGINT,
			active_period_end     BIGINT,
			informed_agency_id    TEXT,
			informed_route_id     TEXT,
			informed_stop_id      TEXT,
			header_text           TEXT,
			description_text      TEXT,
			cause                 TEXT,
			effect                TEXT,
			url                   TEXT,
			severity_level        TEXT
		);

		CREATE TABLE trip_stop_delays (
			trip_id                TEXT,
			stop_sequence          INTEGER,
			stop_id                TEXT,
			route_id               TEXT,
			delay_seconds          INTEGER,
			historical_avg_delay   REAL,
			historical_avg_dwell   REAL,
			congestion_score       REAL,
			dwell_seconds          INTEGER,
			transit_state          TEXT    DEFAULT 'APPROACHING',
			actual_arrival_time    BIGINT,
			actual_departure_time  BIGINT,
			min_distance_recorded  REAL,
			observed_delay_seconds INTEGER,
			PRIMARY KEY (trip_id, stop_sequence)
		);
	`)
	if err != nil {
		return fmt.Errorf("create realtime tables: %w", err)
	}

	_, err = conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS stop_analytics (
			stop_id            TEXT,
			route_id           TEXT,
			sample_count       BIGINT  DEFAULT 0,
			avg_delay_seconds  REAL    DEFAULT 0,
			avg_dwell_seconds  REAL    DEFAULT 0,
			congestion_score   REAL    DEFAULT 0,
			last_delay_seconds INTEGER,
			last_dwell_seconds INTEGER,
			last_updated       BIGINT,
			PRIMARY KEY (stop_id, route_id)
		);
		ALTER TABLE stop_analytics
			ALTER COLUMN sample_count TYPE BIGINT,
			ALTER COLUMN last_updated  TYPE BIGINT;
	`)
	if err != nil {
		return fmt.Errorf("create stop_analytics: %w", err)
	}

	_, err = conn.Exec(ctx, `
		COMMENT ON COLUMN trip_updates.route_id              IS 'Bus number (e.g. 3, 17, MAX Orange)';
		COMMENT ON COLUMN trip_updates.trip_id               IS 'One complete bus journey start-to-finish; hub key linking schedule, stops, and live position';
		COMMENT ON COLUMN trip_updates.timestamp             IS 'Scheduled departure time (Unix epoch)';
		COMMENT ON COLUMN stop_time_updates.trip_id          IS 'Links to trip_updates.trip_id';
		COMMENT ON COLUMN stop_time_updates.stop_id          IS 'Maps to calgary_transit_stops.teleride_number';
		COMMENT ON COLUMN stop_time_updates.stop_sequence    IS 'Stop order within the trip (1 = first stop)';
		COMMENT ON COLUMN stop_time_updates.arrival_time     IS 'Predicted arrival (Unix epoch)';
		COMMENT ON COLUMN stop_time_updates.departure_time   IS 'Predicted departure (Unix epoch)';
		COMMENT ON COLUMN vehicle_positions.route_id         IS 'Bus number — imputed from trip_updates via trip_id (not in raw feed)';
		COMMENT ON COLUMN vehicle_positions.bearing          IS 'Degrees 0-359 — calculated from consecutive lat/lng (not in raw feed)';
		COMMENT ON COLUMN vehicle_positions.speed            IS 'm/s — calculated from consecutive lat/lng + timestamp delta (not in raw feed)';
		COMMENT ON COLUMN vehicle_positions.timestamp        IS 'Live measurement time (Unix epoch)';
		COMMENT ON COLUMN stop_time_updates.arrival_delay    IS 'Seconds late vs. schedule (negative = early); from GTFS-RT feed';
		COMMENT ON COLUMN stop_time_updates.departure_delay  IS 'Seconds late vs. schedule at departure; from GTFS-RT feed';
		COMMENT ON COLUMN stop_analytics.avg_delay_seconds   IS 'Historical mean delay at this stop for this route (incremental mean, all-time)';
		COMMENT ON COLUMN stop_analytics.avg_dwell_seconds   IS 'Historical mean dwell time (departure - arrival); bottleneck indicator';
		COMMENT ON COLUMN stop_analytics.congestion_score    IS '0-100 score derived from avg_delay: 0=on-time, 100=10+ min late';
		COMMENT ON COLUMN stop_analytics.sample_count        IS 'Number of observations used in historical averages';
		COMMENT ON COLUMN trip_stop_delays.delay_seconds           IS 'Current GTFS-RT reported delay at this stop (seconds)';
		COMMENT ON COLUMN trip_stop_delays.historical_avg_delay     IS 'All-time average delay at this stop/route from stop_analytics';
		COMMENT ON COLUMN trip_stop_delays.congestion_score         IS 'Stop congestion score (0-100) from stop_analytics';
		COMMENT ON COLUMN trip_stop_delays.dwell_seconds            IS 'departure_time - arrival_time for this observation';
		COMMENT ON COLUMN trip_stop_delays.transit_state            IS 'Geospatial state machine: APPROACHING → ARRIVED → DEPARTED';
		COMMENT ON COLUMN trip_stop_delays.actual_arrival_time      IS 'Observed or interpolated Unix timestamp of bus arrival';
		COMMENT ON COLUMN trip_stop_delays.actual_departure_time    IS 'Observed or interpolated Unix timestamp of bus departure';
		COMMENT ON COLUMN trip_stop_delays.min_distance_recorded    IS 'Closest haversine distance seen between bus and stop (metres)';
		COMMENT ON COLUMN trip_stop_delays.observed_delay_seconds   IS 'Ground-truth delay: actual_arrival_time - scheduled_arrival_time';
	`)
	if err != nil {
		return fmt.Errorf("column comments: %w", err)
	}

	fmt.Println("Schema ready.")
	return nil
}

func isSoda2Loaded(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var count int
	err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM calgary_transit_routes").Scan(&count)
	return count > 0, err
}
