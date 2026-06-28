package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
	_ "time/tzdata" // embed the tz database; the alpine runtime image ships no tzdata
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

// middlewareBaseURL returns the tranzit-db-middleware origin (no trailing slash). It is a
// public Cloud Run service, so requests go direct over HTTPS — NOT through OTP_HTTP_PROXY,
// which only exists to reach the private OTP node on the tailnet.
func middlewareBaseURL() string {
	v := os.Getenv("MIDDLEWARE_BASE_URL")
	if v == "" {
		v = "http://localhost:8080"
	}
	return strings.TrimRight(v, "/")
}

// stripGTFSFeedPrefix turns an OTP gtfsId ("<feedId>:<rawId>", e.g. "1:12345678") into the
// raw GTFS id stored in vehicle_positions.trip_id. If there is no ":" it is returned as-is.
func stripGTFSFeedPrefix(gtfsID string) string {
	if i := strings.IndexByte(gtfsID, ':'); i >= 0 {
		return gtfsID[i+1:]
	}
	return gtfsID
}

// SourceOpenTrip identifies the routing engine in /route/otp responses, paralleling the
// "google-maps-api" source returned by /route.
const SourceOpenTrip = "opentrip"

// OTPRouteRequest is the body accepted by POST /route/otp.
type OTPRouteRequest struct {
	Origin      Location `json:"origin"`
	Destination Location `json:"destination"`
	// Mode selects the travel profile. One of: walk, bike, transit, walk_transit, bike_transit.
	// Defaults to walk_transit (walk access/egress + transit), matching the old Google TRANSIT mode.
	Mode string `json:"mode"`
	// NumItineraries caps how many ranked options to return (default 5).
	NumItineraries int `json:"num_itineraries"`
	// DepartureTime is the desired depart-at instant as RFC3339. Empty or "now" ⇒ now. OTP plans
	// forward from here to the next available trip (see FetchOTPRoutes).
	DepartureTime string `json:"departure_time"`
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
query Plan($fromLat: Float!, $fromLon: Float!, $toLat: Float!, $toLon: Float!, $modes: [TransportMode!], $num: Int, $date: String, $time: String, $searchWindow: Long, $arriveBy: Boolean) {
  plan(
    from: {lat: $fromLat, lon: $fromLon}
    to: {lat: $toLat, lon: $toLon}
    transportModes: $modes
    numItineraries: $num
    date: $date
    time: $time
    searchWindow: $searchWindow
    arriveBy: $arriveBy
  ) {
    searchWindowUsed
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
			SearchWindowUsed int            `json:"searchWindowUsed"`
			Itineraries      []otpItinerary `json:"itineraries"`
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
	TripID            string    `json:"trip_id,omitempty"`
	VehicleID         string    `json:"vehicle_id,omitempty"`
	RealTime          bool      `json:"realtime"`
	ArrivalDelaySec   int       `json:"arrival_delay_seconds,omitempty"`
	DepartureDelaySec int       `json:"departure_delay_seconds,omitempty"`
	Polyline          string    `json:"polyline"`
}

// calgaryTZ is the transit agency timezone; OTP's plan() date/time are wall-clock in this zone.
// Embedded via the blank "time/tzdata" import so it resolves on the tzdata-less alpine image.
var calgaryTZ = func() *time.Location {
	loc, err := time.LoadLocation("America/Edmonton")
	if err != nil {
		return time.UTC
	}
	return loc
}()

// FetchOTPRoutes plans a trip via OTP and returns cleaned itineraries. It searches forward from
// the requested departure time (default: now) until it finds the next available itinerary — like
// Google/Apple — instead of giving up when nothing departs within OTP's short default window. A
// narrow window is tried first (fast, common case), then full-day windows advancing up to a 7-day
// horizon so the next departure is found no matter how far off it is.
func FetchOTPRoutes(req OTPRouteRequest) ([]CleanItinerary, error) {
	modes, err := otpModes(req.Mode)
	if err != nil {
		return nil, err
	}
	num := req.NumItineraries
	if num <= 0 {
		num = 5
	}

	// Resolve the departure instant (default now). Accepts RFC3339 or "now".
	depart := time.Now()
	if s := strings.TrimSpace(req.DepartureTime); s != "" && !strings.EqualFold(s, "now") {
		t, perr := time.Parse(time.RFC3339, s)
		if perr != nil {
			return nil, fmt.Errorf("invalid departure_time %q (want RFC3339 or \"now\"): %w", s, perr)
		}
		depart = t
	}

	const (
		firstWindow = 2 * time.Hour
		dayWindow   = 24 * time.Hour
		horizon     = 7 * 24 * time.Hour
	)
	deadline := depart.Add(horizon)

	cursor := depart
	window := firstWindow
	for cursor.Before(deadline) {
		out, used, err := planOnce(req, modes, num, cursor, int(window/time.Second))
		if err != nil {
			return nil, err
		}
		if len(out) > 0 {
			log.Printf("[/route/otp] %d itineraries (departAt=%s window=%s searchWindowUsed=%ds)",
				len(out), cursor.In(calgaryTZ).Format(time.RFC3339), window, used)
			enrichVehicleIDs(out)
			return out, nil
		}
		// Nothing in this window — advance past it and widen to full days.
		cursor = cursor.Add(window)
		window = dayWindow
	}
	return nil, nil
}

// planOnce runs a single OTP plan() for the given departure instant and search window (seconds),
// returning the mapped itineraries and the searchWindow OTP actually used (for logging).
func planOnce(req OTPRouteRequest, modes []transportMode, num int, depart time.Time, windowSecs int) ([]CleanItinerary, int, error) {
	local := depart.In(calgaryTZ)
	payload := map[string]any{
		"query": otpPlanQuery,
		"variables": map[string]any{
			"fromLat":      req.Origin.Lat,
			"fromLon":      req.Origin.Lng,
			"toLat":        req.Destination.Lat,
			"toLon":        req.Destination.Lng,
			"modes":        modes,
			"num":          num,
			"date":         local.Format("2006-01-02"),
			"time":         local.Format("15:04:05"),
			"searchWindow": windowSecs,
			"arriveBy":     false,
		},
	}
	body, _ := json.Marshal(payload)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	u := otpBaseURL() + otpGraphQLPath()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := otpHTTPClient().Do(httpReq)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, 0, fmt.Errorf("otp http %d", resp.StatusCode)
	}

	var parsed otpResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, 0, err
	}
	if len(parsed.Errors) > 0 {
		return nil, 0, fmt.Errorf("otp graphql error: %s", parsed.Errors[0].Message)
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
				cl.TripID = stripGTFSFeedPrefix(l.Trip.GtfsID)
			}
			ci.Legs = append(ci.Legs, cl)
		}
		out = append(out, ci)
	}

	return out, parsed.Data.Plan.SearchWindowUsed, nil
}

