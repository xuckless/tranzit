package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// otpClientOnce builds a dedicated HTTP client for OTP traffic. When OTP_HTTP_PROXY is
// set (e.g. on Cloud Run, where a Tailscale userspace sidecar exposes an outbound proxy
// at localhost:1055), OTP requests are routed through it so the private tailnet address
// resolves and connects. The Google Places clients are left untouched and go direct.
var (
	otpClientOnce sync.Once
	otpClient     *http.Client
)

func otpHTTPClient() *http.Client {
	otpClientOnce.Do(func() {
		tr := &http.Transport{}
		if p := os.Getenv("OTP_HTTP_PROXY"); p != "" {
			if u, err := url.Parse(p); err == nil {
				tr.Proxy = http.ProxyURL(u)
			}
		}
		otpClient = &http.Client{Transport: tr}
	})
	return otpClient
}

// otp.go adds an OpenTripPlanner 2 backed routing path alongside the existing Google
// Routes integration in routes.go. It is purely additive: the Google /route endpoint is
// untouched; this exposes a parallel /route/otp endpoint that plans walk / bike / transit
// trips against a self-hosted OTP instance (OTP_BASE_URL).
//
// OTP2 serves the GTFS GraphQL API at /otp/routers/default/index/graphql.

// otpBaseURL returns the configured OTP origin (no trailing slash).
func otpBaseURL() string {
	v := os.Getenv("OTP_BASE_URL")
	if v == "" {
		v = "http://localhost:8080"
	}
	return strings.TrimRight(v, "/")
}

func otpGraphQLPath() string {
	v := os.Getenv("OTP_GRAPHQL_PATH")
	if v == "" {
		v = "/otp/routers/default/index/graphql"
	}
	return v
}

// OTPRouteRequest is the body accepted by POST /route/otp.
type OTPRouteRequest struct {
	Origin      Location `json:"origin"`
	Destination Location `json:"destination"`
	// Mode selects the travel profile. One of: walk, bike, transit, walk_transit, bike_transit.
	// Defaults to walk_transit (walk access/egress + transit), matching the old Google TRANSIT mode.
	Mode string `json:"mode"`
	// NumItineraries caps how many ranked options to return (default 5).
	NumItineraries int `json:"num_itineraries"`
}

// transportMode is an OTP TransportMode input value.
type transportMode struct {
	Mode string `json:"mode"`
}

// otpModes maps our profile names to OTP transportModes sets. Transit profiles always
// include a street mode for access/egress legs. CAR is never emitted (walk/bike/transit only).
func otpModes(mode string) ([]transportMode, error) {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "", "walk_transit", "transit":
		return []transportMode{{"WALK"}, {"TRANSIT"}}, nil
	case "bike_transit":
		return []transportMode{{"BICYCLE"}, {"TRANSIT"}}, nil
	case "walk":
		return []transportMode{{"WALK"}}, nil
	case "bike", "bicycle":
		return []transportMode{{"BICYCLE"}}, nil
	default:
		return nil, fmt.Errorf("unsupported mode %q (use walk, bike, transit, walk_transit, bike_transit)", mode)
	}
}

const otpPlanQuery = `
query Plan($fromLat: Float!, $fromLon: Float!, $toLat: Float!, $toLon: Float!, $modes: [TransportMode!], $num: Int) {
  plan(
    from: {lat: $fromLat, lon: $fromLon}
    to: {lat: $toLat, lon: $toLon}
    transportModes: $modes
    numItineraries: $num
  ) {
    itineraries {
      duration
      walkDistance
      startTime
      endTime
      legs {
        mode
        duration
        distance
        startTime
        endTime
        realTime
        arrivalDelay
        departureDelay
        from { name lat lon stop { gtfsId name } }
        to   { name lat lon stop { gtfsId name } }
        route { gtfsId shortName longName }
        trip  { gtfsId tripHeadsign }
        legGeometry { points }
      }
    }
  }
}`

// --- OTP GraphQL response shapes (only the fields we map) ---

