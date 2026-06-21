package trip

import (
	"testing"

	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
)

func TestBuildTrip_ClassifiesAndStructures(t *testing.T) {
	entry := geo.LatLng{Lat: 51.045, Lng: -114.07}
	mid := geo.LatLng{Lat: 51.050, Lng: -114.08}
	exit := geo.LatLng{Lat: 51.055, Lng: -114.09}

	f := datasource.NewFixture()
	stops := []datasource.Stop{
		{StopID: "e", Name: "Entry", Loc: entry, Sequence: 1, ArrivalTime: 100, DepartureTime: 100},
		{StopID: "m", Name: "Mid", Loc: mid, Sequence: 2, ArrivalTime: 200},
		{StopID: "x", Name: "Exit", Loc: exit, Sequence: 3, ArrivalTime: 300},
	}
	f.StopsByTrip["T"] = stops
	f.TripsByRoute["2"] = []datasource.TripCandidate{{TripID: "T", Stops: stops}}

	route := directions.Route{
		Legs: []directions.ParsedLeg{
			{Mode: directions.ModeWalk},
			{
				Mode:    directions.ModeBus,
				RouteID: "2",
				Entry:   &directions.StopEndpoint{Name: "Entry", Loc: entry, TimeEpoch: 100},
				Exit:    &directions.StopEndpoint{Name: "Exit", Loc: exit, TimeEpoch: 300},
			},
			{Mode: directions.ModeWalk},
		},
	}

	ts, err := BuildTrip("sess", entry, exit, route, f, 0) // now=0: candidate times are eligible
	if err != nil {
		t.Fatalf("BuildTrip: %v", err)
	}

	if len(ts.Legs) != 3 {
		t.Fatalf("legs = %d, want 3", len(ts.Legs))
	}
	if len(ts.Stops) != 3 {
		t.Fatalf("stops = %d, want 3", len(ts.Stops))
	}

	// Only the boarding stop is FETCHED.
	if ts.Stops[0].StopType != Fetched {
		t.Errorf("stop 0 type = %s, want FETCHED", ts.Stops[0].StopType)
	}
	for i := 1; i < 3; i++ {
		if ts.Stops[i].StopType != Transfer {
			t.Errorf("stop %d type = %s, want TRANSFER", i, ts.Stops[i].StopType)
		}
	}

	// Boarding stop carries the Google ETA fallback; RT arrival populated.
	if ts.Stops[0].UserArrivalTime != 100 {
		t.Errorf("boarding UserArrivalTime = %d, want 100", ts.Stops[0].UserArrivalTime)
	}
	if ts.Stops[2].BusArrivalTime != 300 {
		t.Errorf("exit BusArrivalTime = %d, want 300", ts.Stops[2].BusArrivalTime)
	}

	// The bus leg references the stop window; walk legs are empty.
	bus := ts.Legs[1]
	if bus.Mode != ModeBus || bus.TripID != "T" || bus.StopStart != 0 || bus.StopEnd != 3 {
		t.Errorf("bus leg = %+v", bus)
	}
	if ts.Legs[0].StopStart != ts.Legs[0].StopEnd {
		t.Errorf("walk leg 0 should be empty, got [%d:%d]", ts.Legs[0].StopStart, ts.Legs[0].StopEnd)
	}
	if ts.Legs[2].StopStart != ts.Legs[2].StopEnd {
		t.Errorf("walk leg 2 should be empty, got [%d:%d]", ts.Legs[2].StopStart, ts.Legs[2].StopEnd)
	}

	// Leading walk: origin → first bus entry. Here origin == entry == bus entry.
	if ts.Legs[0].WalkFrom != entry || ts.Legs[0].WalkTo != entry {
		t.Errorf("leading walk endpoints = %+v→%+v, want %+v→%+v",
			ts.Legs[0].WalkFrom, ts.Legs[0].WalkTo, entry, entry)
	}
	// Trailing walk: last bus exit → destination. Here exit == dest == bus exit.
	if ts.Legs[2].WalkFrom != exit || ts.Legs[2].WalkTo != exit {
		t.Errorf("trailing walk endpoints = %+v→%+v, want %+v→%+v",
			ts.Legs[2].WalkFrom, ts.Legs[2].WalkTo, exit, exit)
	}
}

// TestBuildTrip_WalkOnly: a route with no bus legs builds a stop-less trip that is
// accepted (not rejected) and marked ACTIVE for rendering, with the single walk leg
// running origin→destination.
func TestBuildTrip_WalkOnly(t *testing.T) {
	origin := geo.LatLng{Lat: 51.045, Lng: -114.07}
	dest := geo.LatLng{Lat: 51.050, Lng: -114.08}

	f := datasource.NewFixture()
	route := directions.Route{Legs: []directions.ParsedLeg{
		{Mode: directions.ModeWalk},
	}}

	ts, err := BuildTrip("sess", origin, dest, route, f, 0)
	if err != nil {
		t.Fatalf("BuildTrip walk-only: %v", err)
	}
	if len(ts.Stops) != 0 {
		t.Fatalf("stops = %d, want 0", len(ts.Stops))
	}
	if ts.OverallStatus != StatusActive {
		t.Errorf("overall = %s, want ACTIVE", ts.OverallStatus)
	}
	if len(ts.Legs) != 1 || ts.Legs[0].Mode != ModeWalk {
		t.Fatalf("legs = %+v, want one walk leg", ts.Legs)
	}
	if ts.Legs[0].WalkFrom != origin || ts.Legs[0].WalkTo != dest {
		t.Errorf("walk endpoints = %+v→%+v, want %+v→%+v",
			ts.Legs[0].WalkFrom, ts.Legs[0].WalkTo, origin, dest)
	}
}

