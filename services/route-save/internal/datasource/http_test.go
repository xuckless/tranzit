package datasource

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"sync"
	"testing"

	"github.com/tranzit-route-save/internal/geo"
)

// mockMiddleware is a stand-in for tranzit-db-middleware's generic table API. It
// serves rows per table, filters by route_id/trip_id/stop_id, pages by
// limit/offset, and counts stop_time_updates queries split by filter kind so a
// test can prove the resolver didn't issue one query per candidate (the N+1).
type mockMiddleware struct {
	tables map[string][]map[string]any

	mu           sync.Mutex
	stuByTrip    int  // stop_time_updates?trip_id=
	stuByStop    int  // stop_time_updates?stop_id=
	tripUpdate   int  // trip_updates?route_id=
	resolveCalls int  // /api/v1/resolve_trip
	failResolve  bool // when set, resolve_trip returns 500 (exercises the fallback)
}

// mi64 coerces a raw mock-table value (stored as int/int64/float64) to int64. The
// generic handler round-trips through JSON (asInt64 sees float64), but the
// resolve_trip mock reads m.tables directly, so it needs this.
func mi64(v any) int64 {
	switch t := v.(type) {
	case int:
		return int64(t)
	case int64:
		return t
	case float64:
		return int64(t)
	case string:
		n, _ := strconv.ParseInt(t, 10, 64)
		return n
	default:
		return 0
	}
}

func (m *mockMiddleware) handler() http.Handler {
	mux := http.NewServeMux()

	// /api/v1/resolve_trip — mirrors the middleware's SQL resolution: the in-order,
	// future-only (>= now-grace), nearest-time trip on the route, windowed entry→exit.
	mux.HandleFunc("/api/v1/resolve_trip", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		m.resolveCalls++
		fail := m.failResolve
		m.mu.Unlock()
		if fail {
			http.Error(w, "forced failure", http.StatusInternalServerError)
			return
		}

		q := r.URL.Query()
		routeID, entryID, exitID := q.Get("route_id"), q.Get("entry_stop_id"), q.Get("exit_stop_id")
		target, _ := strconv.ParseInt(q.Get("time"), 10, 64)
		now, _ := strconv.ParseInt(q.Get("now"), 10, 64)
		const grace = 120
		floor := now - grace

		onRoute := map[string]bool{}
		for _, row := range m.tables["trip_updates"] {
			if fmt.Sprint(row["route_id"]) == routeID {
				onRoute[fmt.Sprint(row["trip_id"])] = true
			}
		}
		exitSeqs := map[string][]int{}
		for _, row := range m.tables["stop_time_updates"] {
			if fmt.Sprint(row["stop_id"]) == exitID {
				tid := fmt.Sprint(row["trip_id"])
				exitSeqs[tid] = append(exitSeqs[tid], int(mi64(row["stop_sequence"])))
			}
		}
		best, bestEseq, bestDiff := "", 0, int64(1)<<62
		for _, row := range m.tables["stop_time_updates"] {
			if fmt.Sprint(row["stop_id"]) != entryID {
				continue
			}
			tid := fmt.Sprint(row["trip_id"])
			if !onRoute[tid] {
				continue
			}
			seq := int(mi64(row["stop_sequence"]))
			t := mi64(row["departure_time"])
			if t == 0 {
				t = mi64(row["arrival_time"])
			}
			if t == 0 || t < floor {
				continue
			}
			after := false
			for _, xs := range exitSeqs[tid] {
				if xs > seq {
					after = true
					break
				}
			}
			if !after {
				continue
			}
			d := t - target
			if d < 0 {
				d = -d
			}
			if d < bestDiff {
				bestDiff, best, bestEseq = d, tid, seq
			}
		}
		if best == "" {
			http.Error(w, "no current in-order trip", http.StatusNotFound)
			return
		}
		xseq := 1 << 30
		for _, xs := range exitSeqs[best] {
			if xs > bestEseq && xs < xseq {
				xseq = xs
			}
		}

		catLoc := map[string]geo.LatLng{}
		catName := map[string]string{}
		for _, row := range m.tables["calgary_transit_stops"] {
			id := fmt.Sprint(row["teleride_number"])
			if loc, ok := parsePointWKT(fmt.Sprint(row["point"])); ok {
				catLoc[id] = loc
			}
			catName[id] = fmt.Sprint(row["stop_name"])
		}
		var data []map[string]any
		for _, row := range m.tables["stop_time_updates"] {
			if fmt.Sprint(row["trip_id"]) != best {
				continue
			}
			seq := int(mi64(row["stop_sequence"]))
			if seq < bestEseq || seq > xseq {
				continue
			}
			sid := fmt.Sprint(row["stop_id"])
			data = append(data, map[string]any{
				"stop_id":        sid,
				"stop_name":      catName[sid],
				"stop_lat":       catLoc[sid].Lat,
				"stop_lng":       catLoc[sid].Lng,
				"stop_sequence":  seq,
				"arrival_time":   mi64(row["arrival_time"]),
				"departure_time": mi64(row["departure_time"]),
			})
		}
		sort.Slice(data, func(i, j int) bool {
			return data[i]["stop_sequence"].(int) < data[j]["stop_sequence"].(int)
		})
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"trip_id": best, "entry_seq": bestEseq, "exit_seq": xseq,
			"count": len(data), "data": data,
		})
	})

	mux.HandleFunc("/api/v1/{table}", func(w http.ResponseWriter, r *http.Request) {
		table := r.PathValue("table")
		q := r.URL.Query()

		m.mu.Lock()
		switch {
		case table == "stop_time_updates" && q.Get("stop_id") != "":
			m.stuByStop++
		case table == "stop_time_updates" && q.Get("trip_id") != "":
			m.stuByTrip++
		case table == "trip_updates":
			m.tripUpdate++
		}
		m.mu.Unlock()

		var rows []map[string]any
		for _, row := range m.tables[table] {
			if v := q.Get("route_id"); v != "" && fmt.Sprint(row["route_id"]) != v {
				continue
			}
			if v := q.Get("trip_id"); v != "" && fmt.Sprint(row["trip_id"]) != v {
				continue
			}
			if v := q.Get("stop_id"); v != "" && fmt.Sprint(row["stop_id"]) != v {
				continue
			}
			rows = append(rows, row)
		}
		rows = page(rows, q.Get("offset"), q.Get("limit"))

		w.Header().Set("Content-Type", "application/json")
		_ = writeJSONData(w, rows)
	})
	return mux
}