type otpResponse struct {
	Data struct {
		Plan struct {
			Itineraries []otpItinerary `json:"itineraries"`
		} `json:"plan"`
	} `json:"data"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
}

type otpItinerary struct {
	Duration     int      `json:"duration"`
	WalkDistance float64  `json:"walkDistance"`
	StartTime    int64    `json:"startTime"`
	EndTime      int64    `json:"endTime"`
	Legs         []otpLeg `json:"legs"`
}

type otpLeg struct {
	Mode           string   `json:"mode"`
	Duration       float64  `json:"duration"`
	Distance       float64  `json:"distance"`
	StartTime      int64    `json:"startTime"`
	EndTime        int64    `json:"endTime"`
	RealTime       bool     `json:"realTime"`
	ArrivalDelay   int      `json:"arrivalDelay"`
	DepartureDelay int      `json:"departureDelay"`
	From           otpPlace `json:"from"`
	To             otpPlace `json:"to"`
	Route          *struct {
		GtfsID    string `json:"gtfsId"`
		ShortName string `json:"shortName"`
		LongName  string `json:"longName"`
	} `json:"route"`
	Trip *struct {
		GtfsID       string `json:"gtfsId"`
		TripHeadsign string `json:"tripHeadsign"`
	} `json:"trip"`
	LegGeometry struct {
		Points string `json:"points"`
	} `json:"legGeometry"`
}

type otpPlace struct {
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
	Stop *struct {
		GtfsID string `json:"gtfsId"`
		Name   string `json:"name"`
	} `json:"stop"`
}

// --- Cleaned response we return to clients ---

type CleanItinerary struct {
	DurationSeconds int        `json:"duration_seconds"`
	WalkDistanceM   float64    `json:"walk_distance_m"`
	StartTime       time.Time  `json:"start_time"`
	EndTime         time.Time  `json:"end_time"`
	Legs            []CleanLeg `json:"legs"`
}

type CleanLeg struct {
	Mode              string    `json:"mode"`
	DurationSeconds   int       `json:"duration_seconds"`
	DistanceM         float64   `json:"distance_m"`
	StartTime         time.Time `json:"start_time"`
	EndTime           time.Time `json:"end_time"`
	FromName          string    `json:"from"`
	ToName            string    `json:"to"`
	FromStopID        string    `json:"from_stop_id,omitempty"`
	ToStopID          string    `json:"to_stop_id,omitempty"`
	RouteShortName    string    `json:"route_short_name,omitempty"`
	RouteLongName     string    `json:"route_long_name,omitempty"`
	Headsign          string    `json:"headsign,omitempty"`
	RealTime          bool      `json:"realtime"`
	ArrivalDelaySec   int       `json:"arrival_delay_seconds,omitempty"`
	DepartureDelaySec int       `json:"departure_delay_seconds,omitempty"`
	Polyline          string    `json:"polyline"`
}

// FetchOTPRoutes plans a trip via OTP and returns cleaned itineraries.
func FetchOTPRoutes(req OTPRouteRequest) ([]CleanItinerary, error) {
	modes, err := otpModes(req.Mode)
	if err != nil {
		return nil, err
	}
	num := req.NumItineraries
	if num <= 0 {
		num = 5
	}

	payload := map[string]any{
		"query": otpPlanQuery,
		"variables": map[string]any{
			"fromLat": req.Origin.Lat,
			"fromLon": req.Origin.Lng,
			"toLat":   req.Destination.Lat,
			"toLon":   req.Destination.Lng,
			"modes":   modes,
			"num":     num,
		},
	}
	body, _ := json.Marshal(payload)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	url := otpBaseURL() + otpGraphQLPath()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := otpHTTPClient().Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("otp http %d", resp.StatusCode)
	}

	var parsed otpResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, err
	}
	if len(parsed.Errors) > 0 {
		return nil, fmt.Errorf("otp graphql error: %s", parsed.Errors[0].Message)
	}

	out := make([]CleanItinerary, 0, len(parsed.Data.Plan.Itineraries))
	for _, it := range parsed.Data.Plan.Itineraries {
		ci := CleanItinerary{
			DurationSeconds: it.Duration,
			WalkDistanceM:   it.WalkDistance,
			StartTime:       msToTime(it.StartTime),
			EndTime:         msToTime(it.EndTime),
		}
		for _, l := range it.Legs {
			cl := CleanLeg{
				Mode:              l.Mode,
				DurationSeconds:   int(l.Duration),
				DistanceM:         l.Distance,
				StartTime:         msToTime(l.StartTime),
				EndTime:           msToTime(l.EndTime),
				FromName:          l.From.Name,
				ToName:            l.To.Name,
				RealTime:          l.RealTime,
				ArrivalDelaySec:   l.ArrivalDelay,
				DepartureDelaySec: l.DepartureDelay,
				Polyline:          l.LegGeometry.Points,
			}
			if l.From.Stop != nil {
				cl.FromStopID = l.From.Stop.GtfsID
			}
			if l.To.Stop != nil {
				cl.ToStopID = l.To.Stop.GtfsID
			}
			if l.Route != nil {
				cl.RouteShortName = l.Route.ShortName
				cl.RouteLongName = l.Route.LongName
			}
			if l.Trip != nil {
				cl.Headsign = l.Trip.TripHeadsign
			}
			ci.Legs = append(ci.Legs, cl)
		}
		out = append(out, ci)
	}
	return out, nil
}

// msToTime converts OTP epoch milliseconds to a time.Time (UTC).
func msToTime(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}
