package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

var (
	db          *pgxpool.Pool
	columnCache sync.Map // map[string][]string — table → column list
)

// allowedTables is a whitelist — no other table can be queried.
var allowedTables = map[string]struct{}{
	"calgary_transit_stops":  {},
	"calgary_transit_routes": {},
	"calgary_train_stations": {},
	"trip_updates":           {},
	"stop_time_updates":      {},
	"vehicle_positions":      {},
	"alerts":                 {},
	"trip_stop_delays":       {},
	"stop_analytics":         {},
}

// realtimeTables are dropped and recreated on every GTFS-RT processor startup;
// their column lists must not be cached so new columns are always discoverable.
var realtimeTables = map[string]struct{}{
	"trip_updates":      {},
	"stop_time_updates": {},
	"vehicle_positions": {},
	"alerts":            {},
	"trip_stop_delays":  {},
}

// ── SSE for vehicle_positions ─────────────────────────────────────────────────

type vehicleHub struct {
	mu         sync.RWMutex
	snapshot   []map[string]any
	prevHashes map[string]string // vehicle_id → json(row) used for change detection
	subs       map[chan []byte]struct{}
}

type vehicleDiff struct {
	Added   []map[string]any `json:"added"`
	Updated []map[string]any `json:"updated"`
	Removed []string         `json:"removed"`
}

var vHub = &vehicleHub{
	prevHashes: make(map[string]string),
	subs:       make(map[chan []byte]struct{}),
}

func startVehiclePoller(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := refreshVehicleCache(ctx); err != nil {
				log.Printf("vehicle poller: %v", err)
			}
		}
	}
}

func refreshVehicleCache(ctx context.Context) error {
	rows, err := db.Query(ctx, "SELECT * FROM vehicle_positions")
	if err != nil {
		return err
	}
	defer rows.Close()

	fds := rows.FieldDescriptions()
	colNames := make([]string, len(fds))
	for i, fd := range fds {
		colNames[i] = string(fd.Name)
	}

	newRows := make([]map[string]any, 0)
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return err
		}
		row := make(map[string]any, len(colNames))
		for i, name := range colNames {
			row[name] = vals[i]
		}
		newRows = append(newRows, row)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	vHub.mu.RLock()
	prevHashes := vHub.prevHashes
	vHub.mu.RUnlock()

	diff, newHashes := computeVehicleDiff(prevHashes, newRows)

	vHub.mu.Lock()
	vHub.snapshot = newRows
	vHub.prevHashes = newHashes
	subs := make([]chan []byte, 0, len(vHub.subs))
	for ch := range vHub.subs {
		subs = append(subs, ch)
	}
	vHub.mu.Unlock()

	if len(subs) == 0 {
		return nil
	}

	// nil msg = heartbeat (no changes); non-nil = diff payload
	var msg []byte
	if len(diff.Added)+len(diff.Updated)+len(diff.Removed) > 0 {
		msg, err = json.Marshal(diff)
		if err != nil {
			return err
		}
	}

	for _, ch := range subs {
		select {
		case ch <- msg:
		default: // slow subscriber; skip this tick
		}
	}
	return nil
}

// computeVehicleDiff compares prev hashes against the new row set and returns
// a diff plus the updated hash map.
func computeVehicleDiff(prev map[string]string, newRows []map[string]any) (vehicleDiff, map[string]string) {
	diff := vehicleDiff{
		Added:   []map[string]any{},
		Updated: []map[string]any{},
		Removed: []string{},
	}
	newHashes := make(map[string]string, len(newRows))

	for _, row := range newRows {
		vid := fmt.Sprintf("%v", row["vehicle_id"])
		b, _ := json.Marshal(row) // map keys are sorted by json.Marshal
		h := string(b)
		newHashes[vid] = h

		if oldH, exists := prev[vid]; !exists {
			diff.Added = append(diff.Added, row)
		} else if oldH != h {
			diff.Updated = append(diff.Updated, row)
		}
	}

	for vid := range prev {
		if _, exists := newHashes[vid]; !exists {
			diff.Removed = append(diff.Removed, vid)
		}
	}

	return diff, newHashes
}

