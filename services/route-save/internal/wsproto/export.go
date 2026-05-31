package wsproto

import "github.com/tranzit-route-save/internal/trip"

// StateMessage builds the full read-only STATE export from a TripState (§13.0).
// Each STATE carries the entire stop list so the client can redraw the whole
// trip from a single frame.
func StateMessage(ts *trip.TripState) StateMsg {
	stops := make([]StateStop, len(ts.Stops))
	for i := range ts.Stops {
		s := &ts.Stops[i]
		stops[i] = StateStop{
			StopID:         s.StopID,
			StopName:       s.StopName,
			RouteID:        s.RouteID,
			StopType:       s.StopType.String(),
			Status:         s.Status.String(),
			TimeRemainingS: s.TimeRemainingS,
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

// RerouteMessage builds the REROUTE payload from the spliced trip (§13.2).
func RerouteMessage(ts *trip.TripState, reason string, from LatLng) RerouteMsg {
	legs := make([]RouteLeg, len(ts.Legs))
	for i, leg := range ts.Legs {
		legs[i] = RouteLeg{
			LegIndex: leg.LegIndex,
			Mode:     leg.Mode.String(),
			RouteID:  leg.RouteID,
			TripID:   leg.TripID,
		}
	}
	return RerouteMsg{Type: TypeReroute, Reason: reason, From: from, Legs: legs}
}
