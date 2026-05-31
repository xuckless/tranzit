package wsproto

import (
	"testing"

	"github.com/tranzit-route-save/internal/trip"
)

func TestStateMessage_FullExport(t *testing.T) {
	ts := &trip.TripState{
		SessionID:     "sess-1",
		StateVersion:  7,
		OverallStatus: trip.StatusActive,
		Stops: []trip.StopRecord{
			{
				StopID: "11", StopName: "7 Ave & 2 St SW", RouteID: "3",
				StopType: trip.Fetched, Status: trip.StatusActive,
				TimeRemainingS: 0, BusArrivalTime: 1730000000,
				StopLat: 51.047, StopLng: -114.071,
			},
		},
	}

	// now is 240s before the stop's ETA, so time_remaining_s must export 240
	// regardless of the (stale) TimeRemainingS on the record.
	const now = 1730000000 - 240
	msg := StateMessage(ts, now)
	if msg.Type != TypeState || msg.SessionID != "sess-1" || msg.Version != 7 {
		t.Fatalf("envelope = %+v", msg)
	}
	if msg.Overall != "ACTIVE" {
		t.Errorf("overall = %q, want ACTIVE", msg.Overall)
	}
	if len(msg.Stops) != 1 {
		t.Fatalf("stops = %d, want 1", len(msg.Stops))
	}
	s := msg.Stops[0]
	if s.StopID != "11" || s.StopType != "FETCHED" || s.Status != "ACTIVE" {
		t.Errorf("stop = %+v", s)
	}
	if s.ETA != 1730000000 || s.StopName != "7 Ave & 2 St SW" {
		t.Errorf("stop fields = %+v", s)
	}
	if s.TimeRemainingS != 240 {
		t.Errorf("time_remaining_s = %d, want 240 (eta − now)", s.TimeRemainingS)
	}
}

func TestStateMessage_NoETAStaysZero(t *testing.T) {
	ts := &trip.TripState{
		Stops: []trip.StopRecord{{StopID: "1", BusArrivalTime: 0}},
	}
	msg := StateMessage(ts, 1730000000)
	if msg.Stops[0].TimeRemainingS != 0 || msg.Stops[0].ETA != 0 {
		t.Errorf("no-ETA stop = %+v, want zero t-rem and eta", msg.Stops[0])
	}
}
