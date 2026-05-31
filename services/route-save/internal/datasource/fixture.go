package datasource

import "fmt"

// Fixture is an in-memory DataSource for tests and the offline CLI. It returns
// copies so callers can mutate results without corrupting the fixture.
type Fixture struct {
	// Trips by route_id (bus number), in the order resolution should see them.
	TripsByRoute map[string][]TripCandidate
	// Stops by trip_id, ordered by Sequence.
	StopsByTrip map[string][]Stop
}

// NewFixture returns an empty, ready-to-populate Fixture.
func NewFixture() *Fixture {
	return &Fixture{
		TripsByRoute: map[string][]TripCandidate{},
		StopsByTrip:  map[string][]Stop{},
	}
}

func (f *Fixture) CandidateTrips(routeID string) ([]TripCandidate, error) {
	cands, ok := f.TripsByRoute[routeID]
	if !ok {
		return nil, fmt.Errorf("fixture: no trips for route %q", routeID)
	}
	out := make([]TripCandidate, len(cands))
	for i, c := range cands {
		stops := make([]Stop, len(c.Stops))
		copy(stops, c.Stops)
		out[i] = TripCandidate{TripID: c.TripID, Stops: stops}
	}
	return out, nil
}

func (f *Fixture) TripStops(tripID string) ([]Stop, error) {
	stops, ok := f.StopsByTrip[tripID]
	if !ok {
		return nil, fmt.Errorf("fixture: no stops for trip %q", tripID)
	}
	out := make([]Stop, len(stops))
	copy(out, stops)
	return out, nil
}