func page(rows []map[string]any, offsetS, limitS string) []map[string]any {
	off, _ := strconv.Atoi(offsetS)
	lim, _ := strconv.Atoi(limitS)
	if off >= len(rows) {
		return nil
	}
	end := len(rows)
	if lim > 0 && off+lim < end {
		end = off + lim
	}
	return rows[off:end]
}

func writeJSONData(w http.ResponseWriter, rows []map[string]any) error {
	// Encode as {"data":[...]} like the middleware.
	type resp struct {
		Data []map[string]any `json:"data"`
	}
	return json.NewEncoder(w).Encode(resp{Data: rows})
}

// --- shared fixture: route "2", correct trip T1, wrong-direction T2, later T3,
// and filler Tf that doesn't serve entry/exit. ---

const (
	pt = "POINT(%f %f)" // lng lat
)

var (
	tEntry = geo.LatLng{Lat: 51.045, Lng: -114.07}
	tExit  = geo.LatLng{Lat: 51.055, Lng: -114.09}
	tDecoy = geo.LatLng{Lat: 51.20, Lng: -114.30}
)

func mockData() map[string][]map[string]any {
	stu := func(trip, stop string, seq int, dep int64) map[string]any {
		return map[string]any{"trip_id": trip, "stop_id": stop, "stop_sequence": seq, "departure_time": dep, "arrival_time": nil}
	}
	return map[string][]map[string]any{
		"calgary_transit_stops": {
			{"teleride_number": "S_entry", "stop_name": "Entry", "point": fmt.Sprintf(pt, tEntry.Lng, tEntry.Lat)},
			{"teleride_number": "S_exit", "stop_name": "Exit", "point": fmt.Sprintf(pt, tExit.Lng, tExit.Lat)},
			{"teleride_number": "S_decoy", "stop_name": "Decoy", "point": fmt.Sprintf(pt, tDecoy.Lng, tDecoy.Lat)},
		},
		"trip_updates": {
			{"trip_id": "T1", "route_id": "2"},
			{"trip_id": "T2", "route_id": "2"},
			{"trip_id": "T3", "route_id": "2"},
			{"trip_id": "Tf", "route_id": "2"},
		},
		"stop_time_updates": {
			stu("T1", "S_entry", 1, 1000), stu("T1", "S_exit", 2, 1600),
			stu("T2", "S_exit", 1, 900), stu("T2", "S_entry", 2, 980), // reversed direction
			stu("T3", "S_entry", 1, 2000), stu("T3", "S_exit", 2, 2600),
			stu("Tf", "S_decoy", 1, 1000), // on route, serves neither entry nor exit
		},
	}
}

func newTestSource(t *testing.T) (*HTTPSource, *mockMiddleware) {
	t.Helper()
	mock := &mockMiddleware{tables: mockData()}
	srv := httptest.NewServer(mock.handler())
	t.Cleanup(srv.Close)
	return NewHTTPSource(srv.URL), mock
}

