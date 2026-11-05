package directions

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// samplePolyline is the canonical encoded-polyline example; it decodes to
// (38.5,-120.2), (40.7,-120.95), (43.252,-126.453).
const samplePolyline = "_p~iF~ps|U_ulLnnqC_mqNvxq`@"

func TestParseOTP_MapsTransitLeg(t *testing.T) {
	env := map[string]any{
		"source": "opentrip",
		"itineraries": []any{
			map[string]any{
				"duration_seconds": 1800,
				"legs": []any{
					map[string]any{"mode": "WALK", "polyline": samplePolyline},
					map[string]any{
						"mode":             "BUS",
						"trip_id":          "55",  // route-service already stripped the feed prefix
						"from_stop_id":     "1:e", // stop ids still carry it
						"to_stop_id":       "1:x",
						"route_short_name": "MO", // MAX alias -> 303
						"from":             "Entry Stop",
						"to":               "Exit Stop",
						"polyline":         samplePolyline,
					},
				},
			},
		},
	}
	raw, _ := json.Marshal(env)

	route, err := ParseOTP(raw)
	if err != nil {
		t.Fatalf("ParseOTP: %v", err)
	}
	if route.DurationS != 1800 {
		t.Errorf("DurationS = %d, want 1800", route.DurationS)
	}
	if len(route.Legs) != 2 {
		t.Fatalf("legs = %d, want 2 (walk + bus)", len(route.Legs))
	}
	if route.Legs[0].Mode != ModeWalk {
		t.Errorf("leg 0 mode = %v, want walk", route.Legs[0].Mode)
	}

	bus := route.Legs[1]
	if bus.Mode != ModeBus {
		t.Fatalf("leg 1 mode = %v, want bus", bus.Mode)
	}
	if bus.RouteID != "303" {
		t.Errorf("RouteID = %q, want 303 (MO alias)", bus.RouteID)
	}
	if bus.TripID != "55" {
		t.Errorf("TripID = %q, want 55", bus.TripID)
	}
	if bus.EntryStopID != "e" || bus.ExitStopID != "x" {
		t.Errorf("stop ids = %q/%q, want e/x (feed prefix stripped)", bus.EntryStopID, bus.ExitStopID)
	}
	if bus.Entry == nil || bus.Exit == nil {
		t.Fatal("entry/exit endpoints not set")
	}
	// Entry = first polyline point, Exit = last.
	assertClose(t, "entry lat", bus.Entry.Loc.Lat, 38.5)
	assertClose(t, "entry lng", bus.Entry.Loc.Lng, -120.2)
	assertClose(t, "exit lat", bus.Exit.Loc.Lat, 43.252)
	assertClose(t, "exit lng", bus.Exit.Loc.Lng, -126.453)
}

func TestParseOTP_PicksShortestItinerary(t *testing.T) {
	env := map[string]any{
		"source": "opentrip",
		"itineraries": []any{
			map[string]any{"duration_seconds": 3600, "legs": []any{
				map[string]any{"mode": "BUS", "trip_id": "slow", "polyline": samplePolyline},
			}},
			map[string]any{"duration_seconds": 1200, "legs": []any{
				map[string]any{"mode": "BUS", "trip_id": "fast", "polyline": samplePolyline},
			}},
		},
	}
	raw, _ := json.Marshal(env)

	route, err := ParseOTP(raw)
	if err != nil {
		t.Fatalf("ParseOTP: %v", err)
	}
	if route.DurationS != 1200 {
		t.Errorf("picked DurationS = %d, want the 1200 itinerary", route.DurationS)
	}
	if route.Legs[0].TripID != "fast" {
		t.Errorf("picked trip = %q, want fast", route.Legs[0].TripID)
	}
}

func TestBestOTPWithRaw_EchoCarriesSourceAndOneItinerary(t *testing.T) {
	env := map[string]any{
		"source": "opentrip",
		"itineraries": []any{
			map[string]any{"duration_seconds": 3600, "legs": []any{map[string]any{"mode": "BUS", "trip_id": "slow"}}},
			map[string]any{"duration_seconds": 1200, "legs": []any{map[string]any{"mode": "BUS", "trip_id": "fast"}}},
		},
	}
	raw, _ := json.Marshal(env)

	_, echo, err := BestOTPWithRaw(raw)
	if err != nil {
		t.Fatalf("BestOTPWithRaw: %v", err)
	}
	var decoded struct {
		Source      string            `json:"source"`
		Itineraries []json.RawMessage `json:"itineraries"`
	}
	if err := json.Unmarshal(echo, &decoded); err != nil {
		t.Fatalf("decode echo: %v", err)
	}
	if decoded.Source != "opentrip" {
		t.Errorf("echo source = %q, want opentrip (tag intact)", decoded.Source)
	}
	if len(decoded.Itineraries) != 1 {
		t.Fatalf("echo itineraries = %d, want 1 (chosen only)", len(decoded.Itineraries))
	}
	if !strings.Contains(string(decoded.Itineraries[0]), "fast") {
		t.Errorf("echo itinerary is not the chosen (fast) one: %s", decoded.Itineraries[0])
	}
}

func TestParseOTP_AcceptsBareItinerary(t *testing.T) {
	bare := map[string]any{
		"duration_seconds": 900,
		"legs":             []any{map[string]any{"mode": "BUS", "trip_id": "z", "polyline": samplePolyline}},
	}
	raw, _ := json.Marshal(bare)

	route, err := ParseOTP(raw)
	if err != nil {
		t.Fatalf("ParseOTP(bare): %v", err)
	}
	if len(route.Legs) != 1 || route.Legs[0].TripID != "z" {
		t.Fatalf("bare itinerary not parsed: %+v", route.Legs)
	}
}

func assertClose(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-3 {
		t.Errorf("%s = %v, want ~%v", name, got, want)
	}
}
