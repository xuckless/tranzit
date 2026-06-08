package session

import (
	"testing"
	"time"

	"github.com/tranzit-route-save/internal/routeclient"
	"github.com/tranzit-route-save/internal/rtfeed"
)

// scaledClock advances 100 simulated seconds per real second, so the 60s
// SessionAttachGraceS elapses within a couple of real 1s ticks. Its fields are set
// once at construction and never mutated, so concurrent Now() reads from the
// session loop are race-free.
type scaledClock struct {
	start time.Time
	base  int64
}

func (c *scaledClock) Now() int64 {
	return c.base + int64(time.Since(c.start).Seconds()*100)
}

// A session that POST /trips created but no client ever attaches to must tear
// itself down rather than tick forever (the "still running after closing the
// simulator" symptom, here for the never-attached case).
func TestSession_ClosesWhenNoClientAttaches(t *testing.T) {
	ts, fx, _ := buildFixtureTrip(t)
	clk := &scaledClock{start: time.Now(), base: 1000}
	// Empty destPlaceID disables reroute, so the attach-grace watchdog is the only
	// thing acting on the session.
	deps := Deps{Data: fx, RT: &rtfeed.Fake{}, Routes: &routeclient.Fake{}, Clock: clk}
	mgr := NewManager(deps)
	mgr.Create(ts, "", nil) // starts the loop; no WebSocket ever attaches

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if mgr.Count() == 0 {
			return // torn down as expected
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("session not torn down despite no client attaching")
}