// TestResolveLeg_UsesResolveEndpoint pins the C win: resolution goes through the
// middleware's /api/v1/resolve_trip (one call), which returns the correct-direction
// trip's entry→exit window — no per-candidate stop loads (the N+1).
func TestResolveLeg_UsesResolveEndpoint(t *testing.T) {
	src, mock := newTestSource(t)

	tripID, stops, err := ResolveLeg(src, tEntry, tExit, "2", 1000, 0) // now=0: all runs eligible
	if err != nil {
		t.Fatalf("ResolveLeg: %v", err)
	}
	if tripID != "T1" {
		t.Errorf("resolved %q, want T1 (nearest ETA, correct direction)", tripID)
	}
	if len(stops) != 2 || stops[0].StopID != "S_entry" || stops[1].StopID != "S_exit" {
		t.Errorf("windowed stops = %+v, want entry→exit", stops)
	}

	mock.mu.Lock()
	defer mock.mu.Unlock()
	if mock.resolveCalls != 1 {
		t.Errorf("resolve_trip calls = %d, want 1", mock.resolveCalls)
	}
	if mock.stuByTrip != 0 {
		t.Errorf("stop_time_updates by trip_id = %d, want 0 (no client-side N+1)", mock.stuByTrip)
	}
}

// TestResolveLeg_ExcludesDeparted: with now past T1's boarding time, the endpoint
// skips the departed run and resolves the upcoming one (T3).
func TestResolveLeg_ExcludesDeparted(t *testing.T) {
	src, _ := newTestSource(t)

	// now=1500: T1 (dep 1000) is departed beyond the grace; T3 (dep 2000) is upcoming.
	tripID, _, err := ResolveLeg(src, tEntry, tExit, "2", 1000, 1500)
	if err != nil {
		t.Fatalf("ResolveLeg: %v", err)
	}
	if tripID != "T3" {
		t.Errorf("resolved %q, want T3 (T1 departed)", tripID)
	}
}

// TestResolveLeg_FallsBackOnEndpointError: when resolve_trip fails (e.g. 5xx), the
// catalog-mapped path still falls back to the generic candidate scan and resolves.
func TestResolveLeg_FallsBackOnEndpointError(t *testing.T) {
	src, mock := newTestSource(t)
	mock.failResolve = true

	tripID, stops, err := ResolveLeg(src, tEntry, tExit, "2", 1000, 0)
	if err != nil {
		t.Fatalf("ResolveLeg: %v", err)
	}
	if tripID != "T1" {
		t.Errorf("resolved %q, want T1 via generic fallback", tripID)
	}
	if len(stops) != 2 {
		t.Errorf("windowed stops = %d, want 2", len(stops))
	}
	mock.mu.Lock()
	defer mock.mu.Unlock()
	if mock.resolveCalls == 0 {
		t.Error("resolve_trip was not attempted before falling back")
	}
	if mock.stuByTrip == 0 {
		t.Error("generic fallback did not load any trip stops")
	}
}

// TestCandidateTrips_ConcurrentLoad pins the A path: the generic candidate scan
// loads every route trip's stops (concurrently) and assembles them in feed order.
func TestCandidateTrips_ConcurrentLoad(t *testing.T) {
	src, mock := newTestSource(t)

	cands, err := src.CandidateTrips("2")
	if err != nil {
		t.Fatalf("CandidateTrips: %v", err)
	}
	gotIDs := make([]string, len(cands))
	for i, c := range cands {
		gotIDs[i] = c.TripID
	}
	want := []string{"T1", "T2", "T3", "Tf"}
	if fmt.Sprint(gotIDs) != fmt.Sprint(want) {
		t.Errorf("candidate order = %v, want %v", gotIDs, want)
	}
	for _, c := range cands {
		if c.TripID == "T1" && len(c.Stops) != 2 {
			t.Errorf("T1 stops = %d, want 2", len(c.Stops))
		}
	}
	mock.mu.Lock()
	defer mock.mu.Unlock()
	if mock.stuByTrip != 4 {
		t.Errorf("loaded %d trips' stops, want 4 (one per candidate)", mock.stuByTrip)
	}
}

// TestResolveLeg_FallsBackWhenNoCatalogStop: coordinates with no catalog stop in
// range bail the fast path; the generic scan then runs (and here also fails to
// match, proving the fallback path is actually taken — stops are loaded per trip).
func TestResolveLeg_FallsBackWhenNoCatalogStop(t *testing.T) {
	src, mock := newTestSource(t)

	// Far from every catalog stop → nearestCatalogStop misses → generic fallback.
	far := geo.LatLng{Lat: 60.0, Lng: -120.0}
	_, _, err := ResolveLeg(src, far, far, "2", 1000, 0)
	if err == nil {
		t.Fatal("expected resolution to fail for off-grid coordinates")
	}
	mock.mu.Lock()
	defer mock.mu.Unlock()
	if mock.resolveCalls != 0 {
		t.Errorf("resolve_trip calls = %d, want 0 (catalog miss bails before the endpoint)", mock.resolveCalls)
	}
	if mock.stuByTrip == 0 {
		t.Error("generic fallback did not load any trip stops — fallback not taken")
	}
}
