package trip

// Splice implements the §9.3 reroute stitch: it retains the completed/active
// prefix of the trip (stops 0..keepThroughIdx inclusive and the legs covering
// them) and appends the freshly-rebuilt remaining legs/stops from newTrip,
// re-basing their LegIndex and StopStart/StopEnd onto the kept prefix. It bumps
// StateVersion.
//
// The caller chooses keepThroughIdx to control where the new legs attach:
//   - Case 2 (off bus): keepThroughIdx = CurrentStopIndex-1 (keep only completed
//     stops); the rider re-enters the machine at the first new stop.
//   - Case 1 (on bus): keepThroughIdx = the current bus leg's exit stop, so the
//     rider finishes the current ride before the new legs begin.
//
// CurrentStopIndex is preserved (clamped to the new bounds); it always lies
// within the kept prefix, so the machine continues seamlessly.
func Splice(ts *TripState, keepThroughIdx int, newTrip *TripState) {
	if keepThroughIdx < -1 {
		keepThroughIdx = -1
	}
	if keepThroughIdx >= len(ts.Stops) {
		keepThroughIdx = len(ts.Stops) - 1
	}
	stopOffset := keepThroughIdx + 1

	keptStops := make([]StopRecord, stopOffset)
	copy(keptStops, ts.Stops[:stopOffset])

	// Keep legs that hold at least one kept stop (bus legs), and walk legs that
	// fall strictly inside the kept region. Clamp a partially-kept leg's end.
	var keptLegs []Leg
	for _, leg := range ts.Legs {
		if leg.Mode == ModeWalk {
			if leg.StopStart < stopOffset {
				keptLegs = append(keptLegs, leg)
			}
			continue
		}
		if leg.StopStart < stopOffset {
			if leg.StopEnd > stopOffset {
				leg.StopEnd = stopOffset
			}
			keptLegs = append(keptLegs, leg)
		}
	}

	legOffset := len(keptLegs)
	for i, leg := range newTrip.Legs {
		leg.LegIndex = legOffset + i
		leg.StopStart += stopOffset
		leg.StopEnd += stopOffset
		keptLegs = append(keptLegs, leg)
	}

	ts.Legs = keptLegs
	ts.Stops = append(keptStops, newTrip.Stops...)

	if ts.CurrentStopIndex > len(ts.Stops) {
		ts.CurrentStopIndex = len(ts.Stops)
	}
	ts.StateVersion++
}