// enrichVehicleIDs fills in CleanLeg.VehicleID for transit legs by looking up the live
// vehicle currently running each trip in the vehicle_positions table (via tranzit-db-
// middleware). It is best-effort: any failure (no MIDDLEWARE_BASE_URL, network error,
// trip with no live vehicle) leaves VehicleID empty and never fails the route — trip_id
// is already populated regardless.
func enrichVehicleIDs(itineraries []CleanItinerary) {
	// Collect unique trip ids across all transit legs.
	tripIDs := make(map[string]struct{})
	for _, it := range itineraries {
		for _, l := range it.Legs {
			if l.TripID != "" {
				tripIDs[l.TripID] = struct{}{}
			}
		}
	}
	if len(tripIDs) == 0 {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var (
		mu      sync.Mutex
		wg      sync.WaitGroup
		results = make(map[string]string, len(tripIDs))
	)
	for tripID := range tripIDs {
		wg.Add(1)
		go func(tripID string) {
			defer wg.Done()
			vid, err := fetchVehicleIDByTrip(ctx, tripID)
			if err != nil {
				log.Printf("[/route/otp] vehicle lookup for trip %s failed: %v", tripID, err)
				return
			}
			if vid == "" {
				return
			}
			mu.Lock()
			results[tripID] = vid
			mu.Unlock()
		}(tripID)
	}
	wg.Wait()

	if len(results) == 0 {
		return
	}
	for i := range itineraries {
		for j := range itineraries[i].Legs {
			if vid, ok := results[itineraries[i].Legs[j].TripID]; ok {
				itineraries[i].Legs[j].VehicleID = vid
			}
		}
	}
}

// fetchVehicleIDByTrip returns the vehicle_id currently assigned to tripID, or "" if no
// live vehicle is reporting that trip. It queries tranzit-db-middleware's generic table API.
func fetchVehicleIDByTrip(ctx context.Context, tripID string) (string, error) {
	base, client := middlewareCall()
	u := fmt.Sprintf("%s/api/v1/vehicle_positions?trip_id=%s&limit=1",
		base, url.QueryEscape(tripID))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("middleware http %d", resp.StatusCode)
	}

	var parsed struct {
		Data []struct {
			VehicleID string `json:"vehicle_id"`
			TripID    string `json:"trip_id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", err
	}
	if len(parsed.Data) == 0 {
		return "", nil
	}
	return parsed.Data[0].VehicleID, nil
}

// msToTime converts OTP epoch milliseconds to a time.Time (UTC).
func msToTime(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}
