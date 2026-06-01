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

// resolveLeg is the fast path for §5.2 resolution. It maps the rider's entry/exit
// coordinates to GTFS stop_ids via the catalog, then hands those two stop_ids to the
// middleware's /api/v1/resolve_trip, which selects the current, in-order, future-only
// trip and returns its entry→exit windowed stops in one SQL round trip. Doing the
// selection server-side (against the live table) is both fewer queries than the old
// client-side candidate scan and immune to the stale cross-day rows that made
// resolution "prefer past".
//
// It falls back to the generic candidate scan whenever the fast path can't decide:
// no catalog stop within range, or the endpoint can't resolve (404 / transport
// error). The fallback keeps resolution as correct as before.
func (h *HTTPSource) resolveLeg(entry, exit geo.LatLng, routeID string, googleETA, now int64) (string, []Stop, error) {
	entryID, okEntry := h.nearestCatalogStop(entry)
	exitID, okExit := h.nearestCatalogStop(exit)
	if !okEntry || !okExit || entryID == exitID {
		return resolveLegGeneric(h, entry, exit, routeID, googleETA, now)
	}
	tripID, stops, err := h.resolveTripHTTP(routeID, entryID, exitID, googleETA, now)
	if err != nil {
		// The middleware couldn't resolve (404 no in-order trip, or a transport
		// error); fall back to the generic candidate scan, which applies the same
		// future-only floor and may still match.
		return resolveLegGeneric(h, entry, exit, routeID, googleETA, now)
	}
	return tripID, stops, nil
}

// resolveTripResponse mirrors the middleware's /api/v1/resolve_trip payload.
type resolveTripResponse struct {
	TripID string `json:"trip_id"`
	Data   []struct {
		StopID        string  `json:"stop_id"`
		StopName      string  `json:"stop_name"`
		StopLat       float64 `json:"stop_lat"`
		StopLng       float64 `json:"stop_lng"`
		StopSequence  int     `json:"stop_sequence"`
		ArrivalTime   int64   `json:"arrival_time"`
		DepartureTime int64   `json:"departure_time"`
	} `json:"data"`
}

// resolveTripHTTP asks the middleware to resolve this leg's current trip and return
// its entry→exit windowed stops. now is route-save's (authoritative) server clock,
// passed so the future-only floor is judged against it, not the middleware's clock.
// Any non-200 (notably 404 "no current in-order trip") is returned as an error so the
// caller can fall back to the generic scan.
func (h *HTTPSource) resolveTripHTTP(routeID, entryID, exitID string, googleETA, now int64) (string, []Stop, error) {
	q := url.Values{
		"route_id":      {routeID},
		"entry_stop_id": {entryID},
		"exit_stop_id":  {exitID},
		"time":          {strconv.FormatInt(googleETA, 10)},
		"now":           {strconv.FormatInt(now, 10)},
	}
	u := fmt.Sprintf("%s/api/v1/resolve_trip?%s", h.BaseURL, q.Encode())
	resp, err := h.Client.Get(u)
	if err != nil {
		return "", nil, fmt.Errorf("resolve_trip: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("resolve_trip: status %d", resp.StatusCode)
	}
	var rt resolveTripResponse
	if err := json.NewDecoder(resp.Body).Decode(&rt); err != nil {
		return "", nil, fmt.Errorf("resolve_trip: decode: %w", err)
	}
	if rt.TripID == "" || len(rt.Data) == 0 {
		return "", nil, fmt.Errorf("resolve_trip: empty result")
	}
	stops := make([]Stop, len(rt.Data))
	for i, d := range rt.Data {
		stops[i] = Stop{
			StopID:        d.StopID,
			Name:          d.StopName,
			Loc:           geo.LatLng{Lat: d.StopLat, Lng: d.StopLng},
			Sequence:      d.StopSequence,
			ArrivalTime:   d.ArrivalTime,
			DepartureTime: d.DepartureTime,
		}
	}
	return rt.TripID, stops, nil
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