func handleVehicleSSE(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := make(chan []byte, 8)

	vHub.mu.Lock()
	vHub.subs[ch] = struct{}{}
	snapshot := vHub.snapshot
	vHub.mu.Unlock()

	defer func() {
		vHub.mu.Lock()
		delete(vHub.subs, ch)
		vHub.mu.Unlock()
	}()

	// Send current snapshot immediately on connect.
	if b, err := json.Marshal(map[string]any{"count": len(snapshot), "data": snapshot}); err == nil {
		fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", b)
		flusher.Flush()
	}

	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			if msg == nil {
				fmt.Fprintf(w, ": ping\n\n")
			} else {
				fmt.Fprintf(w, "event: update\ndata: %s\n\n", msg)
			}
			flusher.Flush()
		}
	}
}

// ── Route stop SSE ───────────────────────────────────────────────────────────

type routeStop struct {
	RouteID        string  `json:"route_id"`
	TripID         string  `json:"trip_id"`
	StopID         string  `json:"stop_id"`
	Latitude       float64 `json:"stop_lat"`
	Longitude      float64 `json:"stop_lng"`
	ArrivalTime    *int64  `json:"arrival_time"`
	DepartureTime  *int64  `json:"departure_time"`
	ArrivalDelay   *int64  `json:"arrival_delay"`
	DepartureDelay *int64  `json:"departure_delay"`
}

type routeStopDiff struct {
	TripID  string      `json:"trip_id"`
	RouteID string      `json:"route_id"`
	Added   []routeStop `json:"added"`
	Updated []routeStop `json:"updated"`
	Removed []string    `json:"removed"`
}

// parseWKTPoint parses "POINT(longitude latitude)" into lat/lon.
func parseWKTPoint(wkt string) (lat, lon float64, ok bool) {
	s := strings.TrimSuffix(strings.TrimPrefix(wkt, "POINT("), ")")
	parts := strings.Fields(s)
	if len(parts) != 2 {
		return
	}
	var err1, err2 error
	lon, err1 = strconv.ParseFloat(parts[0], 64)
	lat, err2 = strconv.ParseFloat(parts[1], 64)
	if err1 != nil || err2 != nil {
		return
	}
	return lat, lon, true
}

// findNearestTrip returns the trip_id for route whose stops are nearest to queryTime.
func findNearestTrip(ctx context.Context, routeID string, queryTime int64) (string, error) {
	row := db.QueryRow(ctx, `
		SELECT tu.trip_id
		FROM trip_updates tu
		JOIN (
			SELECT trip_id, MIN(ABS(arrival_time - $2)) AS min_diff
			FROM stop_time_updates
			WHERE arrival_time IS NOT NULL AND arrival_time > 0
			GROUP BY trip_id
		) closest ON closest.trip_id = tu.trip_id
		WHERE tu.route_id = $1
		ORDER BY closest.min_diff ASC
		LIMIT 1`,
		routeID, queryTime,
	)
	var tripID string
	if err := row.Scan(&tripID); err != nil {
		return "", err
	}
	return tripID, nil
}

