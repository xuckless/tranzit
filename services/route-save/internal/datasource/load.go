package datasource

import (
	"fmt"

	"github.com/tranzit-route-save/internal/geo"
)

// LoadLegStops implements the §5 filter: load the resolved trip's stops and keep
// only the inclusive window between the rider's entry and exit stops. Entry and
// exit are matched to the nearest stop on the trip by haversine.
func LoadLegStops(ds DataSource, tripID string, entry, exit geo.LatLng) ([]Stop, error) {
	stops, err := ds.TripStops(tripID)
	if err != nil {
		return nil, fmt.Errorf("load leg stops: trip %q: %w", tripID, err)
	}
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
