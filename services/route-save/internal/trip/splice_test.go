package trip

import (
	"testing"

	"github.com/tranzit-route-save/internal/geo"
)

func TestSplice_KeepsPrefixAndRebases(t *testing.T) {
	mk := func(id string) StopRecord { return StopRecord{StopID: id, Status: StatusExpected} }
	ts := &TripState{
		SessionID:        "s",
		Stops:            []StopRecord{mk("a"), mk("b"), mk("c")},
		Legs:             []Leg{{LegIndex: 0, Mode: ModeBus, RouteID: "2", TripID: "T1", StopStart: 0, StopEnd: 3}},
		CurrentStopIndex: 0,
		StateVersion:     5,
	}

	newTrip := &TripState{
		Stops: []StopRecord{mk("x"), mk("y")},
		Legs:  []Leg{{LegIndex: 0, Mode: ModeBus, RouteID: "9", TripID: "T2", StopStart: 0, StopEnd: 2}},
	}

	// Keep only stop "a" (index 0); replace the rest.
	Splice(ts, 0, newTrip)

	wantIDs := []string{"a", "x", "y"}
	if len(ts.Stops) != len(wantIDs) {
		t.Fatalf("stops = %d, want %d", len(ts.Stops), len(wantIDs))
	}
	for i, id := range wantIDs {
		if ts.Stops[i].StopID != id {
			t.Errorf("stop %d = %q, want %q", i, ts.Stops[i].StopID, id)
		}
	}

	if len(ts.Legs) != 2 {
		t.Fatalf("legs = %d, want 2", len(ts.Legs))
	}
	// Kept bus leg clamped to the prefix.
	if ts.Legs[0].StopEnd != 1 {
		t.Errorf("kept leg StopEnd = %d, want 1 (clamped)", ts.Legs[0].StopEnd)
	}
	// New leg rebased onto the prefix.
	nl := ts.Legs[1]
	if nl.LegIndex != 1 || nl.TripID != "T2" || nl.StopStart != 1 || nl.StopEnd != 3 {
		t.Errorf("new leg = %+v, want index 1 trip T2 stops[1:3]", nl)
	}
	if ts.StateVersion != 6 {
		t.Errorf("StateVersion = %d, want 6 (bumped)", ts.StateVersion)
	}
}

// TestSplice_RetainsWalkEndpoints checks that a kept leading walk leg and an
// appended trailing walk leg carry their endpoints through the splice.
func TestSplice_RetainsWalkEndpoints(t *testing.T) {
	mk := func(id string) StopRecord { return StopRecord{StopID: id, Status: StatusExpected} }
	keptWalkFrom := geo.LatLng{Lat: 51.0, Lng: -114.0}
	keptWalkTo := geo.LatLng{Lat: 51.1, Lng: -114.1}
	ts := &TripState{
		Stops: []StopRecord{mk("a"), mk("b")},
		Legs: []Leg{
			{LegIndex: 0, Mode: ModeWalk, StopStart: 0, StopEnd: 0, WalkFrom: keptWalkFrom, WalkTo: keptWalkTo},
			{LegIndex: 1, Mode: ModeBus, RouteID: "2", TripID: "T1", StopStart: 0, StopEnd: 2},
		},
		CurrentStopIndex: 0,
	}

	newWalkFrom := geo.LatLng{Lat: 51.2, Lng: -114.2}
	newWalkTo := geo.LatLng{Lat: 51.3, Lng: -114.3}
	newTrip := &TripState{
		Stops: []StopRecord{mk("x")},
		Legs: []Leg{
			{LegIndex: 0, Mode: ModeBus, RouteID: "9", TripID: "T2", StopStart: 0, StopEnd: 1},
			{LegIndex: 1, Mode: ModeWalk, StopStart: 1, StopEnd: 1, WalkFrom: newWalkFrom, WalkTo: newWalkTo},
		},
	}

	Splice(ts, 0, newTrip) // keep stop "a"; the leading walk leg falls in the kept region

	if ts.Legs[0].Mode != ModeWalk || ts.Legs[0].WalkFrom != keptWalkFrom || ts.Legs[0].WalkTo != keptWalkTo {
		t.Errorf("kept walk leg endpoints lost: %+v", ts.Legs[0])
	}
	last := ts.Legs[len(ts.Legs)-1]
	if last.Mode != ModeWalk || last.WalkFrom != newWalkFrom || last.WalkTo != newWalkTo {
		t.Errorf("appended walk leg endpoints lost: %+v", last)
	}
}
