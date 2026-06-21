package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
	"golang.org/x/sync/singleflight"
)

var (
	db          *pgxpool.Pool
	columnCache sync.Map // map[string][]string — table → column list
)

// ── Response cache ─────────────────────────────────────────────────────────────
// Pinning Cloud Run to a single instance (max-instances 1) makes this in-process
// cache shared across every request, so repeat /api/v1/{table} reads return the
// stored JSON without touching Supabase. TTL is per-table: realtime tables refresh
// often (30s), static reference tables rarely change (1h).

type cacheEntry struct {
	body    []byte
	etag    string
	expires time.Time
}

var (
	respCache      sync.Map // key: r.URL.RequestURI() → *cacheEntry
	respCacheCount int64
	sfGroup        singleflight.Group // collapses concurrent misses for the same key
)

const respCacheCap = 500

// cacheTTL returns how long a table's responses may be served from cache.
func cacheTTL(table string) time.Duration {
	if _, rt := realtimeTables[table]; rt {
		return 30 * time.Second
	}
	return time.Hour
}

// cacheLoad returns a live (unexpired) entry, deleting it if stale.
func cacheLoad(key string) *cacheEntry {
	if v, ok := respCache.Load(key); ok {
		e := v.(*cacheEntry)
		if time.Now().Before(e.expires) {
			return e
		}
		respCache.Delete(key)
		atomic.AddInt64(&respCacheCount, -1)
	}
	return nil
}

// cacheStore saves an entry and sweeps expired entries when over capacity.
func cacheStore(key string, e *cacheEntry) {
	if _, existed := respCache.Load(key); !existed {
		atomic.AddInt64(&respCacheCount, 1)
	}
	respCache.Store(key, e)
	if atomic.LoadInt64(&respCacheCount) > respCacheCap {
		sweepCache()
	}
}

// sweepCache drops expired entries and resets the authoritative count.
func sweepCache() {
	now := time.Now()
	var n int64
	respCache.Range(func(k, v any) bool {
		if now.After(v.(*cacheEntry).expires) {
			respCache.Delete(k)
		} else {
			n++
		}
		return true
	})
	atomic.StoreInt64(&respCacheCount, n)
}

// etagOf returns a quoted FNV-64a hash of the body for ETag/If-None-Match.
func etagOf(b []byte) string {
	h := fnv.New64a()
	_, _ = h.Write(b)
	return fmt.Sprintf("%q", strconv.FormatUint(h.Sum64(), 16))
}

// serveEntry writes a cached entry, honoring If-None-Match with a 304. max-age
// reflects the entry's remaining freshness so a downstream cache can't extend
// staleness past this entry's own expiry.
func serveEntry(w http.ResponseWriter, r *http.Request, e *cacheEntry) {
	maxAge := int(time.Until(e.expires).Seconds())
	if maxAge < 0 {
		maxAge = 0
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("ETag", e.etag)
	h.Set("Cache-Control", fmt.Sprintf("public, max-age=%d", maxAge))
	if match := r.Header.Get("If-None-Match"); match != "" && match == e.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = w.Write(e.body)
}

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
	mu          sync.RWMutex
	snapshot    []map[string]any
	prevHashes  map[string]string // vehicle_id → json(row) used for change detection
	subs        map[chan []byte]struct{}
	lastRefresh time.Time
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
			// Skip the full-table read when nobody is listening — avoids a
			// constant 24/7 Supabase read with zero subscribers.
			vHub.mu.RLock()
			n := len(vHub.subs)
			vHub.mu.RUnlock()
			if n == 0 {
				continue
			}
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
	vHub.lastRefresh = time.Now()
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
	stale := time.Since(vHub.lastRefresh) > 30*time.Second
	vHub.mu.Unlock()

	// If polling has been idle, refresh once so this subscriber gets fresh data.
	if stale {
		if err := refreshVehicleCache(r.Context()); err != nil {
			log.Printf("vehicle warm-on-connect: %v", err)
		}
	}

	vHub.mu.RLock()
	snapshot := vHub.snapshot
	vHub.mu.RUnlock()

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

// routeTopic shares one 30s poller among all SSE subscribers watching the same
// resolved trip, so N clients on a trip cause one fetchRouteStops per tick, not N.
type routeTopic struct {
	tripID   string
	routeID  string
	mu       sync.RWMutex
	snapshot []routeStop
	subs     map[chan []byte]struct{}
	cancel   context.CancelFunc
}

var (
	routeHubMu  sync.Mutex
	routeTopics = map[string]*routeTopic{} // trip_id → topic
)

// subscribeRoute attaches ch to the topic for tripID, creating and starting the
// shared poller (with an initial fetch) when it's the first subscriber. Returns the
// current snapshot to send on connect.
func subscribeRoute(tripID, routeID string, ch chan []byte) (*routeTopic, []routeStop, error) {
	routeHubMu.Lock()
	defer routeHubMu.Unlock()

	if t, ok := routeTopics[tripID]; ok {
		t.mu.Lock()
		t.subs[ch] = struct{}{}
		snap := t.snapshot
		t.mu.Unlock()
		return t, snap, nil
	}

	stops, err := fetchRouteStops(context.Background(), tripID)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &routeTopic{
		tripID:   tripID,
		routeID:  routeID,
		snapshot: stops,
		subs:     map[chan []byte]struct{}{ch: {}},
		cancel:   cancel,
	}
	routeTopics[tripID] = t
	go t.run(ctx)
	return t, stops, nil
}

// unsubscribeRoute detaches ch; when the last subscriber leaves, the poller is
// stopped and the topic removed.
func unsubscribeRoute(t *routeTopic, ch chan []byte) {
	routeHubMu.Lock()
	t.mu.Lock()
	delete(t.subs, ch)
	if len(t.subs) == 0 {
		delete(routeTopics, t.tripID)
		t.cancel()
	}
	t.mu.Unlock()
	routeHubMu.Unlock()
}

// run polls the trip's stops every 30s and broadcasts diffs (nil = heartbeat).
func (t *routeTopic) run(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	prev := t.snapshot
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			next, err := fetchRouteStops(ctx, t.tripID)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				log.Printf("fetchRouteStops poll: %v", err)
				t.broadcast(nil) // heartbeat
				continue
			}
			diff := computeRouteStopDiff(prev, next)
			t.mu.Lock()
			t.snapshot = next
			t.mu.Unlock()
			var msg []byte
			if len(diff.Added)+len(diff.Updated)+len(diff.Removed) > 0 {
				msg, _ = json.Marshal(diff)
			}
			t.broadcast(msg)
			prev = next
		}
	}
}

