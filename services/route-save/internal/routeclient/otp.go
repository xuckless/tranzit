package routeclient

// otp.go calls tranzit-route-service POST /route/otp — the OpenTripPlanner path —
// for OTP-tracked sessions. Unlike the Google /route client (client.go), it takes a
// destination as coordinates (not a place ID) and asks OTP to plan on the GTFS graph,
// so the returned legs carry concrete trip_ids. It returns the parsed best itinerary
// plus the raw echo envelope ({source:"opentrip", itineraries:[chosen]}) the client
// re-renders from (§13.2).

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

// OTPClient fetches a route from an origin to a coordinate destination via OTP. It
// mirrors Client but for the coords-based OTP engine; the destination is lat/lng, and
// mode / num pick the OTP travel profile and how many itineraries to rank.
type OTPClient interface {
	RouteOTP(ctx context.Context, origin, dest geo.LatLng, mode string, num int) (directions.Route, json.RawMessage, error)
}

// OTPHTTPClient is the tranzit-route-service-backed OTPClient.
type OTPHTTPClient struct {
	BaseURL string
	HTTP    *http.Client
}

// NewOTPClient builds an OTPHTTPClient for the given route-service base URL. OTP
// planning can take several seconds (route-service uses a 20s upstream timeout), so
// the client timeout is generous.
func NewOTPClient(baseURL string) *OTPHTTPClient {
	return &OTPHTTPClient{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 25 * time.Second},
	}
}

type otpRouteRequest struct {
	Origin         location `json:"origin"`
	Destination    location `json:"destination"`
	Mode           string   `json:"mode,omitempty"`
	NumItineraries int      `json:"num_itineraries,omitempty"`
}

func (c *OTPHTTPClient) RouteOTP(ctx context.Context, origin, dest geo.LatLng, mode string, num int) (directions.Route, json.RawMessage, error) {
	payload, err := json.Marshal(otpRouteRequest{
		Origin:         location{Lat: origin.Lat, Lng: origin.Lng},
		Destination:    location{Lat: dest.Lat, Lng: dest.Lng},
		Mode:           mode,
		NumItineraries: num,
	})
	if err != nil {
		return directions.Route{}, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/route/otp", bytes.NewReader(payload))
	if err != nil {
		return directions.Route{}, nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return directions.Route{}, nil, fmt.Errorf("routeclient: POST /route/otp: %w", err)
	}
	defer resp.Body.Close()
	// 204 = OTP found no itineraries for this origin/destination.
	if resp.StatusCode == http.StatusNoContent {
		return directions.Route{}, nil, fmt.Errorf("routeclient: /route/otp found no itineraries")
	}
	if resp.StatusCode != http.StatusOK {
		return directions.Route{}, nil, fmt.Errorf("routeclient: /route/otp status %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return directions.Route{}, nil, err
	}
	// route-service returns {source:"opentrip", itineraries:[…]}; pick the best and
	// echo only that itinerary downstream.
	return directions.BestOTPWithRaw(raw)
}