// fetchRouteStops returns all stops for tripID joined with static stop coordinates.
func fetchRouteStops(ctx context.Context, tripID string) ([]routeStop, error) {
	rows, err := db.Query(ctx, `
		SELECT
			tu.route_id,
			stu.trip_id,
			stu.stop_id,
			stu.arrival_time,
			stu.departure_time,
			stu.arrival_delay,
			stu.departure_delay,
			cts.point
		FROM stop_time_updates stu
		JOIN trip_updates tu ON tu.trip_id = stu.trip_id
		LEFT JOIN calgary_transit_stops cts ON cts.teleride_number::text = stu.stop_id
		WHERE stu.trip_id = $1
		ORDER BY stu.stop_sequence`,
		tripID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stops []routeStop
	for rows.Next() {
		var s routeStop
		var pointWKT *string
		if err := rows.Scan(&s.RouteID, &s.TripID, &s.StopID,
			&s.ArrivalTime, &s.DepartureTime, &s.ArrivalDelay, &s.DepartureDelay, &pointWKT); err != nil {
			return nil, err
		}
		if pointWKT != nil {
			if lat, lon, ok := parseWKTPoint(*pointWKT); ok {
				s.Latitude, s.Longitude = lat, lon
			}
		}
		stops = append(stops, s)
	}
	return stops, rows.Err()
}

// computeRouteStopDiff compares two stop slices keyed by stop_id and returns a diff.
func computeRouteStopDiff(prev, next []routeStop) routeStopDiff {
	diff := routeStopDiff{
		Added:   []routeStop{},
		Updated: []routeStop{},
		Removed: []string{},
	}
	if len(next) == 0 {
		return diff
	}
	diff.TripID = next[0].TripID
	diff.RouteID = next[0].RouteID

	prevMap := make(map[string]routeStop, len(prev))
	for _, s := range prev {
		prevMap[s.StopID] = s
	}
	nextMap := make(map[string]struct{}, len(next))
	for _, s := range next {
		nextMap[s.StopID] = struct{}{}
		old, exists := prevMap[s.StopID]
		if !exists {
			diff.Added = append(diff.Added, s)
		} else {
			changed := !ptrInt64Eq(old.ArrivalTime, s.ArrivalTime) ||
				!ptrInt64Eq(old.DepartureTime, s.DepartureTime) ||
				!ptrInt64Eq(old.ArrivalDelay, s.ArrivalDelay) ||
				!ptrInt64Eq(old.DepartureDelay, s.DepartureDelay)
			if changed {
				diff.Updated = append(diff.Updated, s)
			}
		}
	}
	for _, s := range prev {
		if _, ok := nextMap[s.StopID]; !ok {
			diff.Removed = append(diff.Removed, s.StopID)
		}
	}
	return diff
}

func ptrInt64Eq(a, b *int64) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func handleRouteSSE(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	q := r.URL.Query()
	routeID := q.Get("route_id")
	timeStr := q.Get("time")
	if routeID == "" || timeStr == "" {
		jsonError(w, "route_id and time are required", http.StatusBadRequest)
		return
	}
	queryTime, err := strconv.ParseInt(timeStr, 10, 64)
	if err != nil {
		jsonError(w, "time must be a unix timestamp integer", http.StatusBadRequest)
		return
	}

	tripID, err := findNearestTrip(r.Context(), routeID, queryTime)
	if err != nil {
		jsonError(w, "no active trip found for that route and time", http.StatusNotFound)
		return
	}

	stops, err := fetchRouteStops(r.Context(), tripID)
	if err != nil {
		log.Printf("fetchRouteStops: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	if b, err := json.Marshal(map[string]any{
		"trip_id":  tripID,
		"route_id": routeID,
		"count":    len(stops),
		"data":     stops,
	}); err == nil {
		fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", b)
		flusher.Flush()
	}

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	prev := stops

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			next, err := fetchRouteStops(r.Context(), tripID)
			if err != nil {
				log.Printf("fetchRouteStops poll: %v", err)
				fmt.Fprintf(w, ": ping\n\n")
				flusher.Flush()
				continue
			}
			diff := computeRouteStopDiff(prev, next)
			if len(diff.Added)+len(diff.Updated)+len(diff.Removed) == 0 {
				fmt.Fprintf(w, ": ping\n\n")
			} else {
				b, _ := json.Marshal(diff)
				fmt.Fprintf(w, "event: update\ndata: %s\n\n", b)
			}
			flusher.Flush()
			prev = next
		}
	}
}

// ── Trip resolution (for route-save) ──────────────────────────────────────────

// resolvedStop is one stop on the resolved trip's entry→exit window, with its
// static coordinates and the trip's predicted times.
type resolvedStop struct {
	StopID        string  `json:"stop_id"`
	StopName      string  `json:"stop_name"`
	StopLat       float64 `json:"stop_lat"`
	StopLng       float64 `json:"stop_lng"`
	StopSequence  int64   `json:"stop_sequence"`
	ArrivalTime   *int64  `json:"arrival_time"`
	DepartureTime *int64  `json:"departure_time"`
}

