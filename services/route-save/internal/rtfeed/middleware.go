package rtfeed

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Middleware fetches arrivals from tranzit-db-middleware's generic table query
// (GET /api/v1/stop_time_updates?trip_id=…). One request per active trip keeps
// resolution our own (§5.2): we only ever ask for trips we resolved.
type Middleware struct {
	BaseURL string
	HTTP    *http.Client
}

// NewMiddleware builds a Middleware source for the given base URL.
func NewMiddleware(baseURL string) *Middleware {
	return &Middleware{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 10 * time.Second},
	}
}

type queryResponse struct {
	Data []map[string]any `json:"data"`
}

func (m *Middleware) Fetch(ctx context.Context, tripIDs []string) ([]Arrival, error) {
	var out []Arrival
	for _, tripID := range tripIDs {
		rows, err := m.fetchTrip(ctx, tripID)
		if err != nil {
			return nil, err
		}
		out = append(out, rows...)
	}
	return out, nil
}

func (m *Middleware) fetchTrip(ctx context.Context, tripID string) ([]Arrival, error) {
	u := fmt.Sprintf("%s/api/v1/stop_time_updates?%s", m.BaseURL,
		url.Values{"trip_id": {tripID}}.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := m.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("rtfeed: query stop_time_updates: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("rtfeed: stop_time_updates status %d", resp.StatusCode)
	}
	var qr queryResponse
	if err := json.NewDecoder(resp.Body).Decode(&qr); err != nil {
		return nil, fmt.Errorf("rtfeed: decode: %w", err)
	}

	arrivals := make([]Arrival, 0, len(qr.Data))
	for _, r := range qr.Data {
		at := asInt64(r["arrival_time"])
		if at == 0 {
			continue // no usable prediction for this stop yet
		}
		arrivals = append(arrivals, Arrival{
			TripID:           tripID,
			StopID:           asString(r["stop_id"]),
			PredictedArrival: at,
		})
	}
	return arrivals, nil
}

func asString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatInt(int64(t), 10)
	default:
		return ""
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
