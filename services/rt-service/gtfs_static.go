package main

import (
	"archive/zip"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// gtfs_static.go loads the Calgary Transit *static* GTFS feed (urlGTFSStatic) into a
// set of normalized gtfs_* tables. This is the schedule backbone the realtime feeds
// reference (trips, stop_times, calendar, shapes) and the offline-routing prerequisite
// for OpenTripPlanner. It is purely additive: it creates and fills its own tables and
// never touches the existing calgary_* / realtime tables.
//
// Loading is opt-in (main passes the --load-gtfs flag) because it downloads ~200 MB
// uncompressed and rewrites ~3.7M stop_times rows.

// setupGTFSSchema creates the gtfs_* tables (if absent) and reports whether PostGIS is
// available so callers can decide whether to populate geometry columns.
func setupGTFSSchema(ctx context.Context, pool *pgxpool.Pool) (hasPostGIS bool, err error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Release()

	// PostGIS is an enhancement, not a requirement. If it cannot be enabled we still
	// load every table; geometry columns are simply skipped.
	if _, e := conn.Exec(ctx, `CREATE EXTENSION IF NOT EXISTS postgis;`); e == nil {
		if e2 := conn.QueryRow(ctx, `SELECT postgis_version();`).Scan(new(string)); e2 == nil {
			hasPostGIS = true
		}
	}
	if !hasPostGIS {
		fmt.Println("  PostGIS not available — loading GTFS without geometry columns.")
	}

	_, err = conn.Exec(ctx, `
CREATE TABLE IF NOT EXISTS gtfs_agency (
	agency_id       TEXT PRIMARY KEY,
	agency_name     TEXT,
	agency_url      TEXT,
	agency_timezone TEXT,
	agency_lang     TEXT,
	agency_phone    TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_routes (
	route_id         TEXT PRIMARY KEY,
	route_short_name TEXT,
	route_long_name  TEXT,
	route_desc       TEXT,
	route_type       INTEGER,
	route_url        TEXT,
	route_color      TEXT,
	route_text_color TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_trips (
	trip_id       TEXT,
	route_id      TEXT,
	service_id    TEXT,
	trip_headsign TEXT,
	direction_id  INTEGER,
	block_id      TEXT,
	shape_id      TEXT
);

CREATE TABLE IF NOT EXISTS gtfs_stops (
	stop_id       TEXT,
	stop_code     TEXT,
	stop_name     TEXT,
	stop_desc     TEXT,
	stop_lat      DOUBLE PRECISION,
	stop_lon      DOUBLE PRECISION,
	zone_id       TEXT,
	stop_url      TEXT,
	location_type INTEGER
);

CREATE TABLE IF NOT EXISTS gtfs_stop_times (
	trip_id             TEXT,
	arrival_time        TEXT,
	departure_time      TEXT,
	arrival_secs        INTEGER,
	departure_secs      INTEGER,
	stop_id             TEXT,
	stop_sequence       INTEGER,
	pickup_type         INTEGER,
	drop_off_type       INTEGER,
	shape_dist_traveled DOUBLE PRECISION,
	timepoint           INTEGER
);

CREATE TABLE IF NOT EXISTS gtfs_calendar (
	service_id TEXT PRIMARY KEY,
	monday     BOOLEAN,
	tuesday    BOOLEAN,
	wednesday  BOOLEAN,
	thursday   BOOLEAN,
	friday     BOOLEAN,
	saturday   BOOLEAN,
	sunday     BOOLEAN,
	start_date DATE,
	end_date   DATE
);

CREATE TABLE IF NOT EXISTS gtfs_calendar_dates (
	service_id     TEXT,
	date           DATE,
	exception_type INTEGER
);

CREATE TABLE IF NOT EXISTS gtfs_shapes (
	shape_id            TEXT,
	shape_pt_lat        DOUBLE PRECISION,
	shape_pt_lon        DOUBLE PRECISION,
	shape_pt_sequence   INTEGER,
	shape_dist_traveled DOUBLE PRECISION
);
`)
	if err != nil {
		return hasPostGIS, fmt.Errorf("create gtfs tables: %w", err)
	}

	// Document units once so the schema is self-describing.
	_, err = conn.Exec(ctx, `
COMMENT ON TABLE  gtfs_stop_times                     IS 'Static GTFS scheduled stop times; arrival/departure kept as raw GTFS strings (may exceed 24:00:00) plus seconds-since-midnight integers';
COMMENT ON COLUMN gtfs_stop_times.arrival_secs        IS 'Scheduled arrival as seconds since service-day midnight (can exceed 86400 for after-midnight trips)';
COMMENT ON COLUMN gtfs_stop_times.departure_secs      IS 'Scheduled departure as seconds since service-day midnight';
COMMENT ON COLUMN gtfs_stops.stop_lat                 IS 'WGS84 latitude (degrees)';
COMMENT ON COLUMN gtfs_stops.stop_lon                 IS 'WGS84 longitude (degrees)';
COMMENT ON COLUMN gtfs_routes.route_type              IS 'GTFS route_type: 0=tram/CTrain, 3=bus';
COMMENT ON COLUMN gtfs_shapes.shape_dist_traveled     IS 'Distance travelled along shape (GTFS units, metres for Calgary)';
`)
	if err != nil {
		return hasPostGIS, fmt.Errorf("gtfs comments: %w", err)
	}

	if hasPostGIS {
		_, err = conn.Exec(ctx, `
ALTER TABLE gtfs_stops ADD COLUMN IF NOT EXISTS geom geometry(Point, 4326);
CREATE TABLE IF NOT EXISTS gtfs_shape_lines (
	shape_id TEXT PRIMARY KEY,
	geom     geometry(LineString, 4326)
);`)
		if err != nil {
			return hasPostGIS, fmt.Errorf("gtfs geometry columns: %w", err)
		}
	}

	return hasPostGIS, nil
}

// loadGTFSStatic downloads the static GTFS zip and (re)loads every table.
func loadGTFSStatic(ctx context.Context, pool *pgxpool.Pool, hasPostGIS bool) error {
	fmt.Println("Downloading static GTFS feed...")
	path, err := downloadToTemp(ctx, urlGTFSStatic)
	if err != nil {
		return fmt.Errorf("download gtfs: %w", err)
	}
	defer os.Remove(path)

	zr, err := zip.OpenReader(path)
	if err != nil {
		return fmt.Errorf("open gtfs zip: %w", err)
	}
	defer zr.Close()

	files := map[string]*zip.File{}
	for _, f := range zr.File {
		files[f.Name] = f
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	// Disable the per-statement timeout for this load session: the stop_times COPY is
	// ~3.7M rows in one statement and trips Supabase's default statement_timeout
	// (SQLSTATE 57014). Session-scoped SET only affects this connection.
	if _, err := conn.Exec(ctx, "SET statement_timeout = 0"); err != nil {
		return fmt.Errorf("disable statement_timeout: %w", err)
	}

	type spec struct {
		file    string
		table   string
		cols    []string
		mapRow  func(map[string]string) ([]any, error)
		indexes []string
	}

	specs := []spec{
		{
			file:  "agency.txt",
			table: "gtfs_agency",
			cols:  []string{"agency_id", "agency_name", "agency_url", "agency_timezone", "agency_lang", "agency_phone"},
			mapRow: func(r map[string]string) ([]any, error) {
				id := r["agency_id"]
				if id == "" {
					id = "1" // Calgary's agency.txt omits agency_id; synthesize a stable key.
				}
				return []any{id, r["agency_name"], r["agency_url"], r["agency_timezone"], gtfsStr(r["agency_lang"]), gtfsStr(r["agency_phone"])}, nil
			},
		},
		{
			file:  "routes.txt",
			table: "gtfs_routes",
			cols:  []string{"route_id", "route_short_name", "route_long_name", "route_desc", "route_type", "route_url", "route_color", "route_text_color"},
			mapRow: func(r map[string]string) ([]any, error) {
				return []any{r["route_id"], r["route_short_name"], r["route_long_name"], gtfsStr(r["route_desc"]), gtfsInt(r["route_type"]), gtfsStr(r["route_url"]), gtfsStr(r["route_color"]), gtfsStr(r["route_text_color"])}, nil
			},
		},
		{
			file:  "trips.txt",
			table: "gtfs_trips",
			cols:  []string{"trip_id", "route_id", "service_id", "trip_headsign", "direction_id", "block_id", "shape_id"},
			mapRow: func(r map[string]string) ([]any, error) {
				return []any{r["trip_id"], r["route_id"], r["service_id"], gtfsStr(r["trip_headsign"]), gtfsInt(r["direction_id"]), gtfsStr(r["block_id"]), gtfsStr(r["shape_id"])}, nil
			},
			indexes: []string{
				"CREATE INDEX IF NOT EXISTS idx_gtfs_trips_trip_id ON gtfs_trips (trip_id)",
				"CREATE INDEX IF NOT EXISTS idx_gtfs_trips_route_id ON gtfs_trips (route_id)",
				"CREATE INDEX IF NOT EXISTS idx_gtfs_trips_service_id ON gtfs_trips (service_id)",
			},
		},
		{
			file:  "stops.txt",
			table: "gtfs_stops",
			cols:  []string{"stop_id", "stop_code", "stop_name", "stop_desc", "stop_lat", "stop_lon", "zone_id", "stop_url", "location_type"},
			mapRow: func(r map[string]string) ([]any, error) {
				return []any{r["stop_id"], gtfsStr(r["stop_code"]), r["stop_name"], gtfsStr(r["stop_desc"]), gtfsFloat(r["stop_lat"]), gtfsFloat(r["stop_lon"]), gtfsStr(r["zone_id"]), gtfsStr(r["stop_url"]), gtfsInt(r["location_type"])}, nil
			},
			indexes: []string{"CREATE INDEX IF NOT EXISTS idx_gtfs_stops_stop_id ON gtfs_stops (stop_id)"},
		},
		{
			file:  "stop_times.txt",
			table: "gtfs_stop_times",
			cols:  []string{"trip_id", "arrival_time", "departure_time", "arrival_secs", "departure_secs", "stop_id", "stop_sequence", "pickup_type", "drop_off_type", "shape_dist_traveled", "timepoint"},
			mapRow: func(r map[string]string) ([]any, error) {
				return []any{r["trip_id"], gtfsStr(r["arrival_time"]), gtfsStr(r["departure_time"]), gtfsTimeSecs(r["arrival_time"]), gtfsTimeSecs(r["departure_time"]), r["stop_id"], gtfsInt(r["stop_sequence"]), gtfsInt(r["pickup_type"]), gtfsInt(r["drop_off_type"]), gtfsFloat(r["shape_dist_traveled"]), gtfsInt(r["timepoint"])}, nil
			},
			indexes: []string{
				"CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_trip ON gtfs_stop_times (trip_id, stop_sequence)",
				"CREATE INDEX IF NOT EXISTS idx_gtfs_stop_times_stop ON gtfs_stop_times (stop_id)",
			},
		},
		{
			file:  "calendar.txt",
			table: "gtfs_calendar",
			cols:  []string{"service_id", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "start_date", "end_date"},
			mapRow: func(r map[string]string) ([]any, error) {
				return []any{r["service_id"], gtfsBool(r["monday"]), gtfsBool(r["tuesday"]), gtfsBool(r["wednesday"]), gtfsBool(r["thursday"]), gtfsBool(r["friday"]), gtfsBool(r["saturday"]), gtfsBool(r["sunday"]), gtfsDate(r["start_date"]), gtfsDate(r["end_date"])}, nil
			},
		},
		{
			file:  "calendar_dates.txt",
			table: "gtfs_calendar_dates",
			cols:  []string{"service_id", "date", "exception_type"},
			mapRow: func(r map[string]string) ([]any, error) {
				return []any{r["service_id"], gtfsDate(r["date"]), gtfsInt(r["exception_type"])}, nil
			},
			indexes: []string{"CREATE INDEX IF NOT EXISTS idx_gtfs_caldates_service ON gtfs_calendar_dates (service_id)"},
		},
		{
			file:  "shapes.txt",
			table: "gtfs_shapes",
			cols:  []string{"shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence", "shape_dist_traveled"},
			mapRow: func(r map[string]string) ([]any, error) {
				return []any{r["shape_id"], gtfsFloat(r["shape_pt_lat"]), gtfsFloat(r["shape_pt_lon"]), gtfsInt(r["shape_pt_sequence"]), gtfsFloat(r["shape_dist_traveled"])}, nil
			},
			indexes: []string{"CREATE INDEX IF NOT EXISTS idx_gtfs_shapes_id ON gtfs_shapes (shape_id, shape_pt_sequence)"},
		},
	}

	for _, s := range specs {
		zf, ok := files[s.file]
		if !ok {
			fmt.Printf("  %s not present in feed — skipping.\n", s.file)
			continue
		}
		if _, err := conn.Exec(ctx, "TRUNCATE "+s.table); err != nil {
			return fmt.Errorf("truncate %s: %w", s.table, err)
		}
		n, err := copyGTFSFile(ctx, conn.Conn(), zf, s.table, s.cols, s.mapRow)
		if err != nil {
			return fmt.Errorf("load %s: %w", s.file, err)
		}
		for _, idx := range s.indexes {
			if _, err := conn.Exec(ctx, idx); err != nil {
				return fmt.Errorf("index %s: %w", s.table, err)
			}
		}
		fmt.Printf("  %-22s %d rows\n", s.table, n)
	}

	if hasPostGIS {
		fmt.Println("  Building PostGIS geometry (stops + shape lines)...")
		if _, err := conn.Exec(ctx, `
UPDATE gtfs_stops
SET geom = ST_SetSRID(ST_MakePoint(stop_lon, stop_lat), 4326)
WHERE stop_lon IS NOT NULL AND stop_lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gtfs_stops_geom ON gtfs_stops USING GIST (geom);`); err != nil {
			return fmt.Errorf("stops geom: %w", err)
		}
		if _, err := conn.Exec(ctx, `
TRUNCATE gtfs_shape_lines;
INSERT INTO gtfs_shape_lines (shape_id, geom)
SELECT shape_id,
       ST_MakeLine(ST_SetSRID(ST_MakePoint(shape_pt_lon, shape_pt_lat), 4326) ORDER BY shape_pt_sequence)
FROM gtfs_shapes
WHERE shape_pt_lon IS NOT NULL AND shape_pt_lat IS NOT NULL
GROUP BY shape_id;
CREATE INDEX IF NOT EXISTS idx_gtfs_shape_lines_geom ON gtfs_shape_lines USING GIST (geom);`); err != nil {
			return fmt.Errorf("shape lines geom: %w", err)
		}
	}

	fmt.Println("Static GTFS load complete.")
	return nil
}

// copyGTFSFile streams one CSV member of the zip into a table via COPY, mapping each
// record (by header name) through mapRow. Streaming keeps the 178 MB stop_times.txt
// off the heap.
func copyGTFSFile(ctx context.Context, conn *pgx.Conn, zf *zip.File, table string, cols []string, mapRow func(map[string]string) ([]any, error)) (int64, error) {
	rc, err := zf.Open()
	if err != nil {
		return 0, err
	}
	defer rc.Close()

	cr := csv.NewReader(rc)
	cr.TrimLeadingSpace = true
	cr.ReuseRecord = true
	cr.FieldsPerRecord = -1 // tolerate ragged rows

	header, err := cr.Read()
	if err != nil {
		return 0, fmt.Errorf("read header: %w", err)
	}
	idx := make(map[string]int, len(header))
	for i, h := range header {
		idx[strings.TrimSpace(strings.TrimPrefix(h, "\ufeff"))] = i
	}

	src := &csvCopySource{cr: cr, idx: idx, mapRow: mapRow}
	n, err := conn.CopyFrom(ctx, pgx.Identifier{table}, cols, src)
	if err != nil {
		return n, err
	}
	return n, src.err
}

// csvCopySource adapts a streaming csv.Reader to pgx.CopyFromSource.
type csvCopySource struct {
	cr     *csv.Reader
	idx    map[string]int
	mapRow func(map[string]string) ([]any, error)
	row    map[string]string
	vals   []any
	err    error
}

func (s *csvCopySource) Next() bool {
	rec, err := s.cr.Read()
	if err == io.EOF {
		return false
	}
	if err != nil {
		s.err = err
		return false
	}
	if s.row == nil {
		s.row = make(map[string]string, len(s.idx))
	}
	for name, i := range s.idx {
		if i < len(rec) {
			s.row[name] = rec[i]
		} else {
			s.row[name] = ""
		}
	}
	vals, err := s.mapRow(s.row)
	if err != nil {
		s.err = err
		return false
	}
	s.vals = vals
	return true
}

func (s *csvCopySource) Values() ([]any, error) { return s.vals, nil }
func (s *csvCopySource) Err() error             { return s.err }

// downloadToTemp streams a URL to a temp file and returns its path.
func downloadToTemp(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d fetching %s", resp.StatusCode, url)
	}

	f, err := os.CreateTemp("", "ct_gtfs_*.zip")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), f.Close()
}

// --- field parsers (empty string => SQL NULL) ---

func gtfsStr(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func gtfsInt(s string) any {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	i, err := strconv.Atoi(s)
	if err != nil {
		return nil
	}
	return i
}

func gtfsFloat(s string) any {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return f
}

func gtfsBool(s string) any {
	switch strings.TrimSpace(s) {
	case "1":
		return true
	case "0":
		return false
	default:
		return nil
	}
}

// gtfsDate parses GTFS YYYYMMDD into a date.
func gtfsDate(s string) any {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	t, err := time.Parse("20060102", s)
	if err != nil {
		return nil
	}
	return t
}

// gtfsTimeSecs converts a GTFS HH:MM:SS (HH may be >= 24) to seconds since midnight.
func gtfsTimeSecs(s string) any {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ":")
	if len(parts) != 3 {
		return nil
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	sec, err3 := strconv.Atoi(parts[2])
	if err1 != nil || err2 != nil || err3 != nil {
		return nil
	}
	return h*3600 + m*60 + sec
}
