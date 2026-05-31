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
// distance (§7.1).
func (m *Machine) OnLocationUpdate(loc trip.UserLocation) {
	loc.Valid = true
	m.ts.UserLocation = loc
	if active := m.ts.ActiveStop(); active != nil {
		active.UserDistanceM = geo.HaversineM(loc.Loc, active.Loc())
	}
}

// OnTick recomputes the active stop's TimeRemaining and evaluates it. It returns
// true if any stop status or the current index changed, so a caller can decide
// whether to push a new STATE frame.
func (m *Machine) OnTick() bool {
	active := m.ts.ActiveStop()
	if active == nil {
		if m.ts.OverallStatus != trip.StatusCompleted {
			m.ts.OverallStatus = trip.StatusCompleted
			return true
		}
		return false
	}

	beforeIdx := m.ts.CurrentStopIndex
	beforeStatus := m.statuses()

	active.TimeRemainingS = int(active.BusArrivalTime - m.clock.Now())
	m.evaluate(m.ts.CurrentStopIndex)

	return beforeIdx != m.ts.CurrentStopIndex || !sameStatuses(beforeStatus, m.statuses())
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

	// Armed: make the call from the latest sampled distance.
	switch d := stop.UserDistanceM; {
	case d > config.MissedRadiusM:
		stop.Status = trip.StatusMissed
		if m.hooks.OnMissed != nil {
			m.hooks.OnMissed(m.ts, idx)
		}
	case d > config.BoardingRadiusM:
		stop.Status = trip.StatusUnsure
		if m.hooks.OnUnsure != nil {
			m.hooks.OnUnsure(m.ts, idx)
		}
	default:
		stop.Status = trip.StatusActive
		m.advance()
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
