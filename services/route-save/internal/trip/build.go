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
func BuildTrip(sessionID string, origin, dest geo.LatLng, route directions.Route, ds datasource.DataSource) (*TripState, error) {
	ts := &TripState{
		SessionID:        sessionID,
		Origin:           origin,
		Destination:      dest,
		CurrentStopIndex: 0,
		OverallStatus:    StatusExpected,
	}

	for li, pl := range route.Legs {
		leg := Leg{
			LegIndex:  li,
			Mode:      ModeWalk,
			StopStart: len(ts.Stops),
			StopEnd:   len(ts.Stops),
		}

		if pl.Mode == directions.ModeBus {
			tripID, err := datasource.ResolveTrip(ds, pl.Entry.Loc, pl.RouteID, pl.Entry.TimeEpoch)
			if err != nil {
				return nil, fmt.Errorf("build trip: leg %d: %w", li, err)
			}
			stops, err := datasource.LoadLegStops(ds, tripID, pl.Entry.Loc, pl.Exit.Loc)
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
		}

		ts.Legs = append(ts.Legs, leg)
	}

	if len(ts.Stops) == 0 {
		return nil, fmt.Errorf("build trip: route produced no bus stops")
	}
	return ts, nil
}
