package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const soda2PageSize = 50_000

func soda2FetchAll(appToken, url string) ([]map[string]any, error) {
	var rows []map[string]any
	offset := 0
	for {
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("X-App-Token", appToken)
		q := req.URL.Query()
		q.Set("$limit", strconv.Itoa(soda2PageSize))
		q.Set("$offset", strconv.Itoa(offset))
		req.URL.RawQuery = q.Encode()

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if resp.StatusCode >= 400 {
			return nil, fmt.Errorf("SODA2 %s: HTTP %d", url, resp.StatusCode)
		}

		var page []map[string]any
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, err
		}
		if len(page) == 0 {
			break
		}
		rows = append(rows, page...)
		if len(page) < soda2PageSize {
			break
		}
		offset += soda2PageSize
	}
	return rows, nil
}

func geojsonToWKT(raw any) string {
	if raw == nil {
		return ""
	}
	var geo map[string]any
	switch v := raw.(type) {
	case string:
		if err := json.Unmarshal([]byte(v), &geo); err != nil {
			return v
		}
	case map[string]any:
		geo = v
	default:
		return ""
	}

	geoType, _ := geo["type"].(string)
	coords := geo["coordinates"]
	if coords == nil {
		return ""
	}

	switch geoType {
	case "Point":
		c, ok := coords.([]any)
		if !ok || len(c) < 2 {
			return ""
		}
		return fmt.Sprintf("POINT(%v %v)", c[0], c[1])
	case "MultiLineString":
		lines, ok := coords.([]any)
		if !ok {
			return ""
		}
		var parts []string
		for _, line := range lines {
			pts, ok := line.([]any)
			if !ok {
				continue
			}
			var ptStrs []string
			for _, pt := range pts {
				c, ok := pt.([]any)
				if !ok || len(c) < 2 {
					continue
				}
				ptStrs = append(ptStrs, fmt.Sprintf("%v %v", c[0], c[1]))
			}
			parts = append(parts, "("+strings.Join(ptStrs, ", ")+")")
		}
		return "MULTILINESTRING(" + strings.Join(parts, ", ") + ")"
	}
	b, _ := json.Marshal(geo)
	return string(b)
}

func strField(row map[string]any, key string) string {
	v, _ := row[key].(string)
	return v
}

func intField(row map[string]any, key string) *int {
	raw := row[key]
	if raw == nil {
		return nil
	}
	var s string
	switch v := raw.(type) {
	case string:
		s = v
	case float64:
		i := int(v)
		return &i
	default:
		return nil
	}
	i, err := strconv.Atoi(s)
	if err != nil {
		return nil
	}
	return &i
}

