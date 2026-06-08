package routeclient

import (
	"context"
	"encoding/json"

	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
)

// OTPFake is a programmable OTPClient for tests. RouteFn, if set, handles the call;
// otherwise Result/Raw/Err are returned.
type OTPFake struct {
	RouteFn func(ctx context.Context, origin, dest geo.LatLng, mode string, num int) (directions.Route, json.RawMessage, error)
	Result  directions.Route
	Raw     json.RawMessage
	Err     error
	Calls   int
}

func (f *OTPFake) RouteOTP(ctx context.Context, origin, dest geo.LatLng, mode string, num int) (directions.Route, json.RawMessage, error) {
	f.Calls++
	if f.RouteFn != nil {
		return f.RouteFn(ctx, origin, dest, mode, num)
	}
	return f.Result, f.Raw, f.Err
}
