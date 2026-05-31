// Package config holds the Route Save tuning constants from the design doc §15.
//
// These are compile-time defaults. Several (notably BoardingRadiusM) are
// explicitly flagged in the doc as "tune in testing", so they are kept together
// here rather than scattered through the state machine.
package config

const (
	// LocationUpdateIntervalS is the client GPS cadence (seconds).
	LocationUpdateIntervalS = 5
	// RTUpdateIntervalS is the GTFS-RT refresh cadence (seconds).
	RTUpdateIntervalS = 30
	// TickIntervalS is the server evaluation tick (seconds).
	TickIntervalS = 1
	// ClientPushIntervalS is the downstream STATE push cadence (seconds). The
	// evaluation tick stays at TickIntervalS; STATE is coalesced and flushed to
	// the client at most once per this interval (§13, on-change throttled).
	ClientPushIntervalS = 2
	// LocationStaleAfterS bounds how old a client fix may be (measured against
	// the server clock, not the client TS) before it counts as "no fix". At or
	// beyond this age the MISSED check holds EXPECTED rather than resolving from
	// a stale distance (3×LocationUpdateIntervalS).
	LocationStaleAfterS = 3 * LocationUpdateIntervalS

	// MissedEvalThresholdS is the TimeRemaining (seconds) at which the MISSED
	// check arms. Above this the active stop stays EXPECTED regardless of
	// distance (§8).
	MissedEvalThresholdS = 1
	// UnsureAnswerTimeoutS bounds how long an UNSURE stop waits for resolution —
	// either the rider's UNSURE_RESPONSE or a clarifying GPS fix — before the
	// server escalates it to MISSED and reroutes (§10). Without this an UNSURE
	// raised with GPS silent (and no answer) would hang the trip indefinitely.
	UnsureAnswerTimeoutS = 120

	// MissedRadiusM: beyond this distance (metres) from the active stop at
	// trigger → MISSED (§7.2).
	MissedRadiusM = 50.0
	// BoardingRadiusM: within this distance (metres) at trigger → ACTIVE
	// (boarded). Widened from 5m to 20m for GPS accuracy; tune in testing.
	BoardingRadiusM = 20.0
	// RerouteRearmRadiusM: on-bus reroute re-fetch distance (metres) (§9.1).
	RerouteRearmRadiusM = 50.0
)
