package wsproto

import (
	"encoding/json"

	"github.com/tranzit-route-save/internal/trip"
)

// StateMessage builds the full read-only STATE export from a TripState (§13.0).
// Each STATE carries the entire stop list so the client can redraw the whole
// trip from a single frame. time_remaining_s is recomputed (eta − now) for every
// stop, not just the active one, so the whole list counts down live; now is the
// server clock (§6.2). A stop with no ETA yet (BusArrivalTime 0) exports 0.
func StateMessage(ts *trip.TripState, now int64) StateMsg {
	stops := make([]StateStop, len(ts.Stops))
	for i := range ts.Stops {
		s := &ts.Stops[i]
		trem := 0
		if s.BusArrivalTime != 0 {
			trem = int(s.BusArrivalTime - now)
		}
		stops[i] = StateStop{
			StopID:         s.StopID,
			StopName:       s.StopName,
			RouteID:        s.RouteID,
			StopType:       s.StopType.String(),
			Status:         s.Status.String(),
			TimeRemainingS: trem,
			ETA:            s.BusArrivalTime,
			Lat:            s.StopLat,
			Lng:            s.StopLng,
		}
	}
	return StateMsg{
		Type:      TypeState,
		SessionID: ts.SessionID,
		Version:   ts.StateVersion,
		Overall:   ts.OverallStatus.String(),
		Stops:     stops,
	}
}

// RerouteMessage builds the REROUTE payload from the spliced trip (§13.2). route
// is the chosen route's raw Google JSON for the remaining journey, echoed so the
// client re-renders directly; it may be nil (e.g. resume) in which case the field
// is omitted.
func RerouteMessage(ts *trip.TripState, reason string, from LatLng, route json.RawMessage) RerouteMsg {
	legs := make([]RouteLeg, len(ts.Legs))
	for i, leg := range ts.Legs {
		legs[i] = RouteLeg{
			LegIndex: leg.LegIndex,
			Mode:     leg.Mode.String(),
			RouteID:  leg.RouteID,
			TripID:   leg.TripID,
		}
	}
	return RerouteMsg{Type: TypeReroute, Reason: reason, From: from, Route: route, Legs: legs}
}
