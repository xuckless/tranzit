package session

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/tranzit-route-save/internal/config"
	"github.com/tranzit-route-save/internal/rtfeed"
	"github.com/tranzit-route-save/internal/state"
	"github.com/tranzit-route-save/internal/trip"
	"github.com/tranzit-route-save/internal/wsproto"
)

// sendBuffer bounds the outbound frame queue. STATE frames are full snapshots,
// so an overrun simply means the client gets the next snapshot instead.
const sendBuffer = 32

// Session is one live trip actor.
type Session struct {
	deps    Deps
	mgr     *Manager
	machine *state.Machine
	trip    *trip.TripState

	destPlaceID string

	clientMsgs chan []byte
	rtArrivals chan []rtfeed.Arrival
	rerouteOut chan rerouteResult
	attach     chan *websocket.Conn
	send       chan []byte

	ctx    context.Context
	cancel context.CancelFunc
	done   chan struct{}
	close  sync.Once

	// pending is set by the OnMissed hook (which runs on the loop goroutine) and
	// dispatched after the current event is handled, so the network /route call
	// never blocks the loop.
	pending *rerouteReq
}

func newSession(ts *trip.TripState, destPlaceID string, deps Deps, mgr *Manager) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{
		deps:        deps,
		mgr:         mgr,
		trip:        ts,
		destPlaceID: destPlaceID,
		clientMsgs:  make(chan []byte, 16),
		rtArrivals:  make(chan []rtfeed.Arrival, 4),
		rerouteOut:  make(chan rerouteResult, 4),
		attach:      make(chan *websocket.Conn, 1),
		send:        make(chan []byte, sendBuffer),
		ctx:         ctx,
		cancel:      cancel,
		done:        make(chan struct{}),
	}
	s.machine = state.New(ts, deps.Clock, state.Hooks{
		OnMissed: s.onMissed,
		OnUnsure: s.onUnsure,
	})
	return s
}

// run is the event loop. It owns all TripState mutation.
func (s *Session) run() {
	tick := time.NewTicker(config.TickIntervalS * time.Second)
	rt := time.NewTicker(config.RTUpdateIntervalS * time.Second)
	defer tick.Stop()
	defer rt.Stop()

	for {
		select {
		case <-s.done:
			return

		case <-tick.C:
			if s.machine.OnTick() {
				s.bumpAndPushState()
			}
			s.dispatchPendingReroute()

		case <-rt.C:
			s.startRTFetch()

		case arr := <-s.rtArrivals:
			s.machine.OnRTUpdate(toStateArrivals(arr))
			s.bumpAndPushState()

		case raw := <-s.clientMsgs:
			if s.handleClient(raw) {
				s.bumpAndPushState()
			}
			s.dispatchPendingReroute()

		case res := <-s.rerouteOut:
			s.applyReroute(res)

		case conn := <-s.attach:
			s.onAttach(conn)
		}
	}
}

// handleClient processes one client frame. Returns true if state changed.
func (s *Session) handleClient(raw []byte) bool {
	typ, err := wsproto.DecodeType(raw)
	if err != nil {
		log.Printf("session %s: bad client frame: %v", s.trip.SessionID, err)
		return false
	}
	switch typ {
	case wsproto.TypeLocation:
		var msg wsproto.LocationMsg
		if json.Unmarshal(raw, &msg) != nil {
			return false
		}
		s.machine.OnLocationUpdate(trip.UserLocation{
			Loc:        geoLatLng(msg.Lat, msg.Lng),
			SpeedMPS:   msg.SpeedMPS,
			HeadingDeg: msg.HeadingDeg,
			TS:         msg.TS,
		})
		return true

	case wsproto.TypeUnsureResponse:
		var msg wsproto.UnsureResponseMsg
		if json.Unmarshal(raw, &msg) != nil {
			return false
		}
		return s.machine.ResolveUnsure(msg.StopID, msg.Boarded)

	case wsproto.TypeResume:
		// §16.1 deferred: just re-send the current full state.
		s.pushState()
		return false

	default:
		return false
	}
}

// startRTFetch fires an async RT poll for the active trips and posts the result
// back to the loop.
func (s *Session) startRTFetch() {
	tripIDs := s.activeTripIDs()
	if len(tripIDs) == 0 {
		return
	}
	go func() {
		arr, err := s.deps.RT.Fetch(s.ctx, tripIDs)
		if err != nil {
			log.Printf("session %s: rt fetch: %v", s.trip.SessionID, err)
			return
		}
		select {
		case s.rtArrivals <- arr:
		case <-s.done:
		}
	}()
}

func (s *Session) activeTripIDs() []string {
	seen := map[string]bool{}
	var ids []string
	for _, leg := range s.trip.Legs {
		if leg.Mode == trip.ModeBus && leg.TripID != "" && !seen[leg.TripID] {
			seen[leg.TripID] = true
			ids = append(ids, leg.TripID)
		}
	}
	return ids
}

// --- WebSocket attach / teardown ---

// Attach binds a client WebSocket to the session by handing the connection to
// the event loop, which then starts the reader/writer and pushes the initial
// STATE. Going through the loop keeps all TripState access on one goroutine. Only
// one connection is expected per trip.
func (s *Session) Attach(conn *websocket.Conn) {
	select {
	case s.attach <- conn:
	case <-s.done:
		conn.Close()
	}
}

// onAttach runs on the loop goroutine: it wires up the connection and pushes the
// first full STATE export.
func (s *Session) onAttach(conn *websocket.Conn) {
	go s.writeLoop(conn)
	go s.readLoop(conn)
	s.pushState()
}

func (s *Session) readLoop(conn *websocket.Conn) {
	defer s.Close()
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		select {
		case s.clientMsgs <- raw:
		case <-s.done:
			return
		}
	}
}

func (s *Session) writeLoop(conn *websocket.Conn) {
	for {
		select {
		case <-s.done:
			return
		case msg := <-s.send:
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				s.Close()
				return
			}
		}
	}
}

// Close tears the session down idempotently: cancels async work, stops the loop,
// and removes the session from the registry. WS close or an explicit DELETE both
// land here ("closed anytime").
func (s *Session) Close() {
	s.close.Do(func() {
		s.cancel()
		close(s.done)
		s.mgr.remove(s.trip.SessionID)
	})
}

// --- outbound helpers ---

func (s *Session) bumpAndPushState() {
	s.trip.StateVersion++
	s.pushState()
}

func (s *Session) pushState() {
	s.enqueue(wsproto.StateMessage(s.trip))
}

// enqueue marshals and queues a server→client message, dropping it if the client
// is not draining (the next snapshot supersedes a dropped STATE).
func (s *Session) enqueue(msg any) {
	raw, err := json.Marshal(msg)
	if err != nil {
		return
	}
	select {
	case s.send <- raw:
	default:
		// buffer full: client slow or absent; drop.
	}
}

func toStateArrivals(in []rtfeed.Arrival) []state.Arrival {
	out := make([]state.Arrival, len(in))
	for i, a := range in {
		out[i] = state.Arrival{TripID: a.TripID, StopID: a.StopID, PredictedArrival: a.PredictedArrival}
	}
	return out
}
