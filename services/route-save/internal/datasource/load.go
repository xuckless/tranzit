package datasource

import (
	"fmt"

	"github.com/tranzit-route-save/internal/geo"
)

// legResolver is implemented by data sources that can resolve a leg faster than
// the generic candidate scan (e.g. HTTPSource's stop-scoped path). It is an
// internal capability check, not part of the DataSource contract.
type legResolver interface {
	resolveLeg(entry, exit geo.LatLng, routeID string, googleETA, now int64) (string, []Stop, error)
}

// ResolveLeg resolves one bus leg to its trip_id and entry→exit windowed stops
// (§5.2 + §5 filter). It uses a source's fast path when available, else the
// generic scan (ResolveTrip + FilterLegStops). This is the single entry point the
// trip builder should call.
func ResolveLeg(ds DataSource, entry, exit geo.LatLng, routeID string, googleETA, now int64) (string, []Stop, error) {
	if r, ok := ds.(legResolver); ok {
		return r.resolveLeg(entry, exit, routeID, googleETA, now)
	}
	return resolveLegGeneric(ds, entry, exit, routeID, googleETA, now)
}

// resolveLegGeneric is the portable resolution: rank all candidates, then window
// the chosen trip's stops. ResolveTrip already returns the winner's stops, so this
// adds no fetch beyond the candidate scan.
func resolveLegGeneric(ds DataSource, entry, exit geo.LatLng, routeID string, googleETA, now int64) (string, []Stop, error) {
	tripID, stops, err := ResolveTrip(ds, entry, exit, routeID, googleETA, now)
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

// scheduledStopLoader is implemented by data sources that can serve a trip's full
// *scheduled* (static GTFS) stop list. The OTP fast path uses it to recover when live
// RT coverage is incomplete (see LoadLegStopsByTripID).
type scheduledStopLoader interface {
	TripStopsScheduled(tripID string) ([]Stop, error)
}

// LoadLegStopsByTripID is the OTP fast path: OpenTripPlanner already resolved the
// concrete trip_id and entry/exit stop_ids, so there is no candidate ranking (§5.2)
// to do — load the trip's stops and window them. It prefers exact stop_id matching
// (entryID/exitID, the GTFS ids from OTP) and falls back to coordinate matching when
// the ids don't line up with the catalog (feed-prefix / id-scheme drift), so the OTP
// path degrades gracefully instead of failing the build.
//
// Live RT coverage is frequently *partial* for a known trip (especially LRT: the feed
// may carry only a handful of a 25-stop run), so the entry/exit can be absent from the
// loaded rows even though the trip exists — the build would 422 with "exit stop not
// found". When windowing the RT rows fails, retry against the complete scheduled
// catalog (TripStopsScheduled) before giving up; RT ETAs are overlaid later by the 30s
// poll. Only on a genuine no-match does the original (RT-based) error surface.
func LoadLegStopsByTripID(ds DataSource, tripID, entryID, exitID string, entry, exit geo.LatLng) ([]Stop, error) {
	stops, err := ds.TripStops(tripID)
	if err != nil {
		return nil, fmt.Errorf("load leg stops: trip %q: %w", tripID, err)
	}
	if window, err := windowLegByIDOrCoord(stops, tripID, entryID, exitID, entry, exit); err == nil {
		return window, nil
	}
	if sched, ok := ds.(scheduledStopLoader); ok {
		if cat, cerr := sched.TripStopsScheduled(tripID); cerr == nil && len(cat) > 0 {
			if window, werr := windowLegByIDOrCoord(cat, tripID, entryID, exitID, entry, exit); werr == nil {
				return window, nil
			}
		}
	}
	// Neither RT nor catalog windows — return the original RT-based error for diagnostics.
	return windowLegByIDOrCoord(stops, tripID, entryID, exitID, entry, exit)
}

// windowLegByIDOrCoord windows a loaded stop list to the inclusive entry→exit range,
// preferring exact stop_id matching and falling back to coordinate matching.
func windowLegByIDOrCoord(stops []Stop, tripID, entryID, exitID string, entry, exit geo.LatLng) ([]Stop, error) {
	if window, err := FilterLegStopsByID(stops, tripID, entryID, exitID); err == nil {
		return window, nil
	}
	return FilterLegStops(stops, tripID, entry, exit)
}

// FilterLegStopsByID windows an already-loaded trip stop list to the inclusive
// entry→exit range by exact stop_id (no I/O). It errors — leaving the caller to fall
// back to coordinate matching — when either id is empty/absent or out of order.
func FilterLegStopsByID(stops []Stop, tripID, entryID, exitID string) ([]Stop, error) {
	if len(stops) == 0 {
		return nil, fmt.Errorf("load leg stops: trip %q has no stops", tripID)
	}
	entryIdx := indexOfStopID(stops, entryID)
	exitIdx := indexOfStopID(stops, exitID)
	if entryIdx < 0 {
		return nil, fmt.Errorf("load leg stops: entry stop %q not on trip %q", entryID, tripID)
	}
	if exitIdx < 0 {
		return nil, fmt.Errorf("load leg stops: exit stop %q not on trip %q", exitID, tripID)
	}
	if entryIdx > exitIdx {
		return nil, fmt.Errorf("load leg stops: entry stop %q (idx %d) is after exit %q (idx %d) on trip %q",
			entryID, entryIdx, exitID, exitIdx, tripID)
	}
	window := make([]Stop, exitIdx-entryIdx+1)
	copy(window, stops[entryIdx:exitIdx+1])
	return window, nil
}

// indexOfStopID returns the index of the first stop whose StopID equals id, or -1.
// An empty id never matches (forces the coordinate fallback).
func indexOfStopID(stops []Stop, id string) int {
	if id == "" {
		return -1
	}
	for i := range stops {
		if stops[i].StopID == id {
			return i
		}
	}
	return -1
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
