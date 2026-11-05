package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// cleanup_views.go adds read-only convenience views over the existing realtime and
// SODA2 tables. They expose the data in "proper units" — Unix-epoch BIGINT columns as
// timestamptz, and WKT/lat-lng as PostGIS geometry — without altering any write path or
// existing table. Purely additive: every view is CREATE OR REPLACE and the underlying
// tables are untouched, so existing functionality keeps working exactly as before.
func setupCleanupViews(ctx context.Context, pool *pgxpool.Pool, hasPostGIS bool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	// Geometry expressions are only emitted when PostGIS is present.
	vpGeom, stopGeom, routeGeom := "NULL::text AS geom", "NULL::text AS geom", "NULL::text AS geom"
	if hasPostGIS {
		vpGeom = "ST_SetSRID(ST_MakePoint(longitude, latitude), 4326) AS geom"
		stopGeom = "ST_GeomFromText(NULLIF(point, ''), 4326) AS geom"
		routeGeom = "ST_GeomFromText(NULLIF(multilinestring, ''), 4326) AS geom"
	}

	stmts := []string{
		// Live vehicle positions with a real timestamp (and geometry when available).
		fmt.Sprintf(`
CREATE OR REPLACE VIEW vehicle_positions_clean AS
SELECT vehicle_id, trip_id, route_id, latitude, longitude,
       to_timestamp(timestamp) AS measured_at,
       bearing, speed, congestion_level, occupancy_status,
       %s
FROM vehicle_positions;`, vpGeom),

		// Stop time predictions with epoch columns surfaced as timestamptz.
		`
CREATE OR REPLACE VIEW stop_time_updates_clean AS
SELECT trip_id, stop_sequence, stop_id,
       to_timestamp(arrival_time)             AS arrival_at,
       to_timestamp(departure_time)           AS departure_at,
       arrival_delay, departure_delay,
       schedule_relationship,
       to_timestamp(scheduled_arrival_time)   AS scheduled_arrival_at,
       to_timestamp(scheduled_departure_time) AS scheduled_departure_at
FROM stop_time_updates;`,

		// Alerts with active period as timestamptz.
		`
CREATE OR REPLACE VIEW alerts_clean AS
SELECT alert_id,
       to_timestamp(active_period_start) AS active_from,
       to_timestamp(active_period_end)   AS active_to,
       informed_agency_id, informed_route_id, informed_stop_id,
       header_text, description_text, cause, effect, url, severity_level
FROM alerts;`,

		// SODA2 stops: ISO strings parsed to timestamptz, WKT promoted to geometry.
		fmt.Sprintf(`
CREATE OR REPLACE VIEW calgary_transit_stops_clean AS
SELECT teleride_number, stop_name, status,
       NULLIF(create_dt_utc, '')::timestamptz AS created_at,
       NULLIF(mod_dt_utc, '')::timestamptz    AS modified_at,
       globalid, point,
       %s
FROM calgary_transit_stops;`, stopGeom),

		// SODA2 routes: WKT promoted to geometry.
		fmt.Sprintf(`
CREATE OR REPLACE VIEW calgary_transit_routes_clean AS
SELECT route_category, route_short_name, route_long_name,
       NULLIF(create_dt_utc, '')::timestamptz AS created_at,
       NULLIF(mod_dt_utc, '')::timestamptz    AS modified_at,
       globalid, multilinestring,
       %s
FROM calgary_transit_routes;`, routeGeom),
	}

	for _, s := range stmts {
		if _, err := conn.Exec(ctx, s); err != nil {
			return fmt.Errorf("create cleanup view: %w", err)
		}
	}

	fmt.Println("Cleanup views ready (vehicle_positions_clean, stop_time_updates_clean, alerts_clean, calgary_transit_stops_clean, calgary_transit_routes_clean).")
	return nil
}
