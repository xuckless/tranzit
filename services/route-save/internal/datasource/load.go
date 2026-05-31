package datasource

import (
	"fmt"

	"github.com/tranzit-route-save/internal/geo"
)

// legResolver is implemented by data sources that can resolve a leg faster than
// the generic candidate scan (e.g. HTTPSource's stop-scoped path). It is an
// internal capability check, not part of the DataSource contract.
type legResolver interface {
	resolveLeg(entry, exit geo.LatLng, routeID string, googleETA int64) (string, []Stop, error)
}

// ResolveLeg resolves one bus leg to its trip_id and entry→exit windowed stops
// (§5.2 + §5 filter). It uses a source's fast path when available, else the
// generic scan (ResolveTrip + FilterLegStops). This is the single entry point the
// trip builder should call.
func ResolveLeg(ds DataSource, entry, exit geo.LatLng, routeID string, googleETA int64) (string, []Stop, error) {
	if r, ok := ds.(legResolver); ok {
		return r.resolveLeg(entry, exit, routeID, googleETA)
	}
	return resolveLegGeneric(ds, entry, exit, routeID, googleETA)
}

// resolveLegGeneric is the portable resolution: rank all candidates, then window
// the chosen trip's stops. ResolveTrip already returns the winner's stops, so this
// adds no fetch beyond the candidate scan.
func resolveLegGeneric(ds DataSource, entry, exit geo.LatLng, routeID string, googleETA int64) (string, []Stop, error) {
	tripID, stops, err := ResolveTrip(ds, entry, exit, routeID, googleETA)
	if err != nil {
		return "", nil, err
	}
	window, err := FilterLegStops(stops, tripID, entry, exit)
	if err != nil {
		return "", nil, err
	}
	return tripID, window, nil
}

// LoadLegStops implements the §5 filter: load the resolved trip's stops and keep
// only the inclusive window between the rider's entry and exit stops. Entry and
// exit are matched to the nearest stop on the trip by haversine.
//
// When the caller already holds the trip's stops (e.g. ResolveTrip returns the
// chosen candidate's list), prefer FilterLegStops to skip the redundant fetch.
func LoadLegStops(ds DataSource, tripID string, entry, exit geo.LatLng) ([]Stop, error) {
	stops, err := ds.TripStops(tripID)
	if err != nil {
		return nil, fmt.Errorf("load leg stops: trip %q: %w", tripID, err)
	}
	return FilterLegStops(stops, tripID, entry, exit)
}

// FilterLegStops windows an already-loaded trip stop list to the inclusive
// entry→exit range (the §5 filter, no I/O). tripID is used only for error context.
func FilterLegStops(stops []Stop, tripID string, entry, exit geo.LatLng) ([]Stop, error) {
	if len(stops) == 0 {
		return nil, fmt.Errorf("load leg stops: trip %q has no stops", tripID)
	}

	entryIdx, entryD := nearestStop(stops, entry)
	exitIdx, exitD := nearestStop(stops, exit)
	if entryD > stopMatchRadiusM {
		return nil, fmt.Errorf("load leg stops: entry stop not found on trip %q (nearest %.0fm)", tripID, entryD)
	}
	if exitD > stopMatchRadiusM {
		return nil, fmt.Errorf("load leg stops: exit stop not found on trip %q (nearest %.0fm)", tripID, exitD)
	}
	if entryIdx > exitIdx {
		return nil, fmt.Errorf("load leg stops: entry (seq %d) is after exit (seq %d) on trip %q",
			stops[entryIdx].Sequence, stops[exitIdx].Sequence, tripID)
	}

	window := make([]Stop, exitIdx-entryIdx+1)
	copy(window, stops[entryIdx:exitIdx+1])
	return window, nil
}