func scrapeSoda2(ctx context.Context, pool *pgxpool.Pool, appToken string) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	// --- Stops ---
	fmt.Println("Fetching Calgary Transit stops (SODA2)...")
	stops, err := soda2FetchAll(appToken, urlStops)
	if err != nil {
		return fmt.Errorf("stops fetch: %w", err)
	}
	var stopRows [][]any
	for _, s := range stops {
		teleride := intField(s, "teleride_number")
		stopRows = append(stopRows, []any{
			teleride,
			strField(s, "stop_name"),
			strField(s, "status"),
			strField(s, "create_dt_utc"),
			strField(s, "mod_dt_utc"),
			strField(s, "globalid"),
			geojsonToWKT(s["point"]),
		})
	}
	_, err = conn.CopyFrom(
		ctx,
		pgx.Identifier{"calgary_transit_stops"},
		[]string{"teleride_number", "stop_name", "status", "create_dt_utc", "mod_dt_utc", "globalid", "point"},
		pgx.CopyFromRows(stopRows),
	)
	// CopyFrom doesn't support ON CONFLICT; use batch upsert instead.
	if err != nil {
		// Fall back to upsert via pgx batch
		if err2 := upsertStops(ctx, conn.Conn(), stopRows); err2 != nil {
			return fmt.Errorf("stops upsert: %w", err2)
		}
	}
	fmt.Printf("  calgary_transit_stops: %d rows.\n", len(stopRows))

	// --- Routes ---
	fmt.Println("Fetching Calgary Transit routes (SODA2)...")
	routes, err := soda2FetchAll(appToken, urlRoutes)
	if err != nil {
		return fmt.Errorf("routes fetch: %w", err)
	}
	var routeRows [][]any
	for _, r := range routes {
		routeRows = append(routeRows, []any{
			strField(r, "route_category"),
			strField(r, "route_short_name"),
			strField(r, "route_long_name"),
			strField(r, "create_dt_utc"),
			strField(r, "mod_dt_utc"),
			strField(r, "globalid"),
			geojsonToWKT(r["multilinestring"]),
		})
	}
	if err := upsertRoutes(ctx, conn.Conn(), routeRows); err != nil {
		return fmt.Errorf("routes upsert: %w", err)
	}
	fmt.Printf("  calgary_transit_routes: %d rows.\n", len(routeRows))

	// --- Train Stations ---
	fmt.Println("Fetching Calgary Train stations (SODA2)...")
	stations, err := soda2FetchAll(appToken, urlTrainStations)
	if err != nil {
		return fmt.Errorf("stations fetch: %w", err)
	}
	var stationRows [][]any
	for _, s := range stations {
		stationRows = append(stationRows, []any{
			strField(s, "station_name"),
			strField(s, "leg"),
			intField(s, "dist_nb"),
			intField(s, "dist_sb"),
			intField(s, "dist_eb"),
			intField(s, "dist_wb"),
			intField(s, "route"),
			intField(s, "status"),
			geojsonToWKT(s["the_geom"]),
		})
	}
	if len(stationRows) > 0 {
		if err := upsertStations(ctx, conn.Conn(), stationRows); err != nil {
			return fmt.Errorf("stations upsert: %w", err)
		}
	}
	fmt.Printf("  calgary_train_stations: %d rows.\n", len(stationRows))

	fmt.Println("SODA2 scraping complete.")
	return nil
}

func upsertStops(ctx context.Context, conn *pgx.Conn, rows [][]any) error {
	batch := &pgx.Batch{}
	const q = `
		INSERT INTO calgary_transit_stops
			(teleride_number, stop_name, status, create_dt_utc, mod_dt_utc, globalid, point)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (globalid) DO UPDATE SET
			teleride_number = EXCLUDED.teleride_number,
			stop_name       = EXCLUDED.stop_name,
			status          = EXCLUDED.status,
			mod_dt_utc      = EXCLUDED.mod_dt_utc,
			point           = EXCLUDED.point`
	for _, r := range rows {
		batch.Queue(q, r...)
	}
	return conn.SendBatch(ctx, batch).Close()
}

func upsertRoutes(ctx context.Context, conn *pgx.Conn, rows [][]any) error {
	batch := &pgx.Batch{}
	const q = `
		INSERT INTO calgary_transit_routes
			(route_category, route_short_name, route_long_name, create_dt_utc, mod_dt_utc, globalid, multilinestring)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (globalid) DO UPDATE SET
			route_category   = EXCLUDED.route_category,
			route_short_name = EXCLUDED.route_short_name,
			route_long_name  = EXCLUDED.route_long_name,
			mod_dt_utc       = EXCLUDED.mod_dt_utc,
			multilinestring  = EXCLUDED.multilinestring`
	for _, r := range rows {
		batch.Queue(q, r...)
	}
	return conn.SendBatch(ctx, batch).Close()
}

func upsertStations(ctx context.Context, conn *pgx.Conn, rows [][]any) error {
	batch := &pgx.Batch{}
	const q = `
		INSERT INTO calgary_train_stations
			(station_name, leg, dist_nb, dist_sb, dist_eb, dist_wb, route, status, point)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (station_name) DO UPDATE SET
			leg     = EXCLUDED.leg,
			dist_nb = EXCLUDED.dist_nb,
			dist_sb = EXCLUDED.dist_sb,
			dist_eb = EXCLUDED.dist_eb,
			dist_wb = EXCLUDED.dist_wb,
			route   = EXCLUDED.route,
			status  = EXCLUDED.status,
			point   = EXCLUDED.point`
	for _, r := range rows {
		batch.Queue(q, r...)
	}
	return conn.SendBatch(ctx, batch).Close()
}
