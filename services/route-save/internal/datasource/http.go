package datasource

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tranzit-route-save/internal/geo"
)

// HTTPSource is a thin DataSource backed by tranzit-db-middleware's generic
// table queries. It is secondary to the fixture: it exists so the CLI can run
// the pipeline against live data, not to be a production data layer. Stop
// geometry is loaded once and cached, since the static catalog rarely changes
// within a trip.
type HTTPSource struct {
	BaseURL string // e.g. http://localhost:8080
	Client  *http.Client

	stopsOnce sync.Once
	stopGeo   map[string]Stop // teleride_number -> static stop (Loc, Name)
	stopErr   error
}

// NewHTTPSource builds an HTTPSource pointing at the middleware base URL.
func NewHTTPSource(baseURL string) *HTTPSource {
	return &HTTPSource{
		BaseURL: strings.TrimRight(baseURL, "/"),
		Client:  &http.Client{Timeout: 15 * time.Second},
	}
}

type queryResponse struct {
	Data []map[string]any `json:"data"`
}

func (h *HTTPSource) query(table string, params url.Values) ([]map[string]any, error) {
	u := fmt.Sprintf("%s/api/v1/%s", h.BaseURL, table)
	if len(params) > 0 {
		u += "?" + params.Encode()
	}
	resp, err := h.Client.Get(u)
	if err != nil {
		return nil, fmt.Errorf("query %s: %w", table, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("query %s: status %d", table, resp.StatusCode)
	}
	var qr queryResponse
	if err := json.NewDecoder(resp.Body).Decode(&qr); err != nil {
		return nil, fmt.Errorf("query %s: decode: %w", table, err)
	}
	return qr.Data, nil
}

// pageSize is the middleware's hard cap on rows per generic table query; larger
// requested limits are silently truncated to this, so we must page with offset.
const pageSize = 100

// queryAll pages through every row of a table query, stepping offset until a
// short page signals the end. Without this the stop catalog (thousands of rows)
// would be truncated to a single page and most stop-geo lookups would miss.
func (h *HTTPSource) queryAll(table string, params url.Values) ([]map[string]any, error) {
	var all []map[string]any
	for offset := 0; ; offset += pageSize {
		p := url.Values{}
		for k, v := range params {
			p[k] = v
		}
		p.Set("limit", strconv.Itoa(pageSize))
		p.Set("offset", strconv.Itoa(offset))

		rows, err := h.query(table, p)
		if err != nil {
			return nil, err
		}
		all = append(all, rows...)
		if len(rows) < pageSize {
			return all, nil
		}
	}
}

// maxResolveConcurrency bounds how many per-candidate stop_time_updates queries
// run at once during trip resolution. trip_updates carries the whole service day
// for a route (100+ trips), so the per-candidate fetch is an N+1; fanning it out
// turns ~N sequential round-trips into ~N/concurrency. The cap keeps us from
// opening a hundred sockets to the middleware at once.
const maxResolveConcurrency = 16

func (h *HTTPSource) CandidateTrips(routeID string) ([]TripCandidate, error) {
	ids, err := h.routeTripIDs(routeID)
	if err != nil {
		return nil, err
	}
	stopsByID, err := h.tripStopsConcurrent(ids)
	if err != nil {
		return nil, err
	}
	out := make([]TripCandidate, 0, len(ids))
	for _, id := range ids {
		out = append(out, TripCandidate{TripID: id, Stops: stopsByID[id]})
	}
	return out, nil
}

// routeTripIDs returns the distinct trip_ids the route is running today, in feed
// order, from trip_updates.
func (h *HTTPSource) routeTripIDs(routeID string) ([]string, error) {
	rows, err := h.queryAll("trip_updates", url.Values{"route_id": {routeID}})
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(rows))
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		id := asString(r["trip_id"])
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids, nil
}

