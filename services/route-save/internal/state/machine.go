// Package state runs Route Save's per-stop state machine and missed detection
// (doc §7–§8). It is driven by three event kinds—RT updates (30s), location
// updates (5s) and ticks (1s)—and mutates a *trip.TripState in place. It does no
// I/O: callers feed it events and read the resulting state (the WebSocket/SSE
// wiring is a later pass).
package state

import (
	"github.com/tranzit-route-save/internal/config"
	"github.com/tranzit-route-save/internal/geo"
	"github.com/tranzit-route-save/internal/trip"
)

// Machine evaluates one trip session.
type Machine struct {
	ts    *trip.TripState
	clock Clock
	hooks Hooks
	// unsureSince is the server time the active stop entered UNSURE; it arms the
	// answer timeout (§10). Zero when the active stop is not UNSURE.
	unsureSince int64
}

// New builds a Machine for the given trip. A nil clock defaults to SystemClock.
func New(ts *trip.TripState, clock Clock, hooks Hooks) *Machine {
	if clock == nil {
		clock = SystemClock{}
	}
	return &Machine{ts: ts, clock: clock, hooks: hooks}
}

// Trip exposes the underlying state (read-only intent).
func (m *Machine) Trip() *trip.TripState { return m.ts }

// Arrival is one GTFS-RT predicted arrival for a (trip_id, stop_id) pair.
type Arrival struct {
	TripID           string
	StopID           string
	PredictedArrival int64 // Unix seconds
}

// OnRTUpdate applies a batch of predicted arrivals to matching stops (§7.1).
// The next tick recomputes TimeRemaining from these.
func (m *Machine) OnRTUpdate(arrivals []Arrival) {
	index := make(map[[2]string]int64, len(arrivals))
	for _, a := range arrivals {
		index[[2]string{a.TripID, a.StopID}] = a.PredictedArrival
	}
	for i := range m.ts.Stops {
		s := &m.ts.Stops[i]
		if t, ok := index[[2]string{s.TripID, s.StopID}]; ok {
			s.BusArrivalTime = t
		}
	}
	m.ts.LastRTUpdate = m.clock.Now()
}

// OnLocationUpdate stores the latest client fix and refreshes the active stop's
// distance (§7.1). RecvAt is stamped from the server clock so staleness is judged
// independently of client clock drift (§6.2).
func (m *Machine) OnLocationUpdate(loc trip.UserLocation) {
	loc.Valid = true
	loc.RecvAt = m.clock.Now()
	m.ts.UserLocation = loc
	if active := m.ts.ActiveStop(); active != nil {
		active.UserDistanceM = geo.HaversineM(loc.Loc, active.Loc())
	}
}

// freshUserFix returns the latest fix and true only when it exists and is no
// older than config.LocationStaleAfterS (server clock). The MISSED/boarding call
// is made only from a fresh fix; otherwise the stop is held EXPECTED.
func (m *Machine) freshUserFix() (geo.LatLng, bool) {
	loc := m.ts.UserLocation
	if !loc.Valid {
		return geo.LatLng{}, false
	}
	if m.clock.Now()-loc.RecvAt > config.LocationStaleAfterS {
		return geo.LatLng{}, false
	}
	return loc.Loc, true
}

// FreshUserFix is the exported form of freshUserFix. The reroute layer uses it to
// choose the reroute origin: the rider's live fix when fresh, else the planned
// stop (§9).
func (m *Machine) FreshUserFix() (geo.LatLng, bool) { return m.freshUserFix() }

// OnTick recomputes the active stop's TimeRemaining and evaluates it. It returns
// true if any stop status or the current index changed, so a caller can decide
// whether to push a new STATE frame.
func (m *Machine) OnTick() bool {
	active := m.ts.ActiveStop()
	if active == nil {
		return m.tickStopless()
	}

	beforeIdx := m.ts.CurrentStopIndex
	beforeStatus := m.statuses()

	active.TimeRemainingS = int(active.BusArrivalTime - m.clock.Now())
	// Recompute the active stop's distance from the latest fresh fix every tick,
	// not just on the 5s LOCATION frame. Otherwise a freshly-advanced stop keeps
	// its zero-value distance (reads as "on the stop") until the next frame.
	if loc, ok := m.freshUserFix(); ok {
		active.UserDistanceM = geo.HaversineM(loc, active.Loc())
	}
	m.evaluate(m.ts.CurrentStopIndex)

	return beforeIdx != m.ts.CurrentStopIndex || !sameStatuses(beforeStatus, m.statuses())
}

// tickStopless handles a tick when there is no active stop. Two cases: a walk-only
// trip (no stops at all) completes on arrival at the destination — within
// config.ArrivalRadiusM of a fresh fix — and stays ACTIVE while still walking; a
// normal trip that simply ran out of stops completes immediately.
func (m *Machine) tickStopless() bool {
	if m.ts.OverallStatus == trip.StatusCompleted {
		return false
	}
	if len(m.ts.Stops) == 0 { // walk-only
		if loc, ok := m.freshUserFix(); ok &&
			geo.HaversineM(loc, m.ts.Destination) <= config.ArrivalRadiusM {
			m.ts.OverallStatus = trip.StatusCompleted
			return true
		}
		return false // still walking
	}
	m.ts.OverallStatus = trip.StatusCompleted // normal trip finished
	return true
}

