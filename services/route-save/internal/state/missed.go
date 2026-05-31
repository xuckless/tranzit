package state

import (
	"github.com/tranzit-route-save/internal/config"
	"github.com/tranzit-route-save/internal/trip"
)

// Hooks receive terminal evaluation outcomes. In this pass they are pure
// signals; the reroute layer (§9) plugs in here in a later pass. A nil hook is
// ignored.
type Hooks struct {
	// OnMissed fires when a FETCHED stop resolves MISSED (§9 trigger).
	OnMissed func(ts *trip.TripState, stopIdx int)
	// OnUnsure fires when a stop lands in the ambiguous band (§10).
	OnUnsure func(ts *trip.TripState, stopIdx int)
}

// armed reports whether the MISSED check is armed for a stop: TimeRemaining has
// fallen to the eval threshold (§8). Before this the stop stays EXPECTED
// regardless of distance, which—together with the 30s RT goalpost slide
// (§6.4)—is what prevents a delayed bus from false-triggering.
func armed(s *trip.StopRecord) bool {
	return s.TimeRemainingS <= config.MissedEvalThresholdS
}

// IsMissed encodes the precise rule (§8): MISSED ⟺ armed AND beyond the missed
// radius. It is the single source of truth for the decision.
func IsMissed(s *trip.StopRecord) bool {
	return armed(s) && s.UserDistanceM > config.MissedRadiusM
}
