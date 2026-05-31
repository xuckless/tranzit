package datasource

import (
	"encoding/json"
	"fmt"
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

func (h *HTTPSource) CandidateTrips(routeID string) ([]TripCandidate, error) {
	rows, err := h.query("trip_updates", url.Values{"route_id": {routeID}})
	if err != nil {
		return nil, err
	}
	var out []TripCandidate
	for _, r := range rows {
		tripID := asString(r["trip_id"])
		if tripID == "" {
			continue
		}
		stops, err := h.TripStops(tripID)
		if err != nil {
			return nil, err
		}
		out = append(out, TripCandidate{TripID: tripID, Stops: stops})
	}
	return out, nil
}

func (h *HTTPSource) TripStops(tripID string) ([]Stop, error) {
	if err := h.loadStopGeo(); err != nil {
		return nil, err
	}
	rows, err := h.query("stop_time_updates", url.Values{"trip_id": {tripID}})
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
		rows, err := h.query("calgary_transit_stops", url.Values{"limit": {"100000"}})
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