// evaluate applies §7.3 to the stop at idx (assumed to be the active stop).
func (m *Machine) evaluate(idx int) {
	stop := &m.ts.Stops[idx]

	// Approaching a transfer/ride-through stop while on the bus is normal; do
	// not run the MISSED check here (§7.3). Advance once the bus has reached it.
	if stop.StopType == trip.Transfer && m.onBus() {
		if armed(stop) {
			m.advance()
		}
		return
	}

	if !armed(stop) {
		stop.Status = trip.StatusExpected
		return
	}

	// Armed with a fresh fix: the distance call is unambiguous at the extremes —
	// inside the boarding radius is a board, beyond the missed radius is a miss.
	if _, ok := m.freshUserFix(); ok {
		switch d := stop.UserDistanceM; {
		case d > config.MissedRadiusM:
			m.setMissed(stop, idx)
			return
		case d <= config.BoardingRadiusM:
			stop.Status = trip.StatusActive
			m.advance()
			return
		}
		// In the ambiguous band (boarding, missed]: fall through to UNSURE.
	}

	// Either no fresh fix — the timer is the initiator (§8) and must not stall when
	// GPS is silent (backgrounded app, tunnel, GPS not yet acquired) — or a fresh
	// fix sitting in the ambiguous band. Ask the user (§10) rather than declaring
	// MISSED blind. If we already asked and neither a clarifying fix nor an answer
	// arrived within UnsureAnswerTimeoutS, escalate to MISSED and reroute.
	if stop.Status == trip.StatusMissed {
		return // already escalated; awaiting the reroute splice
	}
	if stop.Status == trip.StatusUnsure &&
		m.clock.Now()-m.unsureSince >= config.UnsureAnswerTimeoutS {
		m.setMissed(stop, idx)
		return
	}
	m.setUnsure(stop, idx)
}

// setUnsure marks the stop UNSURE and fires the OnUnsure hook only on the
// transition into UNSURE, so the boarding prompt is sent once rather than on
// every 1s tick while we wait for the answer or a clarifying fix. The transition
// also stamps unsureSince to arm the answer timeout (§10).
func (m *Machine) setUnsure(stop *trip.StopRecord, idx int) {
	if stop.Status == trip.StatusUnsure {
		return
	}
	stop.Status = trip.StatusUnsure
	m.unsureSince = m.clock.Now()
	if m.hooks.OnUnsure != nil {
		m.hooks.OnUnsure(m.ts, idx)
	}
}

// setMissed marks the stop MISSED and fires the OnMissed hook only on the
// transition into MISSED. Without this guard a fresh-GPS MISSED re-fires every
// tick until the async reroute splices the stop away, queuing duplicate reroutes.
func (m *Machine) setMissed(stop *trip.StopRecord, idx int) {
	if stop.Status == trip.StatusMissed {
		return
	}
	stop.Status = trip.StatusMissed
	if m.hooks.OnMissed != nil {
		m.hooks.OnMissed(m.ts, idx)
	}
}

// ResolveUnsure resolves an UNSURE stop from a client UNSURE_RESPONSE (§10):
// boarded=true settles it to ACTIVE and advances; boarded=false settles it to
// MISSED and fires the reroute hook. Returns true if anything changed.
func (m *Machine) ResolveUnsure(stopID string, boarded bool) bool {
	active := m.ts.ActiveStop()
	if active == nil || active.StopID != stopID || active.Status != trip.StatusUnsure {
		return false
	}
	if boarded {
		active.Status = trip.StatusActive
		m.advance()
		return true
	}
	idx := m.ts.CurrentStopIndex
	active.Status = trip.StatusMissed
	if m.hooks.OnMissed != nil {
		m.hooks.OnMissed(m.ts, idx)
	}
	return true
}

// OnBus reports whether the rider has boarded the current leg's bus. It is the
// exported form of onBus, used by the reroute layer to pick the reroute origin
// (next stop vs current location, §9).
func (m *Machine) OnBus() bool { return m.onBus() }

// onBus reports whether the rider has boarded the current leg's bus, i.e. the
// active leg is a BUS leg and we have advanced past its boarding (FETCHED) stop.
// At the boarding stop itself this is false, so its MISSED check runs.
func (m *Machine) onBus() bool {
	leg := m.ts.LegOf(m.ts.CurrentStopIndex)
	return leg != nil && leg.Mode == trip.ModeBus && m.ts.CurrentStopIndex > leg.StopStart
}

// advance moves to the next stop and reconciles statuses behind it (§7.4): every
// prior stop becomes COMPLETED, except the current bus leg's boarding stop,
// which stays ACTIVE to signal "you are on this bus" until the leg ends.
func (m *Machine) advance() {
	m.ts.CurrentStopIndex++
	m.markBehindCompleted()
	if m.ts.ActiveStop() == nil {
		m.ts.OverallStatus = trip.StatusCompleted
	} else {
		m.ts.OverallStatus = trip.StatusActive
	}
}

func (m *Machine) markBehindCompleted() {
	cur := m.ts.CurrentStopIndex
	keepActive := -1
	if leg := m.ts.LegOf(cur); leg != nil && leg.Mode == trip.ModeBus {
		keepActive = leg.StopStart
	}
	for i := 0; i < cur && i < len(m.ts.Stops); i++ {
		if i == keepActive && m.ts.Stops[i].Status == trip.StatusActive {
			continue
		}
		m.ts.Stops[i].Status = trip.StatusCompleted
	}
}

func (m *Machine) statuses() []trip.Status {
	out := make([]trip.Status, len(m.ts.Stops))
	for i := range m.ts.Stops {
		out[i] = m.ts.Stops[i].Status
	}
	return out
}

func sameStatuses(a, b []trip.Status) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