// tripStopsConcurrent loads each trip's stops with bounded concurrency, returning
// a trip_id→stops map. It fails fast: the first error cancels further work and is
// returned. Result assembly is keyed by trip_id, so it is order-independent.
func (h *HTTPSource) tripStopsConcurrent(tripIDs []string) (map[string][]Stop, error) {
	// Warm the catalog once up front so the workers don't race on sync.Once and so
	// a catalog error surfaces before fanning out.
	if err := h.loadStopGeo(); err != nil {
		return nil, err
	}

	out := make(map[string][]Stop, len(tripIDs))
	sem := make(chan struct{}, maxResolveConcurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	for _, id := range tripIDs {
		mu.Lock()
		stop := firstErr != nil
		mu.Unlock()
		if stop {
			break
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer wg.Done()
			defer func() { <-sem }()
			stops, err := h.TripStops(id)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			out[id] = stops
		}(id)
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	return out, nil
}

// stopVisit is one trip's call at a stop, from stop_time_updates.
type stopVisit struct {
	tripID string
	seq    int
	dep    int64
	arr    int64
}

// resolveLeg is the fast path for §5.2 resolution. Rather than load every one of
// the route's ~100+ daily trips' stops (the CandidateTrips N+1), it:
//  1. maps the rider's entry/exit coordinates to GTFS stop_ids via the catalog,
//  2. asks stop_time_updates which trips call at those two stops (one query each)
//     and trip_updates which trips the route is running — all concurrently,
//  3. intersects them, requiring entry before exit on the same trip, and picks the
//     run whose entry time is closest to Google's ETA,
//  4. loads only that winner's stops.
//
// It falls back to the generic candidate scan (still parallelized) whenever the
// fast path can't safely decide: no catalog stop within range, a network error,
// no in-order match, or the winner failing entry→exit validation. The fallback
// keeps resolution exactly as correct as before; the fast path just avoids the
// N+1 in the common case.
func (h *HTTPSource) resolveLeg(entry, exit geo.LatLng, routeID string, googleETA int64) (string, []Stop, error) {
	entryID, okEntry := h.nearestCatalogStop(entry)
	exitID, okExit := h.nearestCatalogStop(exit)
	if !okEntry || !okExit || entryID == exitID {
		return resolveLegGeneric(h, entry, exit, routeID, googleETA)
	}

	var (
		routeIDs                    []string
		entryVisits, exitVisits     []stopVisit
		errRoute, errEntry, errExit error
		wg                          sync.WaitGroup
	)
	wg.Add(3)
	go func() { defer wg.Done(); routeIDs, errRoute = h.routeTripIDs(routeID) }()
	go func() { defer wg.Done(); entryVisits, errEntry = h.tripsAtStop(entryID) }()
	go func() { defer wg.Done(); exitVisits, errExit = h.tripsAtStop(exitID) }()
	wg.Wait()
	if err := firstNonNil(errRoute, errEntry, errExit); err != nil {
		return "", nil, err
	}

	onRoute := make(map[string]bool, len(routeIDs))
	for _, id := range routeIDs {
		onRoute[id] = true
	}
	exitSeqs := make(map[string][]int, len(exitVisits))
	for _, e := range exitVisits {
		exitSeqs[e.tripID] = append(exitSeqs[e.tripID], e.seq)
	}

	best := ""
	bestDiff := int64(math.MaxInt64)
	for _, v := range entryVisits {
		if !onRoute[v.tripID] {
			continue
		}
		if !anyAfter(exitSeqs[v.tripID], v.seq) {
			continue // exit not after entry on this run (wrong direction / not served)
		}
		t := v.dep
		if t == 0 {
			t = v.arr
		}
		if t == 0 {
			continue
		}
		if diff := absI64(t - googleETA); diff < bestDiff {
			bestDiff, best = diff, v.tripID
		}
	}
	if best == "" {
		return resolveLegGeneric(h, entry, exit, routeID, googleETA)
	}

	stops, err := h.TripStops(best)
	if err != nil {
		return "", nil, err
	}
	window, err := FilterLegStops(stops, best, entry, exit)
	if err != nil {
		// The stop-scoped pick didn't validate against the trip's own stops; fall
		// back to the proven scan rather than trust it.
		return resolveLegGeneric(h, entry, exit, routeID, googleETA)
	}
	return best, window, nil
}

// nearestCatalogStop returns the catalog stop_id closest to loc, true when it is
// within stopMatchRadiusM. The catalog (teleride_number → location) is loaded once.
func (h *HTTPSource) nearestCatalogStop(loc geo.LatLng) (string, bool) {
	if h.loadStopGeo() != nil {
		return "", false
	}
	best := ""
	bestD := math.MaxFloat64
	for id, s := range h.stopGeo {
		if d := geo.HaversineM(loc, s.Loc); d < bestD {
			bestD, best = d, id
		}
	}
	return best, best != "" && bestD <= stopMatchRadiusM
}

// tripsAtStop returns every trip's call at the stop, from stop_time_updates.
func (h *HTTPSource) tripsAtStop(stopID string) ([]stopVisit, error) {
	rows, err := h.queryAll("stop_time_updates", url.Values{"stop_id": {stopID}})
	if err != nil {
		return nil, err
	}
	out := make([]stopVisit, 0, len(rows))
	for _, r := range rows {
		id := asString(r["trip_id"])
		if id == "" {
			continue
		}
		out = append(out, stopVisit{
			tripID: id,
			seq:    int(asInt64(r["stop_sequence"])),
			dep:    asInt64(r["departure_time"]),
			arr:    asInt64(r["arrival_time"]),
		})
	}
	return out, nil
}

func (h *HTTPSource) TripStops(tripID string) ([]Stop, error) {
	if err := h.loadStopGeo(); err != nil {
		return nil, err
	}
	rows, err := h.queryAll("stop_time_updates", url.Values{"trip_id": {tripID}})
	if err != nil {
		return nil, err
	}
	stops := make([]Stop, 0, len(rows))
	for _, r := range rows {
		stopID := asString(r["stop_id"])
		geoStop, ok := h.stopGeo[stopID]
		if !ok {
			continue // no static location for this stop_id; skip
		}
		stops = append(stops, Stop{
			StopID:        stopID,
			Name:          geoStop.Name,
			Loc:           geoStop.Loc,
			Sequence:      int(asInt64(r["stop_sequence"])),
			ArrivalTime:   asInt64(r["arrival_time"]),
			DepartureTime: asInt64(r["departure_time"]),
		})
	}
	sort.Slice(stops, func(i, j int) bool { return stops[i].Sequence < stops[j].Sequence })
	return stops, nil
}

// loadStopGeo bulk-loads the static stop catalog once.
func (h *HTTPSource) loadStopGeo() error {
	h.stopsOnce.Do(func() {
		rows, err := h.queryAll("calgary_transit_stops", nil)
		if err != nil {
			h.stopErr = err
			return
		}
		m := make(map[string]Stop, len(rows))
		for _, r := range rows {
			id := asString(r["teleride_number"])
			loc, ok := parsePointWKT(asString(r["point"]))
			if id == "" || !ok {
				continue
			}
			m[id] = Stop{StopID: id, Name: asString(r["stop_name"]), Loc: loc}
		}
		h.stopGeo = m
	})
	return h.stopErr
}

// parsePointWKT parses "POINT(lon lat)" into a LatLng. Per the §2 platform
// invariant, WKT is longitude-latitude order.
func parsePointWKT(wkt string) (geo.LatLng, bool) {
	s := strings.TrimSpace(wkt)
	if !strings.HasPrefix(strings.ToUpper(s), "POINT") {
		return geo.LatLng{}, false
	}
	open := strings.IndexByte(s, '(')
	close := strings.IndexByte(s, ')')
	if open < 0 || close < open {
		return geo.LatLng{}, false
	}
	parts := strings.Fields(s[open+1 : close])
	if len(parts) != 2 {
		return geo.LatLng{}, false
	}
	lng, err1 := strconv.ParseFloat(parts[0], 64)
	lat, err2 := strconv.ParseFloat(parts[1], 64)
	if err1 != nil || err2 != nil {
		return geo.LatLng{}, false
	}
	return geo.LatLng{Lat: lat, Lng: lng}, true
}

func asString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", t)
	}
}

func asInt64(v any) int64 {
	switch t := v.(type) {
	case float64:
		return int64(t)
	case string:
		n, _ := strconv.ParseInt(t, 10, 64)
		return n
	default:
		return 0
	}
}
