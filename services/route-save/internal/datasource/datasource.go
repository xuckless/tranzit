// Package datasource resolves Google's loosely-specified directions (route
// number + stop locations) against our own GTFS data: it picks the concrete
// trip_id a rider is on (§5.2) and loads the ordered stops between their entry
// and exit (§5).
//
// The core logic here is I/O-free and works against the DataSource interface so
// it can be exercised with fixtures. A thin HTTP-backed implementation
// (tranzit-db-middleware) lives in http.go for running end-to-end.
package datasource

import "github.com/tranzit-route-save/internal/geo"

// stopMatchRadiusM bounds how far a GTFS stop may be from the Google-reported
// stop location and still be considered the same stop. Google and our static
// catalog occasionally disagree by a few metres; anything beyond this is a
// different stop.
const stopMatchRadiusM = 150.0

// Stop is one stop on a trip, with its static location and (where known) the
// trip's predicted times at that stop.
type Stop struct {
	StopID        string
	Name          string
	Loc           geo.LatLng
	Sequence      int
	ArrivalTime   int64 // predicted arrival, Unix seconds; 0 if unknown
	DepartureTime int64 // predicted departure, Unix seconds; 0 if unknown
}

// TripCandidate is one concrete run of a route, with its stops (and their
// predicted times) for time-matching during resolution.
type TripCandidate struct {
	TripID string
	Stops  []Stop
}

// DataSource supplies the GTFS data resolution and loading need. Implementations
// must return stops ordered by Sequence.
type DataSource interface {
	// CandidateTrips returns every active trip on the given route (bus number),
	// each with its stops and predicted times.
	CandidateTrips(routeID string) ([]TripCandidate, error)
	// TripStops returns the ordered stops of a single resolved trip.
	TripStops(tripID string) ([]Stop, error)
}

// nearestStop returns the index of the stop nearest to loc and that distance in
// metres. Returns (-1, 0) for an empty slice.
func nearestStop(stops []Stop, loc geo.LatLng) (int, float64) {
	best := -1
	var bestD float64
	for i, s := range stops {
		d := geo.HaversineM(loc, s.Loc)
		if best == -1 || d < bestD {
			best, bestD = i, d
		}
	}
	return best, bestD
}
