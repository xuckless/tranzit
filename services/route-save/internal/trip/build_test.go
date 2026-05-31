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

	ts, err := BuildTrip("sess", entry, exit, route, f)
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
}
