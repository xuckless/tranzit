// Package session wraps the pure core (trip + state machine) in the live service
// lifecycle (doc §13–§14, §9). Each trip runs as a single-goroutine actor: all
// TripState mutation happens on its event loop, fed by the 1s tick, the 30s RT
// poll, client WebSocket frames, and async reroute results. Nothing else touches
// the trip, so there are no locks on it.
package session

import (
	"encoding/json"
	"sync"

	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/routeclient"
	"github.com/tranzit-route-save/internal/rtfeed"
	"github.com/tranzit-route-save/internal/state"
	"github.com/tranzit-route-save/internal/trip"
)

// Deps are the collaborators a session needs; they are interfaces so the whole
// lifecycle is testable with fakes.
type Deps struct {
	Data   datasource.DataSource
	RT     rtfeed.Source
	Routes routeclient.Client
	Clock  state.Clock
}

// Manager is the registry of live sessions.
type Manager struct {
	deps Deps
	mu   sync.RWMutex
	byID map[string]*Session
}

// NewManager builds a Manager with the given shared dependencies.
func NewManager(deps Deps) *Manager {
	if deps.Clock == nil {
		deps.Clock = state.SystemClock{}
	}
	return &Manager{deps: deps, byID: map[string]*Session{}}
}

// Create starts tracking a built trip with its (in-memory, never-persisted)
// destination place ID, launches the event loop, and returns the session.
// initialRoute is the raw Google route the client POSTed, retained so the GET
// /trips/{id} pull path can serve the current polyline before any reroute.
func (m *Manager) Create(ts *trip.TripState, destPlaceID string, initialRoute json.RawMessage) *Session {
	s := newSession(ts, destPlaceID, initialRoute, m.deps, m)
	m.mu.Lock()
	m.byID[ts.SessionID] = s
	m.mu.Unlock()
	go s.run()
	return s
}

// Now returns the shared clock's current Unix time, so HTTP handlers building a
// trip resolve against the same clock the sessions tick on.
func (m *Manager) Now() int64 { return m.deps.Clock.Now() }

// Get returns the session by id, or nil.
func (m *Manager) Get(id string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.byID[id]
}

// remove drops a session from the registry (called during teardown).
func (m *Manager) remove(id string) {
	m.mu.Lock()
	delete(m.byID, id)
	m.mu.Unlock()
}

// Count returns the number of live sessions (for diagnostics/tests).
func (m *Manager) Count() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return len(m.byID)
}

// CloseAll tears down every live session, used on graceful shutdown. It snapshots
// the registry under the lock first so each Close (which calls remove and takes
// the lock) does not deadlock. Close is idempotent (sync.Once).
func (m *Manager) CloseAll() {
	m.mu.RLock()
	sessions := make([]*Session, 0, len(m.byID))
	for _, s := range m.byID {
		sessions = append(sessions, s)
	}
	m.mu.RUnlock()
	for _, s := range sessions {
		s.Close()
	}
}
