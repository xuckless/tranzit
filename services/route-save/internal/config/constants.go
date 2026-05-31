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

	// MissedEvalThresholdS is the TimeRemaining (seconds) at which the MISSED
	// check arms. Above this the active stop stays EXPECTED regardless of
	// distance (§8).
	MissedEvalThresholdS = 1

	// MissedRadiusM: beyond this distance (metres) from the active stop at
	// trigger → MISSED (§7.2).
	MissedRadiusM = 50.0
	// BoardingRadiusM: within this distance (metres) at trigger → ACTIVE
	// (boarded). Widened from 5m to 20m for GPS accuracy; tune in testing.
	BoardingRadiusM = 20.0
	// RerouteRearmRadiusM: on-bus reroute re-fetch distance (metres) (§9.1).
	RerouteRearmRadiusM = 50.0
)
