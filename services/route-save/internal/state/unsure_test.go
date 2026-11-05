package state

import (
	"testing"

	"github.com/tranzit-route-save/internal/trip"
)

func TestResolveUnsure_Boarded(t *testing.T) {
	ts := makeTrip(1000)
	ts.Stops[0].Status = trip.StatusUnsure
	m := New(ts, &FakeClock{T: 1000}, Hooks{})

	if !m.ResolveUnsure("board", true) {
		t.Fatal("expected change")
	}
	if ts.Stops[0].Status != trip.StatusActive {
		t.Errorf("status = %s, want ACTIVE", ts.Stops[0].Status)
	}
	if ts.CurrentStopIndex != 1 {
		t.Errorf("index = %d, want 1 (advanced)", ts.CurrentStopIndex)
	}
}

func TestResolveUnsure_NotBoarded(t *testing.T) {
	ts := makeTrip(1000)
	ts.Stops[0].Status = trip.StatusUnsure
	var rec recorder
	m := New(ts, &FakeClock{T: 1000}, rec.hooks())

	if !m.ResolveUnsure("board", false) {
		t.Fatal("expected change")
	}
	if ts.Stops[0].Status != trip.StatusMissed {
		t.Errorf("status = %s, want MISSED", ts.Stops[0].Status)
	}
	if len(rec.missed) != 1 {
		t.Errorf("missed hook = %v, want one call", rec.missed)
	}
}

func TestResolveUnsure_IgnoresWrongStop(t *testing.T) {
	ts := makeTrip(1000)
	ts.Stops[0].Status = trip.StatusUnsure
	m := New(ts, &FakeClock{T: 1000}, Hooks{})
	if m.ResolveUnsure("nope", true) {
		t.Error("expected no change for unknown stop")
	}
}
