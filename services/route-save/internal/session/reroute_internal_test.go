package session

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
	"github.com/tranzit-route-save/internal/routeclient"
	"github.com/tranzit-route-save/internal/rtfeed"
	"github.com/tranzit-route-save/internal/state"
	"github.com/tranzit-route-save/internal/trip"
	"github.com/tranzit-route-save/internal/wsproto"
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

	ts, err := trip.BuildTrip("sess", entry, exit, route, fx, 0) // now=0: candidate times are eligible
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
	s := newSession(ts, sessionConfig{destPlaceID: "place-123"}, deps, NewManager(deps))

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
		RouteFn: func(_ context.Context, origin geo.LatLng, _ string) (directions.Route, json.RawMessage, error) {
			gotOrigin = origin
			return route, nil, nil
		},
	}
	deps := Deps{Data: fx, RT: &rtfeed.Fake{}, Routes: routeFake, Clock: clk}
	s := newSession(ts, sessionConfig{destPlaceID: "place-123"}, deps, NewManager(deps))

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

// TestReroute_NoGPS_OriginIsPlannedStop covers the timer-driven path with GPS
// silent: armed with no fix the boarding stop goes UNSURE; the rider answers
// "didn't board", which resolves to MISSED. With no fresh fix the reroute must
// originate from the planned (missed) stop, and the REROUTE frame must echo the
// raw Google route for the client to re-render.
func TestReroute_NoGPS_OriginIsPlannedStop(t *testing.T) {
	ts, fx, route := buildFixtureTrip(t)
	clk := &state.FakeClock{T: 1000}

	var gotOrigin geo.LatLng
	rawRoute := json.RawMessage(`{"distanceMeters":4321}`)
	routeFake := &routeclient.Fake{
		RouteFn: func(_ context.Context, origin geo.LatLng, _ string) (directions.Route, json.RawMessage, error) {
			gotOrigin = origin
			return route, rawRoute, nil
		},
	}
	deps := Deps{Data: fx, RT: &rtfeed.Fake{}, Routes: routeFake, Clock: clk}
	s := newSession(ts, sessionConfig{destPlaceID: "place-123"}, deps, NewManager(deps))

	// Armed with no fix -> UNSURE (timer-driven, GPS silent).
	s.machine.OnTick()
	if ts.Stops[0].Status != trip.StatusUnsure {
		t.Fatalf("boarding status = %s, want UNSURE with no fix", ts.Stops[0].Status)
	}

	boardingID := ts.Stops[0].StopID
	plannedLoc := ts.Stops[0].Loc()
	if !s.machine.ResolveUnsure(boardingID, false) {
		t.Fatal("ResolveUnsure(false) should resolve the UNSURE stop")
	}
	if s.pending == nil {
		t.Fatal("expected a pending reroute after the not-boarded answer")
	}

	req := *s.pending
	s.pending = nil
	if req.onBus {
		t.Fatalf("expected Case 2 (off bus), got onBus=true")
	}
	s.fetchReroute(req, ts.SessionID, ts.Destination)
	s.applyReroute(<-s.rerouteOut)

	if gotOrigin != plannedLoc {
		t.Errorf("reroute origin = %+v, want the planned stop %+v", gotOrigin, plannedLoc)
	}

	rr := drainReroute(t, s)
	if string(rr.Route) != string(rawRoute) {
		t.Errorf("REROUTE.route = %s, want %s", rr.Route, rawRoute)
	}
	if rr.From.Lat != plannedLoc.Lat || rr.From.Lng != plannedLoc.Lng {
		t.Errorf("REROUTE.from = %+v, want planned stop %+v", rr.From, plannedLoc)
	}
}

// TestReroute_OTPUsesCoordsClient pins the OTP reroute contract: an OTP session
// reroutes through the OTP coords client (not the Google place-ID client) and targets
// the destination coordinates on the trip, echoing the OTP envelope downstream.
func TestReroute_OTPUsesCoordsClient(t *testing.T) {
	entry := geo.LatLng{Lat: 51.045, Lng: -114.07}
	exit := geo.LatLng{Lat: 51.055, Lng: -114.09}

	fx := datasource.NewFixture()
	fx.StopsByTrip["T"] = []datasource.Stop{
		{StopID: "e", Name: "Entry", Loc: entry, Sequence: 1, ArrivalTime: 1000, DepartureTime: 1000},
		{StopID: "x", Name: "Exit", Loc: exit, Sequence: 2, ArrivalTime: 1000},
	}

	otpRoute := directions.Route{Legs: []directions.ParsedLeg{{
		Mode: directions.ModeBus, RouteID: "2", TripID: "T", EntryStopID: "e", ExitStopID: "x",
		Entry: &directions.StopEndpoint{Name: "Entry", Loc: entry, TimeEpoch: 1000},
		Exit:  &directions.StopEndpoint{Name: "Exit", Loc: exit, TimeEpoch: 1000},
	}}}

	ts, err := trip.BuildTrip("sess", entry, exit, otpRoute, fx, 0)
	if err != nil {
		t.Fatalf("BuildTrip: %v", err)
	}
	ts.Destination = geo.LatLng{Lat: 51.07, Lng: -114.12} // the coords reroutes target

	clk := &state.FakeClock{T: 1000}
	var gotDest geo.LatLng
	otpRaw := json.RawMessage(`{"source":"opentrip","itineraries":[{"duration_seconds":1}]}`)
	otpFake := &routeclient.OTPFake{
		RouteFn: func(_ context.Context, _, dest geo.LatLng, _ string, _ int) (directions.Route, json.RawMessage, error) {
			gotDest = dest
			return otpRoute, otpRaw, nil
		},
	}
	// Note: no Routes (Google) client wired — an OTP session must not need it.
	deps := Deps{Data: fx, RT: &rtfeed.Fake{}, OTPRoutes: otpFake, Clock: clk}
	s := newSession(ts, sessionConfig{isOTP: true, otpMode: "walk_transit", otpNum: 5}, deps, NewManager(deps))

	s.machine.OnLocationUpdate(trip.UserLocation{Loc: geo.LatLng{Lat: 51.20, Lng: -114.30}})
	s.machine.OnTick() // far + armed → MISSED → pending reroute (Case 2)
	if s.pending == nil {
		t.Fatal("expected a pending reroute")
	}

	req := *s.pending
	s.pending = nil
	s.fetchReroute(req, ts.SessionID, ts.Destination)
	res := <-s.rerouteOut
	if res.err != nil {
		t.Fatalf("reroute fetch: %v", res.err)
	}
	s.applyReroute(res)

	if otpFake.Calls != 1 {
		t.Errorf("otp client calls = %d, want 1", otpFake.Calls)
	}
	if gotDest != ts.Destination {
		t.Errorf("reroute dest = %+v, want the trip destination coords %+v", gotDest, ts.Destination)
	}
	rr := drainReroute(t, s)
	if string(rr.Route) != string(otpRaw) {
		t.Errorf("REROUTE.route = %s, want the OTP envelope %s", rr.Route, otpRaw)
	}
}

// drainReroute pops queued frames and returns the first REROUTE.
func drainReroute(t *testing.T, s *Session) wsproto.RerouteMsg {
	t.Helper()
	for {
		select {
		case raw := <-s.send:
			if typ, _ := wsproto.DecodeType(raw); typ == wsproto.TypeReroute {
				var rr wsproto.RerouteMsg
				if err := json.Unmarshal(raw, &rr); err != nil {
					t.Fatalf("decode REROUTE: %v", err)
				}
				return rr
			}
		default:
			t.Fatal("no REROUTE frame queued")
		}
	}
}
