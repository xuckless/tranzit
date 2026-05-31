package session

import (
	"context"
	"testing"

	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
	"github.com/tranzit-route-save/internal/routeclient"
	"github.com/tranzit-route-save/internal/rtfeed"
	"github.com/tranzit-route-save/internal/state"
	"github.com/tranzit-route-save/internal/trip"
)

// buildFixtureTrip returns a one-bus-leg trip plus the fixture and the route that
// resolves it (reused as the reroute target).
func buildFixtureTrip(t *testing.T) (*trip.TripState, *datasource.Fixture, directions.Route) {
	t.Helper()
	entry := geo.LatLng{Lat: 51.045, Lng: -114.07}
	exit := geo.LatLng{Lat: 51.055, Lng: -114.09}

	fx := datasource.NewFixture()
	stops := []datasource.Stop{
		{StopID: "e", Name: "Entry", Loc: entry, Sequence: 1, ArrivalTime: 1000, DepartureTime: 1000},
		{StopID: "x", Name: "Exit", Loc: exit, Sequence: 2, ArrivalTime: 1000},
	}
	fx.StopsByTrip["T"] = stops
	fx.TripsByRoute["2"] = []datasource.TripCandidate{{TripID: "T", Stops: stops}}

	route := directions.Route{Legs: []directions.ParsedLeg{{
		Mode:    directions.ModeBus,
		RouteID: "2",
		Entry:   &directions.StopEndpoint{Name: "Entry", Loc: entry, TimeEpoch: 1000},
		Exit:    &directions.StopEndpoint{Name: "Exit", Loc: exit, TimeEpoch: 1000},
	}}}

	ts, err := trip.BuildTrip("sess", entry, exit, route, fx)
	if err != nil {
		t.Fatalf("BuildTrip: %v", err)
	}
	return ts, fx, route
}

func TestReroute_MissedSplices(t *testing.T) {
	ts, fx, route := buildFixtureTrip(t)
	clk := &state.FakeClock{T: 1000}
	routeFake := &routeclient.Fake{Result: route}
	deps := Deps{Data: fx, RT: &rtfeed.Fake{}, Routes: routeFake, Clock: clk}
	s := newSession(ts, "place-123", deps, NewManager(deps))

	// Far from the boarding stop and armed → MISSED → onMissed records a reroute.
	s.machine.OnLocationUpdate(trip.UserLocation{Loc: geo.LatLng{Lat: 51.20, Lng: -114.30}})
	s.machine.OnTick()

	if ts.Stops[0].Status != trip.StatusMissed {
		t.Fatalf("boarding status = %s, want MISSED", ts.Stops[0].Status)
	}
	if s.pending == nil {
		t.Fatal("expected a pending reroute")
	}

	// Drive the async reroute path deterministically.
	req := *s.pending
	s.pending = nil
	prevVersion := ts.StateVersion
	s.fetchReroute(req, ts.SessionID, ts.Destination)
	res := <-s.rerouteOut
	if res.err != nil {
		t.Fatalf("reroute fetch: %v", res.err)
	}
	s.applyReroute(res)

	if routeFake.Calls != 1 {
		t.Errorf("route calls = %d, want 1", routeFake.Calls)
	}
	if ts.StateVersion <= prevVersion {
		t.Errorf("StateVersion not bumped (%d)", ts.StateVersion)
	}
	// Case 2: everything replaced; rider re-enters at the new boarding stop.
	if ts.CurrentStopIndex != 0 {
		t.Errorf("index = %d, want 0", ts.CurrentStopIndex)
	}
	if ts.Stops[0].StopType != trip.Fetched {
		t.Errorf("new stop 0 type = %s, want FETCHED", ts.Stops[0].StopType)
	}

	// A REROUTE and a STATE frame should be queued for the client.
	if len(s.send) < 2 {
		t.Errorf("queued frames = %d, want >= 2 (REROUTE + STATE)", len(s.send))
	}
}

// TestReroute_OriginIsUserLocation pins the core contract: an off-bus (Case 2)
// reroute must fetch the new route from the rider's live GPS fix, not the stop.
func TestReroute_OriginIsUserLocation(t *testing.T) {
	ts, fx, route := buildFixtureTrip(t)
	clk := &state.FakeClock{T: 1000}

	var gotOrigin geo.LatLng
	routeFake := &routeclient.Fake{
		RouteFn: func(_ context.Context, origin geo.LatLng, _ string) (directions.Route, error) {
			gotOrigin = origin
			return route, nil
		},
	}
	deps := Deps{Data: fx, RT: &rtfeed.Fake{}, Routes: routeFake, Clock: clk}
	s := newSession(ts, "place-123", deps, NewManager(deps))

	userLoc := geo.LatLng{Lat: 51.20, Lng: -114.30}
	s.machine.OnLocationUpdate(trip.UserLocation{Loc: userLoc})
	s.machine.OnTick() // armed + far → MISSED → pending reroute (Case 2)

	if s.pending == nil {
		t.Fatal("expected a pending reroute")
	}
	req := *s.pending
	if req.onBus {
		t.Fatalf("expected Case 2 (off bus), got onBus=true")
	}
	s.fetchReroute(req, ts.SessionID, ts.Destination)
	<-s.rerouteOut

	if gotOrigin != userLoc {
		t.Errorf("reroute origin = %+v, want the user's fix %+v", gotOrigin, userLoc)
	}
}
