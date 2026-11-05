package state

import "time"

// Clock supplies the server-authoritative epoch used for TimeRemaining. Per
// §6.2 the client clock is never used, since client drift would corrupt the
// trigger moment.
type Clock interface {
	Now() int64 // Unix seconds
}

// SystemClock is the production clock.
type SystemClock struct{}

func (SystemClock) Now() int64 { return time.Now().Unix() }

// FakeClock is a settable clock for tests.
type FakeClock struct{ T int64 }

func (c *FakeClock) Now() int64 { return c.T }

// Advance moves the fake clock forward by d seconds.
func (c *FakeClock) Advance(d int64) { c.T += d }