// resolveTrip picks the one trip on routeID that serves entryStopID before
// exitStopID (correct direction) whose entry boarding time is at or after floor
// (now-grace, i.e. not yet departed) and nearest to target (Google's ETA), then
// returns that trip's entry→exit windowed stops. Doing this in SQL against the live
// table means stale cross-day rows for a reused trip_id are dropped by the floor and
// the nearest-time pick — the consumer gets the current run, not a departed one.
// Returns pgx.ErrNoRows when nothing resolves.
func resolveTrip(ctx context.Context, routeID, entryStopID, exitStopID string, target, floor int64) (tripID string, eseq, xseq int64, stops []resolvedStop, err error) {
	row := db.QueryRow(ctx, `
		SELECT e.trip_id, e.eseq, MIN(x.xseq) AS xseq
		FROM (
			SELECT stu.trip_id, stu.stop_sequence AS eseq,
			       COALESCE(stu.departure_time, stu.arrival_time) AS etime
			FROM stop_time_updates stu
			JOIN trip_updates tu ON tu.trip_id = stu.trip_id
			WHERE tu.route_id = $1 AND stu.stop_id = $2
			  AND COALESCE(stu.departure_time, stu.arrival_time) >= $3
		) e
		JOIN (
			SELECT trip_id, stop_sequence AS xseq
			FROM stop_time_updates
			WHERE stop_id = $4
		) x ON x.trip_id = e.trip_id AND x.xseq > e.eseq
		GROUP BY e.trip_id, e.eseq, e.etime
		ORDER BY ABS(e.etime - $5)
		LIMIT 1`,
		routeID, entryStopID, floor, exitStopID, target,
	)
	if err = row.Scan(&tripID, &eseq, &xseq); err != nil {
		return "", 0, 0, nil, err
	}

	rows, err := db.Query(ctx, `
		SELECT stu.stop_id, stu.stop_sequence, stu.arrival_time, stu.departure_time,
		       cts.stop_name, cts.point
		FROM stop_time_updates stu
		LEFT JOIN calgary_transit_stops cts ON cts.teleride_number::text = stu.stop_id
		WHERE stu.trip_id = $1 AND stu.stop_sequence BETWEEN $2 AND $3
		ORDER BY stu.stop_sequence`,
		tripID, eseq, xseq,
	)
	if err != nil {
		return "", 0, 0, nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var s resolvedStop
		var name, pointWKT *string
		if err = rows.Scan(&s.StopID, &s.StopSequence, &s.ArrivalTime, &s.DepartureTime, &name, &pointWKT); err != nil {
			return "", 0, 0, nil, err
		}
		if name != nil {
			s.StopName = *name
		}
		if pointWKT != nil {
			if lat, lon, ok := parseWKTPoint(*pointWKT); ok {
				s.StopLat, s.StopLng = lat, lon
			}
		}
		stops = append(stops, s)
	}
	if err = rows.Err(); err != nil {
		return "", 0, 0, nil, err
	}
	return tripID, eseq, xseq, stops, nil
}

// handleResolveTrip is GET /api/v1/resolve_trip: route_id, entry_stop_id,
// exit_stop_id and time (target epoch) are required; now (default server clock) and
// grace (default 120s) bound the future-only floor. It returns the resolved trip and
// its entry→exit windowed stops, or 404 when no current in-order trip serves them.
func handleResolveTrip(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	routeID := q.Get("route_id")
	entryID := q.Get("entry_stop_id")
	exitID := q.Get("exit_stop_id")
	if routeID == "" || entryID == "" || exitID == "" {
		jsonError(w, "route_id, entry_stop_id and exit_stop_id are required", http.StatusBadRequest)
		return
	}
	target, err := strconv.ParseInt(q.Get("time"), 10, 64)
	if err != nil {
		jsonError(w, "time must be a unix timestamp integer", http.StatusBadRequest)
		return
	}
	now := time.Now().Unix()
	if v := q.Get("now"); v != "" {
		if n, err2 := strconv.ParseInt(v, 10, 64); err2 == nil {
			now = n
		}
	}
	grace := int64(120)
	if v := q.Get("grace"); v != "" {
		if n, err2 := strconv.ParseInt(v, 10, 64); err2 == nil && n >= 0 {
			grace = n
		}
	}

	tripID, eseq, xseq, stops, err := resolveTrip(r.Context(), routeID, entryID, exitID, target, now-grace)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			jsonError(w, "no current in-order trip found for that route and stops", http.StatusNotFound)
			return
		}
		log.Printf("resolveTrip: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	if len(stops) == 0 {
		jsonError(w, "no current in-order trip found for that route and stops", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"route_id":  routeID,
		"trip_id":   tripID,
		"entry_seq": eseq,
		"exit_seq":  xseq,
		"count":     len(stops),
		"data":      stops,
	})
}

// ── Query filter helpers ──────────────────────────────────────────────────────

// postgrestOps maps PostgREST operator names to their SQL equivalents.
var postgrestOps = map[string]string{
	"eq":    "=",
	"neq":   "!=",
	"gt":    ">",
	"gte":   ">=",
	"lt":    "<",
	"lte":   "<=",
	"like":  "LIKE",
	"ilike": "ILIKE",
}

type parsedFilter struct {
	sqlOp  string
	values []string
	isIN   bool
}

