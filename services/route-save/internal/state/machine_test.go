package state

import (
	"testing"

	"github.com/tranzit-route-save/internal/geo"
	"github.com/tranzit-route-save/internal/trip"
)

// makeTrip returns a single-bus-leg trip: boarding (FETCHED) + mid + exit
// (TRANSFER), all sharing trip_id "T". busArrival sets every stop's predicted
// arrival so tests can drive TimeRemaining via the clock.
func makeTrip(busArrival int64) *trip.TripState {
	stop := func(id string, typ trip.StopType, lat float64) trip.StopRecord {
		return trip.StopRecord{
			StopID: id, TripID: "T", RouteID: "2", StopType: typ,
			StopLat: lat, StopLng: -114.07, BusArrivalTime: busArrival,
			Status: trip.StatusExpected,
		}
	}
	return &trip.TripState{
		SessionID: "s",
		Stops: []trip.StopRecord{
			stop("board", trip.Fetched, 51.045),
			stop("mid", trip.Transfer, 51.050),
			stop("exit", trip.Transfer, 51.055),
		},
		Legs: []trip.Leg{
			{LegIndex: 0, Mode: trip.ModeBus, RouteID: "2", TripID: "T", StopStart: 0, StopEnd: 3},
		},
		OverallStatus: trip.StatusExpected,
	}
}

type recorder struct{ missed, unsure []int }

func (r *recorder) hooks() Hooks {
	return Hooks{
		OnMissed: func(_ *trip.TripState, idx int) { r.missed = append(r.missed, idx) },
		OnUnsure: func(_ *trip.TripState, idx int) { r.unsure = append(r.unsure, idx) },
	}
}

func TestDelayedBus_NoFalseMissed(t *testing.T) {
	ts := makeTrip(1000)
	ts.Stops[0].UserDistanceM = 100 // far from boarding stop
	clk := &FakeClock{T: 900}       // time_remaining = 100s, not armed
	var rec recorder
	m := New(ts, clk, rec.hooks())

	m.OnTick()
	if got := ts.Stops[0].Status; got != trip.StatusExpected {
		t.Fatalf("status = %s, want EXPECTED before arming", got)
	}

	// Bus is delayed: RT pushes arrival out (goalpost). Advance clock; the
	// trigger should slide with it, never arming while delayed.
	for step := 0; step < 5; step++ {
		clk.Advance(30)
		m.OnRTUpdate([]Arrival{{TripID: "T", StopID: "board", PredictedArrival: clk.Now() + 100}})
		m.OnTick()
	}
	if len(rec.missed) != 0 {
		t.Errorf("delayed bus produced %d MISSED, want 0", len(rec.missed))
	}
	if got := ts.Stops[0].Status; got != trip.StatusExpected {
		t.Errorf("status = %s, want EXPECTED throughout delay", got)
	}
}

func TestArmed_MissedBeyondRadius(t *testing.T) {
	ts := makeTrip(1000)
	ts.Stops[0].UserDistanceM = 100
	clk := &FakeClock{T: 1000} // armed: time_remaining = 0
	var rec recorder
	m := New(ts, clk, rec.hooks())

	m.OnTick()
	if got := ts.Stops[0].Status; got != trip.StatusMissed {
		t.Fatalf("status = %s, want MISSED", got)
	}
	if len(rec.missed) != 1 || rec.missed[0] != 0 {
		t.Errorf("missed hook = %v, want [0]", rec.missed)
	}
	if !IsMissed(&ts.Stops[0]) {
		t.Error("IsMissed should agree")
	}
}

func TestArmed_UnsureBand(t *testing.T) {
	ts := makeTrip(1000)
	ts.Stops[0].UserDistanceM = 35 // between boarding (20) and missed (50)
	clk := &FakeClock{T: 1000}
	var rec recorder
	m := New(ts, clk, rec.hooks())

	m.OnTick()
	if got := ts.Stops[0].Status; got != trip.StatusUnsure {
		t.Fatalf("status = %s, want UNSURE", got)
	}
	if len(rec.unsure) != 1 {
		t.Errorf("unsure hook = %v, want one call", rec.unsure)
	}
	// UNSURE does not advance on its own (§10).
	if ts.CurrentStopIndex != 0 {
		t.Errorf("index = %d, want 0 (UNSURE holds)", ts.CurrentStopIndex)
	}
}

func TestArmed_BoardingAdvances(t *testing.T) {
	ts := makeTrip(1000)
	ts.Stops[0].UserDistanceM = 10 // within boarding radius
	clk := &FakeClock{T: 1000}
	m := New(ts, clk, Hooks{})

	m.OnTick()
	if got := ts.Stops[0].Status; got != trip.StatusActive {
		t.Fatalf("boarding status = %s, want ACTIVE", got)
	}
	if ts.CurrentStopIndex != 1 {
		t.Errorf("index = %d, want 1 (advanced)", ts.CurrentStopIndex)
	}
	if ts.OverallStatus != trip.StatusActive {
		t.Errorf("overall = %s, want ACTIVE", ts.OverallStatus)
	}
}

func TestTransfer_ExemptWhileOnBus(t *testing.T) {
	ts := makeTrip(1000)
	// Pretend we have boarded: index at the mid TRANSFER stop, boarding ACTIVE.
	ts.CurrentStopIndex = 1
	ts.Stops[0].Status = trip.StatusActive
	ts.Stops[1].UserDistanceM = 500 // far — normal while riding
	clk := &FakeClock{T: 1000}      // armed
	var rec recorder
	m := New(ts, clk, rec.hooks())

	if !m.onBus() {
		t.Fatal("expected onBus true after boarding")
	}
	m.OnTick()

	if len(rec.missed) != 0 {
		t.Errorf("transfer-while-riding produced MISSED: %v", rec.missed)
	}
	if ts.CurrentStopIndex != 2 {
		t.Errorf("index = %d, want 2 (advanced past ride-through)", ts.CurrentStopIndex)
	}
	// Boarding stop stays ACTIVE for the duration of its leg.
	if ts.Stops[0].Status != trip.StatusActive {
		t.Errorf("boarding status = %s, want ACTIVE while riding", ts.Stops[0].Status)
	}
}

func TestHappyPath_RunToCompletion(t *testing.T) {
	ts := makeTrip(1000)
	clk := &FakeClock{T: 1000} // armed for all stops
	m := New(ts, clk, Hooks{})

	// Board.
	ts.Stops[0].UserDistanceM = 5
	m.OnTick()
	// Ride through mid and exit (TRANSFER, on bus) -> advance each tick.
	m.OnTick() // mid
	m.OnTick() // exit
	m.OnTick() // past end

	if ts.ActiveStop() != nil {
		t.Errorf("expected trip complete, active index = %d", ts.CurrentStopIndex)
	}
	if ts.OverallStatus != trip.StatusCompleted {
		t.Errorf("overall = %s, want COMPLETED", ts.OverallStatus)
	}
	for i, s := range ts.Stops {
		if s.Status != trip.StatusCompleted {
			t.Errorf("stop %d status = %s, want COMPLETED at end", i, s.Status)
		}
	}
}

func TestOnLocationUpdate_RefreshesActiveDistance(t *testing.T) {
	ts := makeTrip(1000)
	m := New(ts, &FakeClock{T: 900}, Hooks{})
	// A location ~ on top of the boarding stop should yield a small distance.
	m.OnLocationUpdate(trip.UserLocation{Loc: geo.LatLng{Lat: 51.045, Lng: -114.07}})
	if d := ts.Stops[0].UserDistanceM; d > 5 {
		t.Errorf("distance = %.1fm, want near 0", d)
	}
}