// broadcast sends msg (nil = heartbeat) to all subscribers, skipping slow ones.
func (t *routeTopic) broadcast(msg []byte) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	for ch := range t.subs {
		select {
		case ch <- msg:
		default: // slow subscriber; skip this tick
		}
	}
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

	ch := make(chan []byte, 8)
	topic, stops, err := subscribeRoute(tripID, routeID, ch)
	if err != nil {
		log.Printf("subscribeRoute: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	defer unsubscribeRoute(topic, ch)

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

// catalogStop is one row of a trip's *scheduled* stop list, sourced from the static
// GTFS tables (gtfs_stop_times + gtfs_stops). arrival_secs/departure_secs are seconds
// since service-day midnight (may exceed 86400 for after-midnight trips); the caller
// converts them to an epoch against the service day.
type catalogStop struct {
	StopID        string  `json:"stop_id"`
	StopSequence  int64   `json:"stop_sequence"`
	StopName      string  `json:"stop_name"`
	StopLat       float64 `json:"stop_lat"`
	StopLng       float64 `json:"stop_lng"`
	ArrivalSecs   *int64  `json:"arrival_secs"`
	DepartureSecs *int64  `json:"departure_secs"`
}

// handleTripStops is GET /api/v1/trip_stops?trip_id=…: the *scheduled* (static GTFS)
// stop list for one trip, joined to gtfs_stops for coordinates and ordered by
// stop_sequence. It is the fallback source for consumers (e.g. Route Save) when a trip
// has no live rows in stop_time_updates — an OTP-planned trip that is not yet in the
// RT window, or a feed outage. Returns 404 when the trip is unknown to the catalog.
func handleTripStops(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tripID := r.URL.Query().Get("trip_id")
	if tripID == "" {
		jsonError(w, "trip_id is required", http.StatusBadRequest)
		return
	}

	rows, err := db.Query(r.Context(), `
		SELECT st.stop_id, st.stop_sequence, st.arrival_secs, st.departure_secs,
		       s.stop_name, s.stop_lat, s.stop_lon
		FROM gtfs_stop_times st
		LEFT JOIN gtfs_stops s ON s.stop_id = st.stop_id
		WHERE st.trip_id = $1
		ORDER BY st.stop_sequence`,
		tripID,
	)
	if err != nil {
		log.Printf("handleTripStops: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	stops := make([]catalogStop, 0)
	for rows.Next() {
		var s catalogStop
		var name *string
		var lat, lon *float64
		if err = rows.Scan(&s.StopID, &s.StopSequence, &s.ArrivalSecs, &s.DepartureSecs, &name, &lat, &lon); err != nil {
			log.Printf("handleTripStops scan: %v", err)
			jsonError(w, "internal server error", http.StatusInternalServerError)
			return
		}
		if name != nil {
			s.StopName = *name
		}
		if lat != nil {
			s.StopLat = *lat
		}
		if lon != nil {
			s.StopLng = *lon
		}
		stops = append(stops, s)
	}
	if err = rows.Err(); err != nil {
		log.Printf("handleTripStops rows: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	if len(stops) == 0 {
		jsonError(w, "no scheduled stops found for that trip", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"trip_id": tripID,
		"count":   len(stops),
		"data":    stops,
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

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Fatalf("pgxpool.ParseConfig: %v", err)
	}
	// Tuned for a single pinned Cloud Run instance: the response cache absorbs most
	// reads, so a small pool with one warm connection is plenty. Recycle idle conns
	// so Supabase isn't left holding stale sessions.
	cfg.MaxConns = 5
	cfg.MinConns = 1
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.HealthCheckPeriod = time.Minute

	db, err = pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		log.Fatalf("pgxpool.NewWithConfig: %v", err)
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

	// Stand up the second (tailnet) database for user data. Non-fatal: if it's
	// unset/unreachable, only /api/v1/user/ is affected — Supabase routes are not.
	initUserDB(context.Background())

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	// Exact matches take precedence over the /api/v1/ prefix catch-all.
	// SSE endpoints are not gzipped — chunked event streams and gzip buffering don't
	// mix, and their diffs are already small.
	mux.HandleFunc("/api/v1/vehicle_positions", withCORS(handleVehicleSSE))
	mux.HandleFunc("/api/v1/stream/route", withCORS(handleRouteSSE))
	mux.HandleFunc("/api/v1/resolve_trip", withCORS(withGzip(handleResolveTrip)))
	mux.HandleFunc("/api/v1/trip_stops", withCORS(withGzip(handleTripStops)))
	// User-data DB (tailnet) — GET reads + POST upserts. More specific prefix than
	// /api/v1/, so it takes precedence in the mux.
	mux.HandleFunc("/api/v1/user/", withCORSWrite(withGzip(handleUserData)))
	mux.HandleFunc("/api/v1/", withCORS(withGzip(handleQuery)))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

// gzipResponseWriter compresses the body lazily: it only switches on gzip for a 200
// response with a body, so empty 304s and error responses pass through unchanged.
type gzipResponseWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	passthrough bool
	wroteHeader bool
}

func (g *gzipResponseWriter) WriteHeader(code int) {
	g.wroteHeader = true
	if code == http.StatusOK {
		g.Header().Del("Content-Length")
		g.Header().Set("Content-Encoding", "gzip")
		g.gz = gzip.NewWriter(g.ResponseWriter)
	} else {
		g.passthrough = true
	}
	g.ResponseWriter.WriteHeader(code)
}

func (g *gzipResponseWriter) Write(b []byte) (int, error) {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.passthrough {
		return g.ResponseWriter.Write(b)
	}
	return g.gz.Write(b)
}

func (g *gzipResponseWriter) Close() error {
	if g.gz != nil {
		return g.gz.Close()
	}
	return nil
}

// withGzip compresses JSON responses when the client accepts gzip. JSON compresses
// ~80-90%, cutting Cloud Run egress to clients.
func withGzip(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			h(w, r)
			return
		}
		w.Header().Add("Vary", "Accept-Encoding")
		gzw := &gzipResponseWriter{ResponseWriter: w}
		defer gzw.Close()
		h(gzw, r)
	}
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

	// Serve from the in-process cache when fresh — no DB read at all.
	ttl := cacheTTL(table)
	cacheKey := r.URL.RequestURI()
	if e := cacheLoad(cacheKey); e != nil {
		serveEntry(w, r, e)
		return
	}

	// Collapse concurrent misses for the same query into a single Supabase read.
	v, err, _ := sfGroup.Do(cacheKey, func() (any, error) {
		if e := cacheLoad(cacheKey); e != nil {
			return e, nil // another goroutine filled the cache while we waited
		}
		body, err := buildTableResponse(r.Context(), table, r.URL.Query())
		if err != nil {
			return nil, err
		}
		e := &cacheEntry{body: body, etag: etagOf(body), expires: time.Now().Add(ttl)}
		cacheStore(cacheKey, e)
		return e, nil
	})
	if err != nil {
		log.Printf("buildTableResponse(%s): %v", table, err)
		jsonError(w, "query failed", http.StatusInternalServerError)
		return
	}
	serveEntry(w, r, v.(*cacheEntry))
}

// buildTableResponse runs the parameterised query for a whitelisted table and
// returns the marshaled JSON response body.
func buildTableResponse(ctx context.Context, table string, q url.Values) ([]byte, error) {
	cols, err := tableColumns(ctx, table)
	if err != nil {
		return nil, err
	}
	colSet := make(map[string]struct{}, len(cols))
	for _, c := range cols {
		colSet[c] = struct{}{}
	}

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

	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
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
		return nil, rows.Err()
	}

	return json.Marshal(map[string]any{
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
