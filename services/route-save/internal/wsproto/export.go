package wsproto

import (
	"encoding/json"

	"github.com/tranzit-route-save/internal/geo"
	"github.com/tranzit-route-save/internal/trip"
)

// walkEndpoints returns the leg's walk segment endpoints as *LatLng for export,
// or (nil, nil) for a bus leg so the JSON fields are omitted.
func walkEndpoints(leg trip.Leg) (from, to *LatLng) {
	if leg.Mode != trip.ModeWalk {
		return nil, nil
	}
	return latLngPtr(leg.WalkFrom), latLngPtr(leg.WalkTo)
}

func latLngPtr(p geo.LatLng) *LatLng { return &LatLng{Lat: p.Lat, Lng: p.Lng} }

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
	legs := make([]StateLeg, len(ts.Legs))
	for i, leg := range ts.Legs {
		from, to := walkEndpoints(leg)
		legs[i] = StateLeg{
			LegIndex:  leg.LegIndex,
			Mode:      leg.Mode.String(),
			RouteID:   leg.RouteID,
			TripID:    leg.TripID,
			StopStart: leg.StopStart,
			StopEnd:   leg.StopEnd,
			WalkFrom:  from,
			WalkTo:    to,
		}
	}
	return StateMsg{
		Type:      TypeState,
		SessionID: ts.SessionID,
		Version:   ts.StateVersion,
		Overall:   ts.OverallStatus.String(),
		Stops:     stops,
		Legs:      legs,
	}
}

// SnapshotMessage builds the GET /trips/{id} body: the full STATE export plus the
// latest route (raw Google object). route may be nil, in which case the field is
// omitted. Reuses StateMessage so the snapshot stays in lockstep with the push.
func SnapshotMessage(ts *trip.TripState, now int64, route json.RawMessage) SnapshotMsg {
	return SnapshotMsg{StateMsg: StateMessage(ts, now), Route: route}
}

// RerouteMessage builds the REROUTE payload from the spliced trip (§13.2). route
// is the chosen route's raw Google JSON for the remaining journey, echoed so the
// client re-renders directly; it may be nil (e.g. resume) in which case the field
// is omitted.
func RerouteMessage(ts *trip.TripState, reason string, from LatLng, route json.RawMessage) RerouteMsg {
	legs := make([]RouteLeg, len(ts.Legs))
	for i, leg := range ts.Legs {
		from, to := walkEndpoints(leg)
		legs[i] = RouteLeg{
			LegIndex: leg.LegIndex,
			Mode:     leg.Mode.String(),
			RouteID:  leg.RouteID,
			TripID:   leg.TripID,
			WalkFrom: from,
			WalkTo:   to,
		}
	}
	return RerouteMsg{Type: TypeReroute, Reason: reason, From: from, Route: route, Legs: legs}
}