// parseFilterValue handles PostgREST value prefixes:
//   - "in.(1,2,3)"   → IN with multiple bind params
//   - "gte.val"      → >= with one bind param
//   - "val"          → = with one bind param (plain exact-match)
func parseFilterValue(raw string) parsedFilter {
	if strings.HasPrefix(raw, "in.(") && strings.HasSuffix(raw, ")") {
		inner := raw[len("in.(") : len(raw)-1]
		vals := strings.Split(inner, ",")
		return parsedFilter{sqlOp: "IN", values: vals, isIN: true}
	}
	if dot := strings.Index(raw, "."); dot > 0 {
		if sqlOp, ok := postgrestOps[raw[:dot]]; ok {
			return parsedFilter{sqlOp: sqlOp, values: []string{raw[dot+1:]}}
		}
	}
	return parsedFilter{sqlOp: "=", values: []string{raw}}
}

type orTerm struct {
	col   string
	sqlOp string
	val   string
}

// parseORTerms parses ?or=(col.op.val,col.op.val,...).
// Unknown columns and operators are silently skipped.
func parseORTerms(orParam string, colSet map[string]struct{}) []orTerm {
	s := strings.TrimSpace(orParam)
	if !strings.HasPrefix(s, "(") || !strings.HasSuffix(s, ")") {
		return nil
	}
	s = s[1 : len(s)-1]

	var terms []orTerm
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		// SplitN(..., 3) keeps dots inside the value intact.
		seg := strings.SplitN(part, ".", 3)
		if len(seg) != 3 {
			continue
		}
		col, op, val := seg[0], seg[1], seg[2]
		if _, ok := colSet[col]; !ok {
			continue
		}
		sqlOp, ok := postgrestOps[op]
		if !ok {
			continue
		}
		terms = append(terms, orTerm{col: col, sqlOp: sqlOp, val: val})
	}
	return terms
}

// ── REST handlers ─────────────────────────────────────────────────────────────

