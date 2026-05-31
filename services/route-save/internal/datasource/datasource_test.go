package datasource

import (
	"testing"

	"github.com/tranzit-route-save/internal/geo"
)

// A stop location used as the rider's entry point; candidate trips each have a
// stop right here, differing only in predicted departure time.
var entryLoc = geo.LatLng{Lat: 51.0477, Lng: -114.0708}
var exitLoc = geo.LatLng{Lat: 51.0379, Lng: -114.0897}

func tripAt(id string, entryDep int64) TripCandidate {
	return TripCandidate{
		TripID: id,
		Stops: []Stop{
			{StopID: id + "-a", Loc: entryLoc, Sequence: 1, DepartureTime: entryDep, ArrivalTime: entryDep},
			{StopID: id + "-b", Loc: exitLoc, Sequence: 2, ArrivalTime: entryDep + 600},
		},
	}
}

func TestResolveTrip_PicksNearestDeparture(t *testing.T) {
	const base = 1_700_000_000
	f := NewFixture()
	// ~5 min headway: three runs at base-300, base, base+300.
	f.TripsByRoute["2"] = []TripCandidate{
		tripAt("early", base-300),
		tripAt("onTime", base),
		tripAt("late", base+300),
	}

	got, err := ResolveTrip(f, entryLoc, exitLoc, "2", base+40) // ETA closest to onTime
	if err != nil {
		t.Fatalf("ResolveTrip: %v", err)
	}
	if got != "onTime" {
		t.Errorf("resolved %q, want onTime", got)
	}
}

// A route runs both directions under one route_id. The wrong-direction trip
// (exit before entry in its sequence) must be rejected even if its entry time
// matches better.
func TestResolveTrip_RejectsWrongDirection(t *testing.T) {
	const base = 1_700_000_000
	f := NewFixture()
	// Eastbound: entry (seq1) then exit (seq2) — the correct trip.
	eb := TripCandidate{TripID: "eastbound", Stops: []Stop{
		{StopID: "e1", Loc: entryLoc, Sequence: 1, DepartureTime: base + 100, ArrivalTime: base + 100},
		{StopID: "e2", Loc: exitLoc, Sequence: 2, ArrivalTime: base + 700},
	}}
	// Westbound: same physical stops but reversed sequence; entry time is a
	// closer match to the Google ETA, so a direction-blind resolver would pick it.
	wb := TripCandidate{TripID: "westbound", Stops: []Stop{
		{StopID: "w1", Loc: exitLoc, Sequence: 1, DepartureTime: base, ArrivalTime: base},
		{StopID: "w2", Loc: entryLoc, Sequence: 2, DepartureTime: base + 10, ArrivalTime: base + 10},
	}}
	f.TripsByRoute["303"] = []TripCandidate{wb, eb}

	got, err := ResolveTrip(f, entryLoc, exitLoc, "303", base) // ETA nearest westbound
	if err != nil {
		t.Fatalf("ResolveTrip: %v", err)
	}
	if got != "eastbound" {
		t.Errorf("resolved %q, want eastbound (wrong-direction trip must be rejected)", got)
	}
}

// Documents the §5.2 high-frequency edge: a Google ETA off by more than the
// headway matches the adjacent run ("right route, wrong trip").
func TestResolveTrip_AdjacentRunEdge(t *testing.T) {
	const base = 1_700_000_000
	f := NewFixture()
	f.TripsByRoute["2"] = []TripCandidate{
		tripAt("onTime", base),
		tripAt("late", base+300),
	}

	got, err := ResolveTrip(f, entryLoc, exitLoc, "2", base+200) // past the midpoint
	if err != nil {
		t.Fatalf("ResolveTrip: %v", err)
	}
	if got != "late" {
		t.Errorf("resolved %q, want late (adjacent-run edge)", got)
	}
}

func TestResolveTrip_NoServingTrip(t *testing.T) {
	f := NewFixture()
	// Candidate exists but its stops are far from entryLoc.
	far := geo.LatLng{Lat: 51.20, Lng: -114.30}
	f.TripsByRoute["2"] = []TripCandidate{{
		TripID: "elsewhere",
		Stops:  []Stop{{StopID: "x", Loc: far, Sequence: 1, DepartureTime: 1}},
	}}
	if _, err := ResolveTrip(f, entryLoc, exitLoc, "2", 1); err == nil {
		t.Fatal("expected error when no trip serves the entry stop")
	}
}

func TestLoadLegStops_FiltersEntryToExit(t *testing.T) {
	// Six stops along a corridor; rider boards at index 1, alights at index 4.
	mk := func(seq int, lat float64) Stop {
		return Stop{StopID: "s", Loc: geo.LatLng{Lat: lat, Lng: -114.07}, Sequence: seq}
	}
	stops := []Stop{
		mk(1, 51.040),
		mk(2, 51.045), // entry
		mk(3, 51.050),
		mk(4, 51.055),
		mk(5, 51.060), // exit
		mk(6, 51.065),
	}
	f := NewFixture()
	f.StopsByTrip["T"] = stops

	entry := geo.LatLng{Lat: 51.045, Lng: -114.07}
	exit := geo.LatLng{Lat: 51.060, Lng: -114.07}
	got, err := LoadLegStops(f, "T", entry, exit)
	if err != nil {
		t.Fatalf("LoadLegStops: %v", err)
	}
	if len(got) != 4 {
		t.Fatalf("window len = %d, want 4 (seq 2..5)", len(got))
	}
	if got[0].Sequence != 2 || got[3].Sequence != 5 {
		t.Errorf("window = seq %d..%d, want 2..5", got[0].Sequence, got[3].Sequence)
	}
}

func TestParsePointWKT(t *testing.T) {
	// WKT is lng-lat (§2): POINT(lon lat).
	loc, ok := parsePointWKT("POINT(-114.0708 51.0477)")
	if !ok {
		t.Fatal("parse failed")
	}
	if loc.Lat != 51.0477 || loc.Lng != -114.0708 {
		t.Errorf("got %+v, want lat 51.0477 lng -114.0708", loc)
	}
}
