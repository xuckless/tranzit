package routeclient

import (
	"context"
	"encoding/json"

	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
)

// Fake is a programmable Client for tests. RouteFn, if set, handles the call;
// otherwise Result/Raw/Err are returned.
type Fake struct {
	RouteFn func(ctx context.Context, origin geo.LatLng, destPlaceID string) (directions.Route, json.RawMessage, error)
	Result  directions.Route
	Raw     json.RawMessage
	Err     error
	Calls   int
}

func (f *Fake) Route(ctx context.Context, origin geo.LatLng, destPlaceID string) (directions.Route, json.RawMessage, error) {
	f.Calls++
	if f.RouteFn != nil {
		return f.RouteFn(ctx, origin, destPlaceID)
	}
	return f.Result, f.Raw, f.Err
}
