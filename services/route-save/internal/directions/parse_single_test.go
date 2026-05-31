package directions

import (
	"os"
	"testing"
)

func TestParseSingle_StartBody(t *testing.T) {
	raw, err := os.ReadFile("../../testdata/route_single.json")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	route, err := ParseSingle(raw)
	if err != nil {
		t.Fatalf("ParseSingle: %v", err)
	}
	// WALK, BUS, WALK.
	if len(route.Legs) != 3 {
		t.Fatalf("legs = %d, want 3: %+v", len(route.Legs), route.Legs)
	}
	bus := route.Legs[1]
	if bus.Mode != ModeBus || bus.RouteID != "2" {
		t.Errorf("bus leg = %+v, want BUS route 2", bus)
	}
	if bus.Entry.Name != "WB 6 Av SW @ 3 St SW" {
		t.Errorf("entry = %q", bus.Entry.Name)
	}
}
