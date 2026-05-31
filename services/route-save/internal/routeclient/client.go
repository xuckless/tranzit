// Package routeclient calls tranzit-route-service POST /route to fetch directions
// for reroutes (§9). The service takes a lat/lng origin and a Google place ID
// destination and returns the raw Google Routes response, which we reduce to the
// best alternative.
package routeclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
)

// Client fetches a route from an origin to a place-ID destination.
type Client interface {
	Route(ctx context.Context, origin geo.LatLng, destPlaceID string) (directions.Route, error)
}

// HTTPClient is the tranzit-route-service-backed implementation.
type HTTPClient struct {
	BaseURL string
	HTTP    *http.Client
}

// NewHTTPClient builds an HTTPClient for the given route-service base URL.
func NewHTTPClient(baseURL string) *HTTPClient {
	return &HTTPClient{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 15 * time.Second},
	}
}

type routeRequest struct {
	Origin        location `json:"origin"`
	DestinationID string   `json:"destination_id"`
}

type location struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

func (c *HTTPClient) Route(ctx context.Context, origin geo.LatLng, destPlaceID string) (directions.Route, error) {
	payload, err := json.Marshal(routeRequest{
		Origin:        location{Lat: origin.Lat, Lng: origin.Lng},
		DestinationID: destPlaceID,
	})
	if err != nil {
		return directions.Route{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/route", bytes.NewReader(payload))
	if err != nil {
		return directions.Route{}, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return directions.Route{}, fmt.Errorf("routeclient: POST /route: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return directions.Route{}, fmt.Errorf("routeclient: /route status %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return directions.Route{}, err
	}
	// route-service returns the raw Google {routes:[…]} wrapper.
	return directions.Best(raw)
}
