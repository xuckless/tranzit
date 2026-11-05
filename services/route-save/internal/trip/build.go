package trip

import (
	"fmt"

	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
)

// BuildTrip assembles a TripState from a parsed route (§5 pipeline). For each
// bus leg it resolves the concrete trip_id (§5.2) and loads the entry→exit stop
// window (§5), classifying the boarding stop as FETCHED and the rest TRANSFER
// (§5.4). Walk legs carry no stops.
//
// Stop names come from the GTFS catalog (datasource), which—unlike Google—covers
// the intermediate stops the STATE export needs (§13).
//
// now is the server clock, used by resolution to exclude already-departed runs
// (§5.2). When no future run serves a bus leg, BuildTrip fails (surfacing as a 422
// at POST /trips / a logged "reroute failed" rather than indexing a past bus).
func BuildTrip(sessionID string, origin, dest geo.LatLng, route directions.Route, ds datasource.DataSource, now int64) (*TripState, error) {
	ts := &TripState{
		SessionID:        sessionID,
		Origin:           origin,
		Destination:      dest,
		CurrentStopIndex: 0,
		OverallStatus:    StatusExpected,
	}

	hasBusLeg := false
	for li, pl := range route.Legs {
		leg := Leg{
			LegIndex:  li,
			Mode:      ModeWalk,
			StopStart: len(ts.Stops),
			StopEnd:   len(ts.Stops),
		}

		if pl.Mode == directions.ModeBus {
			hasBusLeg = true
			// Load the entry→exit stop window (§5). On the OTP path the concrete
			// trip_id and entry/exit stop_ids are already known (graph-resolved), so
			// skip resolution (§5.2) and window directly; on the Google path resolve
			// the trip_id first (HTTPSource uses a stop-scoped fast path, others scan).
			var (
				tripID string
				stops  []datasource.Stop
				err    error
			)
			if pl.TripID != "" {
				tripID = pl.TripID
				stops, err = datasource.LoadLegStopsByTripID(ds, pl.TripID, pl.EntryStopID, pl.ExitStopID, pl.Entry.Loc, pl.Exit.Loc)
			} else {
				tripID, stops, err = datasource.ResolveLeg(ds, pl.Entry.Loc, pl.Exit.Loc, pl.RouteID, pl.Entry.TimeEpoch, now)
			}
			if err != nil {
				return nil, fmt.Errorf("build trip: leg %d: %w", li, err)
			}

			leg.Mode = ModeBus
			leg.RouteID = pl.RouteID
			leg.TripID = tripID

			for si, s := range stops {
				rec := StopRecord{
					StopID:         s.StopID,
					StopName:       s.Name,
					StopLat:        s.Loc.Lat,
					StopLng:        s.Loc.Lng,
					RouteID:        pl.RouteID,
					TripID:         tripID,
					StopType:       Transfer,
					BusArrivalTime: s.ArrivalTime,
					Status:         StatusExpected,
				}
				if si == 0 {
					// Boarding stop: gated for MISSED, and the Google ETA is its
					// static fallback (§5.3).
					rec.StopType = Fetched
					rec.UserArrivalTime = pl.Entry.TimeEpoch
				}
				ts.Stops = append(ts.Stops, rec)
			}
			leg.StopEnd = len(ts.Stops)
		} else {
			// Walk leg: it carries no stops, but record its endpoints so the trip
			// is self-describing. The segment runs from the previous bus leg's exit
			// (or the trip origin if this is the leading walk) to the next bus leg's
			// entry (or the destination if this is the trailing walk). segmentLegs
			// never emits adjacent walk legs, so the neighbours are bus legs.
			leg.WalkFrom = origin
			if prev := prevBusExit(route.Legs, li); prev != nil {
				leg.WalkFrom = *prev
			}
			leg.WalkTo = dest
			if next := nextBusEntry(route.Legs, li); next != nil {
				leg.WalkTo = *next
			}
		}

		ts.Legs = append(ts.Legs, leg)
	}

	if len(ts.Stops) == 0 {
		if hasBusLeg {
			// A bus leg that loaded no stops is a real failure, not a walk-only trip.
			return nil, fmt.Errorf("build trip: route produced no bus stops")
		}
		// Walk-only route: nothing to track. The client renders the walk legs; the
		// state machine completes the trip on arrival at the destination (OnTick).
		ts.OverallStatus = StatusActive
	}
	return ts, nil
}

// prevBusExit returns the exit-stop location of the nearest bus leg before idx,
// or nil if none precedes it (the walk leg starts at the trip origin).
func prevBusExit(legs []directions.ParsedLeg, idx int) *geo.LatLng {
	for i := idx - 1; i >= 0; i-- {
		if legs[i].Mode == directions.ModeBus && legs[i].Exit != nil {
			return &legs[i].Exit.Loc
		}
	}
	return nil
}

// nextBusEntry returns the entry-stop location of the nearest bus leg after idx,
// or nil if none follows it (the walk leg ends at the trip destination).
func nextBusEntry(legs []directions.ParsedLeg, idx int) *geo.LatLng {
	for i := idx + 1; i < len(legs); i++ {
		if legs[i].Mode == directions.ModeBus && legs[i].Entry != nil {
			return &legs[i].Entry.Loc
		}
	}
	return nil
}
