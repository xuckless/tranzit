package datasource

import (
	"fmt"
	"math"

	"github.com/tranzit-route-save/internal/geo"
)

// ResolveTrip implements §5.2: route_id -> trip_id is not 1:1, so among all
// candidate trips on the route that actually serve the entry stop, pick the one
// whose predicted departure at that stop is closest to Google's reported ETA.
//
// Known edge case (§5.2): on high-frequency routes (~5 min headway), if the
// Google time is off by more than the headway we may match the adjacent run
// ("right route, wrong trip"). Accepted for v1.
func ResolveTrip(ds DataSource, entry geo.LatLng, routeID string, googleETAEpoch int64) (string, error) {
	candidates, err := ds.CandidateTrips(routeID)
	if err != nil {
		return "", fmt.Errorf("resolve trip: candidates for route %q: %w", routeID, err)
	}

	bestTrip := ""
	bestDiff := int64(math.MaxInt64)
	for _, c := range candidates {
		idx, dist := nearestStop(c.Stops, entry)
		if idx == -1 || dist > stopMatchRadiusM {
			continue // this run does not serve the entry stop
		}
		// Prefer the predicted departure at the entry stop, falling back to the
		// predicted arrival when departure is unknown.
		t := c.Stops[idx].DepartureTime
		if t == 0 {
			t = c.Stops[idx].ArrivalTime
		}
		if t == 0 {
			continue // no usable time to match against
		}
		if diff := absI64(t - googleETAEpoch); diff < bestDiff {
			bestDiff, bestTrip = diff, c.TripID
		}
	}

	if bestTrip == "" {
		return "", fmt.Errorf("resolve trip: no candidate of route %q serves entry stop", routeID)
	}
	return bestTrip, nil
}

func absI64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
