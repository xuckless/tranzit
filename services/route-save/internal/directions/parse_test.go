package directions

import (
	"os"
	"strings"
	"testing"
	"time"
)

func loadSample(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/route_sample.json")
	if err != nil {
		t.Fatalf("read sample: %v", err)
	}
	return raw
}

func TestParse_AllAlternatives(t *testing.T) {
	routes, err := Parse(loadSample(t))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(routes) != 2 {
		t.Fatalf("got %d routes, want 2", len(routes))
	}
}

func TestBest_SingleBusLeg(t *testing.T) {
	route, err := Best(loadSample(t))
	if err != nil {
		t.Fatalf("Best: %v", err)
	}
	// Shortest duration is the route-2 alternative (1264s < 1275s).
	if route.DurationS != 1264 {
		t.Errorf("DurationS = %d, want 1264", route.DurationS)
	}

	// Expect: WALK, BUS, WALK.
	wantModes := []Mode{ModeWalk, ModeBus, ModeWalk}
	if len(route.Legs) != len(wantModes) {
		t.Fatalf("got %d legs, want %d: %+v", len(route.Legs), len(wantModes), route.Legs)
	}
	for i, m := range wantModes {
		if route.Legs[i].Mode != m {
			t.Errorf("leg %d mode = %s, want %s", i, route.Legs[i].Mode, m)
		}
	}

	bus := route.Legs[1]
	if bus.RouteID != "2" {
		t.Errorf("route_id = %q, want %q", bus.RouteID, "2")
	}
	if bus.Entry.Name != "WB 6 Av SW @ 3 St SW" {
		t.Errorf("entry name = %q", bus.Entry.Name)
	}
	if bus.Exit.Name != "WB 17 AV SW @ 11 ST SW fs" {
		t.Errorf("exit name = %q", bus.Exit.Name)
	}

	wantDep, _ := time.Parse(time.RFC3339, "2026-05-31T02:08:58Z")
	if bus.Entry.TimeEpoch != wantDep.Unix() {
		t.Errorf("entry epoch = %d, want %d", bus.Entry.TimeEpoch, wantDep.Unix())
	}
	if bus.Entry.Loc.Lat == 0 || bus.Entry.Loc.Lng == 0 {
		t.Errorf("entry loc not parsed: %+v", bus.Entry.Loc)
	}
}

func TestBestWithRaw_ReturnsChosenRouteJSON(t *testing.T) {
	route, raw, err := BestWithRaw(loadSample(t))
	if err != nil {
		t.Fatalf("BestWithRaw: %v", err)
	}
	// Same selection as Best: the 1264s alternative.
	if route.DurationS != 1264 {
		t.Errorf("DurationS = %d, want 1264", route.DurationS)
	}
	// raw is the chosen route object (not the {routes:[…]} wrapper) and round-trips
	// back to the same parsed route.
	if !strings.Contains(string(raw), `"1264s"`) {
		t.Errorf("raw does not carry the chosen route's duration: %s", raw)
	}
	again, err := ParseSingle(raw)
	if err != nil {
		t.Fatalf("ParseSingle(raw): %v", err)
	}
	if again.DurationS != route.DurationS || len(again.Legs) != len(route.Legs) {
		t.Errorf("raw re-parse mismatch: %d/%d legs vs %d/%d", again.DurationS, len(again.Legs), route.DurationS, len(route.Legs))
	}
}