func main() {
	_ = godotenv.Load()

	dsn := os.Getenv("SUPABASE_DIRECT_CONNECTION_STRING")
	if dsn == "" {
		log.Fatal("SUPABASE_DIRECT_CONNECTION_STRING is not set")
	}

	var err error
	db, err = pgxpool.New(context.Background(), dsn)
	if err != nil {
		log.Fatalf("pgxpool.New: %v", err)
	}
	defer db.Close()

	if err := db.Ping(context.Background()); err != nil {
		log.Fatalf("database ping failed: %v", err)
	}
	log.Println("connected to database")

	// Warm the vehicle cache before accepting connections.
	if err := refreshVehicleCache(context.Background()); err != nil {
		log.Fatalf("initial vehicle cache load: %v", err)
	}
	go startVehiclePoller(context.Background())

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	// Exact matches take precedence over the /api/v1/ prefix catch-all.
	mux.HandleFunc("/api/v1/vehicle_positions", withCORS(handleVehicleSSE))
	mux.HandleFunc("/api/v1/stream/route", withCORS(handleRouteSSE))
	mux.HandleFunc("/api/v1/resolve_trip", withCORS(handleResolveTrip))
	mux.HandleFunc("/api/v1/", withCORS(handleQuery))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

// withCORS wraps a handler with permissive CORS headers.
func withCORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	err := db.Ping(r.Context())
	if err != nil {
		jsonError(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// handleQuery is the single handler for all /api/v1/{table} requests.
func handleQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// /api/v1/          → list available tables
	// /api/v1/{table}   → query that table
	segment := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/"), "/")
	if segment == "" {
		listTables(w)
		return
	}

	table := segment
	if _, ok := allowedTables[table]; !ok {
		jsonError(w, fmt.Sprintf("unknown table %q", table), http.StatusNotFound)
		return
	}

	cols, err := tableColumns(r.Context(), table)
	if err != nil {
		log.Printf("tableColumns(%s): %v", table, err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	colSet := make(map[string]struct{}, len(cols))
	for _, c := range cols {
		colSet[c] = struct{}{}
	}

	q := r.URL.Query()

	limit, offset := 100, 0
	if v := q.Get("limit"); v != "" {
		if n, err2 := strconv.Atoi(v); err2 == nil && n > 0 && n <= 10_000 {
			limit = n
		}
	}
	if v := q.Get("offset"); v != "" {
		if n, err2 := strconv.Atoi(v); err2 == nil && n >= 0 {
			offset = n
		}
	}

	var orderClause string
	if ob := q.Get("order_by"); ob != "" {
		if _, ok := colSet[ob]; ok {
			dir := "ASC"
			if strings.ToUpper(q.Get("order")) == "DESC" {
				dir = "DESC"
			}
			orderClause = fmt.Sprintf(" ORDER BY %s %s", ob, dir)
		}
	}

	// Build parameterised WHERE from remaining query params that match column names.
	// Supports PostgREST-style operators: ?col=gte.val, ?col=in.(1,2,3), ?or=(col.op.val,...)
	var conds []string
	var args []any
	idx := 1

	for key, vals := range q {
		switch key {
		case "limit", "offset", "order_by", "order", "or", "active", "grace":
			continue
		}
		if _, ok := colSet[key]; !ok {
			continue
		}
		pf := parseFilterValue(vals[0])
		if pf.isIN {
			if len(pf.values) == 0 {
				continue
			}
			placeholders := make([]string, len(pf.values))
			for i, v := range pf.values {
				placeholders[i] = fmt.Sprintf("$%d", idx)
				args = append(args, strings.TrimSpace(v))
				idx++
			}
			conds = append(conds, fmt.Sprintf("%s IN (%s)", key, strings.Join(placeholders, ", ")))
		} else {
			conds = append(conds, fmt.Sprintf("%s %s $%d", key, pf.sqlOp, idx))
			args = append(args, pf.values[0])
			idx++
		}
	}

	if orVal := q.Get("or"); orVal != "" {
		if terms := parseORTerms(orVal, colSet); len(terms) > 0 {
			orParts := make([]string, len(terms))
			for i, t := range terms {
				orParts[i] = fmt.Sprintf("%s %s $%d", t.col, t.sqlOp, idx)
				args = append(args, t.val)
				idx++
			}
			conds = append(conds, "("+strings.Join(orParts, " OR ")+")")
		}
	}

	// active=1 (stop_time_updates only): a server-now future-only filter, so callers
	// need not trust their own clock (relevant when the device clock is skewed). Drops
	// rows whose boarding time (departure, fallback arrival) is older than now-grace.
	if table == "stop_time_updates" && q.Get("active") == "1" {
		grace := 120
		if v := q.Get("grace"); v != "" {
			if n, err2 := strconv.Atoi(v); err2 == nil && n >= 0 {
				grace = n
			}
		}
		conds = append(conds, fmt.Sprintf("COALESCE(departure_time, arrival_time) >= EXTRACT(EPOCH FROM now())::bigint - $%d", idx))
		args = append(args, grace)
		idx++
	}

	query := "SELECT * FROM " + table
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	query += orderClause
	query += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)

	rows, err := db.Query(r.Context(), query, args...)
	if err != nil {
		log.Printf("query error: %v", err)
		jsonError(w, "query failed", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	fds := rows.FieldDescriptions()
	colNames := make([]string, len(fds))
	for i, fd := range fds {
		colNames[i] = string(fd.Name)
	}

	result := make([]map[string]any, 0)
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			log.Printf("row.Values: %v", err)
			continue
		}
		row := make(map[string]any, len(colNames))
		for i, name := range colNames {
			row[name] = vals[i]
		}
		result = append(result, row)
	}
	if rows.Err() != nil {
		log.Printf("rows.Err: %v", rows.Err())
		jsonError(w, "query failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"table":  table,
		"count":  len(result),
		"limit":  limit,
		"offset": offset,
		"data":   result,
	})
}

func listTables(w http.ResponseWriter) {
	tables := make([]string, 0, len(allowedTables))
	for t := range allowedTables {
		tables = append(tables, t)
	}
	sort.Strings(tables)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"tables": tables})
}

// tableColumns returns the ordered column names for a table, caching the result.
// Realtime tables (dropped and recreated on every GTFS-RT startup) bypass the
// cache so newly added columns are always discoverable without a middleware restart.
func tableColumns(ctx context.Context, table string) ([]string, error) {
	_, isRealtime := realtimeTables[table]
	if !isRealtime {
		if v, ok := columnCache.Load(table); ok {
			return v.([]string), nil
		}
	}

	rows, err := db.Query(ctx,
		`SELECT column_name
		 FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name = $1
		 ORDER BY ordinal_position`,
		table,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cols []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		cols = append(cols, c)
	}
	if !isRealtime {
		columnCache.Store(table, cols)
	}
	return cols, nil
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
