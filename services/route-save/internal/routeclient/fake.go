package routeclient

import (
	"context"

	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
)

// Fake is a programmable Client for tests. RouteFn, if set, handles the call;
// otherwise Result/Err are returned.
type Fake struct {
	RouteFn func(ctx context.Context, origin geo.LatLng, destPlaceID string) (directions.Route, error)
	Result  directions.Route
	Err     error
	Calls   int
}

func (f *Fake) Route(ctx context.Context, origin geo.LatLng, destPlaceID string) (directions.Route, error) {
	f.Calls++
	if f.RouteFn != nil {
		return f.RouteFn(ctx, origin, destPlaceID)
	}
	return f.Result, f.Err
}