// TestBuildTrip_BusLegNoStopsErrors: a bus leg that loads no stops is still a hard
// failure — it must not be mistaken for a walk-only trip.
func TestBuildTrip_BusLegNoStopsErrors(t *testing.T) {
	entry := geo.LatLng{Lat: 51.045, Lng: -114.07}
	exit := geo.LatLng{Lat: 51.055, Lng: -114.09}

	f := datasource.NewFixture()
	// Trip "T" resolves but carries no stops.
	f.StopsByTrip["T"] = []datasource.Stop{}
	f.TripsByRoute["2"] = []datasource.TripCandidate{{TripID: "T", Stops: []datasource.Stop{}}}

	route := directions.Route{Legs: []directions.ParsedLeg{
		{Mode: directions.ModeBus, RouteID: "2",
			Entry: &directions.StopEndpoint{Name: "Entry", Loc: entry, TimeEpoch: 100},
			Exit:  &directions.StopEndpoint{Name: "Exit", Loc: exit, TimeEpoch: 300}},
	}}

	if _, err := BuildTrip("sess", entry, exit, route, f, 0); err == nil {
		t.Fatal("BuildTrip: want error for bus leg with no stops, got nil")
	}
}

// TestBuildTrip_WalkEndpointsMultiLeg exercises endpoint derivation with distinct
// coordinates and a transfer walk between two buses: walk → bus1 → walk → bus2 →
// walk. The middle walk must chain bus1's exit to bus2's entry.
func TestBuildTrip_WalkEndpointsMultiLeg(t *testing.T) {
	origin := geo.LatLng{Lat: 51.000, Lng: -114.000}
	b1Entry := geo.LatLng{Lat: 51.010, Lng: -114.010}
	b1Exit := geo.LatLng{Lat: 51.020, Lng: -114.020}
	b2Entry := geo.LatLng{Lat: 51.030, Lng: -114.030}
	b2Exit := geo.LatLng{Lat: 51.040, Lng: -114.040}
	dest := geo.LatLng{Lat: 51.050, Lng: -114.050}

	f := datasource.NewFixture()
	s1 := []datasource.Stop{
		{StopID: "1e", Name: "1Entry", Loc: b1Entry, Sequence: 1, ArrivalTime: 100, DepartureTime: 100},
		{StopID: "1x", Name: "1Exit", Loc: b1Exit, Sequence: 2, ArrivalTime: 200},
	}
	s2 := []datasource.Stop{
		{StopID: "2e", Name: "2Entry", Loc: b2Entry, Sequence: 1, ArrivalTime: 300, DepartureTime: 300},
		{StopID: "2x", Name: "2Exit", Loc: b2Exit, Sequence: 2, ArrivalTime: 400},
	}
	f.StopsByTrip["T1"] = s1
	f.StopsByTrip["T2"] = s2
	f.TripsByRoute["A"] = []datasource.TripCandidate{{TripID: "T1", Stops: s1}}
	f.TripsByRoute["B"] = []datasource.TripCandidate{{TripID: "T2", Stops: s2}}

	route := directions.Route{Legs: []directions.ParsedLeg{
		{Mode: directions.ModeWalk},
		{Mode: directions.ModeBus, RouteID: "A",
			Entry: &directions.StopEndpoint{Name: "1Entry", Loc: b1Entry, TimeEpoch: 100},
			Exit:  &directions.StopEndpoint{Name: "1Exit", Loc: b1Exit, TimeEpoch: 200}},
		{Mode: directions.ModeWalk},
		{Mode: directions.ModeBus, RouteID: "B",
			Entry: &directions.StopEndpoint{Name: "2Entry", Loc: b2Entry, TimeEpoch: 300},
			Exit:  &directions.StopEndpoint{Name: "2Exit", Loc: b2Exit, TimeEpoch: 400}},
		{Mode: directions.ModeWalk},
	}}

	ts, err := BuildTrip("sess", origin, dest, route, f, 0)
	if err != nil {
		t.Fatalf("BuildTrip: %v", err)
	}
	if len(ts.Legs) != 5 {
		t.Fatalf("legs = %d, want 5", len(ts.Legs))
	}

	cases := []struct {
		idx      int
		from, to geo.LatLng
		label    string
	}{
		{0, origin, b1Entry, "leading walk (origin→bus1 entry)"},
		{2, b1Exit, b2Entry, "transfer walk (bus1 exit→bus2 entry)"},
		{4, b2Exit, dest, "trailing walk (bus2 exit→dest)"},
	}
	for _, c := range cases {
		leg := ts.Legs[c.idx]
		if leg.Mode != ModeWalk {
			t.Errorf("%s: leg %d mode = %s, want WALK", c.label, c.idx, leg.Mode)
		}
		if leg.WalkFrom != c.from || leg.WalkTo != c.to {
			t.Errorf("%s: endpoints = %+v→%+v, want %+v→%+v",
				c.label, leg.WalkFrom, leg.WalkTo, c.from, c.to)
		}
	}
}
