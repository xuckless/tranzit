package trip

import (
	"testing"

	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
)

// TestBuildTrip_OTPSkipsResolution proves the OTP path windows stops straight from
// the resolved trip_id: the fixture has TripStops but NO TripsByRoute, so any call
// into ResolveLeg's candidate scan (CandidateTrips) would error. A clean build
// confirms resolution was skipped and stops were windowed by the OTP-supplied ids.
func TestBuildTrip_OTPSkipsResolution(t *testing.T) {
	entry := geo.LatLng{Lat: 51.045, Lng: -114.07}
	mid := geo.LatLng{Lat: 51.050, Lng: -114.08}
	exit := geo.LatLng{Lat: 51.055, Lng: -114.09}

	f := datasource.NewFixture()
	// Note: no f.TripsByRoute — CandidateTrips would fail if reached.
	f.StopsByTrip["TRIP-OTP"] = []datasource.Stop{
		{StopID: "before", Name: "Before", Loc: geo.LatLng{Lat: 51.040, Lng: -114.06}, Sequence: 1, ArrivalTime: 50},
		{StopID: "e", Name: "Entry", Loc: entry, Sequence: 2, ArrivalTime: 100, DepartureTime: 100},
		{StopID: "m", Name: "Mid", Loc: mid, Sequence: 3, ArrivalTime: 200},
		{StopID: "x", Name: "Exit", Loc: exit, Sequence: 4, ArrivalTime: 300},
		{StopID: "after", Name: "After", Loc: geo.LatLng{Lat: 51.060, Lng: -114.10}, Sequence: 5, ArrivalTime: 400},
	}

	route := directions.Route{
		Legs: []directions.ParsedLeg{
			{Mode: directions.ModeWalk},
			{
				Mode:        directions.ModeBus,
				RouteID:     "2",
				TripID:      "TRIP-OTP",
				EntryStopID: "e",
				ExitStopID:  "x",
				Entry:       &directions.StopEndpoint{Name: "Entry", Loc: entry, TimeEpoch: 100},
				Exit:        &directions.StopEndpoint{Name: "Exit", Loc: exit, TimeEpoch: 300},
			},
			{Mode: directions.ModeWalk},
		},
	}

	// now=9_999_999_999 (far future): the OTP path ignores the departed-floor, so a
	// build that succeeds also confirms ResolveTrip's now-filter was bypassed.
	ts, err := BuildTrip("sess", entry, exit, route, f, 9_999_999_999)
	if err != nil {
		t.Fatalf("BuildTrip(otp): %v", err)
	}

	// Windowed to e..x inclusive (3 stops), dropping the before/after stops.
	if len(ts.Stops) != 3 {
		t.Fatalf("stops = %d, want 3 (e,m,x windowed by stop_id)", len(ts.Stops))
	}
	if ts.Stops[0].StopID != "e" || ts.Stops[2].StopID != "x" {
		t.Errorf("window = %s..%s, want e..x", ts.Stops[0].StopID, ts.Stops[2].StopID)
	}
	if ts.Stops[0].StopType != Fetched {
		t.Errorf("boarding stop type = %s, want FETCHED", ts.Stops[0].StopType)
	}
	if ts.Stops[1].StopType != Transfer || ts.Stops[2].StopType != Transfer {
		t.Error("ride-through/exit stops should be TRANSFER")
	}
	if ts.Stops[0].TripID != "TRIP-OTP" {
		t.Errorf("trip_id = %q, want TRIP-OTP (OTP-supplied)", ts.Stops[0].TripID)
	}
	if got := ts.Legs[1]; got.Mode != ModeBus || got.TripID != "TRIP-OTP" {
		t.Errorf("bus leg = %+v, want OTP trip", got)
	}
}

// TestBuildTrip_OTPFallsBackToCoords covers an OTP leg whose stop_ids don't line up
// with the catalog (feed-prefix / id-scheme drift): windowing falls back to the
// polyline-derived entry/exit coordinates rather than failing the build.
func TestBuildTrip_OTPFallsBackToCoords(t *testing.T) {
	entry := geo.LatLng{Lat: 51.045, Lng: -114.07}
	exit := geo.LatLng{Lat: 51.055, Lng: -114.09}

	f := datasource.NewFixture()
	f.StopsByTrip["TRIP-OTP"] = []datasource.Stop{
		{StopID: "catalog-e", Name: "Entry", Loc: entry, Sequence: 1, ArrivalTime: 100, DepartureTime: 100},
		{StopID: "catalog-x", Name: "Exit", Loc: exit, Sequence: 2, ArrivalTime: 300},
	}

	route := directions.Route{
		Legs: []directions.ParsedLeg{{
			Mode:        directions.ModeBus,
			RouteID:     "2",
			TripID:      "TRIP-OTP",
			EntryStopID: "otp-e", // not in the catalog
			ExitStopID:  "otp-x",
			Entry:       &directions.StopEndpoint{Name: "Entry", Loc: entry, TimeEpoch: 100},
			Exit:        &directions.StopEndpoint{Name: "Exit", Loc: exit, TimeEpoch: 300},
		}},
	}

	ts, err := BuildTrip("sess", entry, exit, route, f, 0)
	if err != nil {
		t.Fatalf("BuildTrip(otp coord fallback): %v", err)
	}
	if len(ts.Stops) != 2 {
		t.Fatalf("stops = %d, want 2 (windowed by coords)", len(ts.Stops))
	}
	if ts.Stops[0].StopID != "catalog-e" {
		t.Errorf("entry = %q, want catalog-e (coord match)", ts.Stops[0].StopID)
	}
}
