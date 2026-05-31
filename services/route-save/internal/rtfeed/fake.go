package rtfeed

import "context"

// Fake is a programmable Source for tests. FetchFn, if set, handles the call;
// otherwise Arrivals/Err are returned for any trip set.
type Fake struct {
	FetchFn  func(ctx context.Context, tripIDs []string) ([]Arrival, error)
	Arrivals []Arrival
	Err      error
	Calls    int
}

func (f *Fake) Fetch(ctx context.Context, tripIDs []string) ([]Arrival, error) {
	f.Calls++
	if f.FetchFn != nil {
		return f.FetchFn(ctx, tripIDs)
	}
	return f.Arrivals, f.Err
}
