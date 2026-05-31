// Package rtfeed supplies live GTFS-RT predicted arrivals for the trips a session
// is tracking (doc §14). It is a stateless fetch behind an interface; the
// session owns the 30s cadence (config.RTUpdateIntervalS) and feeds results into
// its event loop.
package rtfeed

import "context"

// Arrival is one predicted arrival for a (trip_id, stop_id) pair.
type Arrival struct {
	TripID           string
	StopID           string
	PredictedArrival int64 // Unix seconds
}

// Source fetches current predicted arrivals for the given trip_ids.
type Source interface {
	Fetch(ctx context.Context, tripIDs []string) ([]Arrival, error)
}
