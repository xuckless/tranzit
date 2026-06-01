package datasource

import (
	"fmt"
	"math"

	"github.com/tranzit-route-save/internal/config"
	"github.com/tranzit-route-save/internal/geo"
)

// ResolveTrip implements §5.2: route_id -> trip_id is not 1:1, so among all
// candidate trips on the route, pick the one whose predicted departure at the
// entry stop is closest to Google's reported ETA.
//
// A route runs in both directions under the same route_id, so matching only the
// entry stop can select a wrong-direction trip whose entry time happens to line
// up. We therefore require a candidate to serve BOTH the entry and exit stops
// with the entry earlier in the trip's stop sequence than the exit — only the
// correct-direction trip satisfies this.
//
// Known edge case (§5.2): on high-frequency routes (~5 min headway), if the
// Google time is off by more than the headway we may match the adjacent run
// ("right route, wrong trip"). Accepted for v1.
//
// now is the server clock: a candidate whose boarding time is already in the past
// (older than now − config.ResolveDepartureGraceS) has departed and is excluded —
// indexing it would be born with a past ETA and immediately trip the MISSED check.
//
// It also returns the chosen trip's full stop list — already loaded while ranking
// candidates — so the caller can window it (FilterLegStops) without a second
// TripStops fetch for the resolved trip.
func ResolveTrip(ds DataSource, entry, exit geo.LatLng, routeID string, googleETAEpoch, now int64) (string, []Stop, error) {
	candidates, err := ds.CandidateTrips(routeID)
	if err != nil {
		return "", nil, fmt.Errorf("resolve trip: candidates for route %q: %w", routeID, err)
	}

	floor := now - config.ResolveDepartureGraceS
	servedInOrder := false // a candidate served entry→exit but every such run had departed
	bestTrip := ""
	var bestStops []Stop
	bestDiff := int64(math.MaxInt64)
	for _, c := range candidates {
		entryIdx, entryD := nearestStop(c.Stops, entry)
		exitIdx, exitD := nearestStop(c.Stops, exit)
		if entryIdx == -1 || entryD > stopMatchRadiusM {
			continue // does not serve the entry stop
		}
		if exitIdx == -1 || exitD > stopMatchRadiusM {
			continue // does not serve the exit stop
		}
		if entryIdx >= exitIdx {
			continue // wrong direction: entry is not before exit on this run
		}
		// Prefer the predicted departure at the entry stop, falling back to the
		// predicted arrival when departure is unknown.
		t := c.Stops[entryIdx].DepartureTime
		if t == 0 {
			t = c.Stops[entryIdx].ArrivalTime
		}
		if t == 0 {
			continue // no usable time to match against
		}
		servedInOrder = true
		if t < floor {
			continue // already departed; can never be boarded
		}
		if diff := absI64(t - googleETAEpoch); diff < bestDiff {
			bestDiff, bestTrip, bestStops = diff, c.TripID, c.Stops
		}
	}

	if bestTrip == "" {
		if servedInOrder {
			return "", nil, fmt.Errorf("resolve trip: no future run of route %q serves entry→exit (all departed)", routeID)
		}
		return "", nil, fmt.Errorf("resolve trip: no candidate of route %q serves entry→exit in order", routeID)
	}
	return bestTrip, bestStops, nil
}

func absI64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
