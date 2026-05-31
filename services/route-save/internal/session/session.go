package session

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/tranzit-route-save/internal/config"
	"github.com/tranzit-route-save/internal/rtfeed"
	"github.com/tranzit-route-save/internal/state"
	"github.com/tranzit-route-save/internal/trip"
	"github.com/tranzit-route-save/internal/wsproto"
)

// stateLogEnabled controls the tabular STATE logging to stdout (docker logs).
// On by default; set LOG_STATE=0 to silence. Read lazily so godotenv has loaded.
func stateLogEnabled() bool { return os.Getenv("LOG_STATE") != "0" }

// heartbeatTicks is how many 1s ticks between heartbeat table logs (so the live
// timings are visible even when no STATE is sent).
const heartbeatTicks = 5

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

	debug    bool // tabular STATE logging to stdout
	tickSeen int  // tick counter for the heartbeat table
	dirty    bool // a state change is pending a downstream STATE flush
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
		debug:       stateLogEnabled(),
	}
	s.machine = state.New(ts, deps.Clock, state.Hooks{
		OnMissed: s.onMissed,
		OnUnsure: s.onUnsure,
	})
	return s
}

// run is the event loop. It owns all TripState mutation. The 1s tick drives the
// state machine; STATE is not pushed inline but coalesced and flushed to the
// client by the slower ClientPushIntervalS ticker (on-change, throttled), so a
// burst of changes within one window collapses to a single versioned frame.
func (s *Session) run() {
	tick := time.NewTicker(config.TickIntervalS * time.Second)
	rt := time.NewTicker(config.RTUpdateIntervalS * time.Second)
	push := time.NewTicker(config.ClientPushIntervalS * time.Second)
	defer tick.Stop()
	defer rt.Stop()
	defer push.Stop()

	for {
		select {
		case <-s.done:
			return

		case <-tick.C:
			if s.machine.OnTick() {
				s.markDirty()
			}
			s.dispatchPendingReroute()
			if s.tickSeen++; s.debug && s.tickSeen%heartbeatTicks == 0 {
				s.logTable("tick")
			}

		case <-push.C:
			s.flushState()

		case <-rt.C:
			s.startRTFetch()

		case arr := <-s.rtArrivals:
			s.machine.OnRTUpdate(toStateArrivals(arr))
			s.markDirty()

		case raw := <-s.clientMsgs:
			if s.handleClient(raw) {
				s.markDirty()
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
		// §16.1 deferred: just re-send the current full state, immediately.
		s.forcePushState()
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
	s.forcePushState()
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

// markDirty records that trip state changed and a STATE frame is owed to the
// client. The frame goes out on the next ClientPushIntervalS flush, coalescing
// rapid changes into one.
func (s *Session) markDirty() { s.dirty = true }

// flushState pushes a STATE frame if one is pending, bumping the version once so
// the client can detect it. No-op when nothing changed (idle window → no frame).
func (s *Session) flushState() {
	if !s.dirty {
		return
	}
	s.trip.StateVersion++
	s.dirty = false
	s.pushState()
}

// forcePushState emits a STATE immediately, bypassing the throttle. Used for the
// initial attach and right after a reroute, where the client must not wait.
func (s *Session) forcePushState() {
	s.trip.StateVersion++
	s.dirty = false
	s.pushState()
}

func (s *Session) pushState() {
	if s.debug {
		s.logTable("SENT->client")
	}
	s.enqueue(wsproto.StateMessage(s.trip, s.deps.Clock.Now()))
}

// logTable prints the current trip as a table to stdout (docker logs). t-rem is
// computed live (eta − server now) for every stop, so the countdown is visible
// even between status changes. The ">>" marker is the active stop.
func (s *Session) logTable(tag string) {
	ts := s.trip
	now := s.deps.Clock.Now()

	var b strings.Builder
	fmt.Fprintf(&b, "\n==== TRIP %s  v%d  overall=%s  active=%d/%d  (%s) ====\n",
		shortID(ts.SessionID), ts.StateVersion, ts.OverallStatus,
		ts.CurrentStopIndex, len(ts.Stops), tag)
	fmt.Fprintf(&b, "  GPS: %s  radii: board≤%.0fm unsure≤%.0fm missed>%.0fm\n",
		s.gpsLine(now), config.BoardingRadiusM, config.MissedRadiusM, config.MissedRadiusM)
	fmt.Fprintf(&b, "    %-3s %-8s %-9s %-5s %-10s %-11s %-7s %-7s %s\n",
		"idx", "type", "status", "route", "trip", "eta", "t-rem", "dist", "stop")
	for i := range ts.Stops {
		st := &ts.Stops[i]
		mark := "  "
		dist := "-"
		if i == ts.CurrentStopIndex {
			mark = ">>"
			dist = fmt.Sprintf("%.0fm", st.UserDistanceM)
		}
		trem := "-"
		if st.BusArrivalTime != 0 {
			trem = fmt.Sprintf("%+ds", st.BusArrivalTime-now)
		}
		fmt.Fprintf(&b, " %s %-3d %-8s %-9s %-5s %-10s %-11d %-7s %-7s %s\n",
			mark, i, st.StopType, st.Status, st.RouteID, shortID(st.TripID),
			st.BusArrivalTime, trem, dist, st.StopName)
	}
	log.Print(b.String())
}

// gpsLine summarises the rider's last fix for the log table: coordinates, fix
// age, and a STALE marker once the fix is too old to drive the MISSED check
// (config.LocationStaleAfterS). "no fix" until the first LOCATION arrives.
func (s *Session) gpsLine(now int64) string {
	loc := s.trip.UserLocation
	if !loc.Valid {
		return "no fix yet"
	}
	age := now - loc.RecvAt
	stale := ""
	if age > config.LocationStaleAfterS {
		stale = " STALE"
	}
	return fmt.Sprintf("%.5f,%.5f age=%ds%s", loc.Loc.Lat, loc.Loc.Lng, age, stale)
}

func shortID(s string) string {
	if len(s) > 10 {
		return s[:10]
	}
	return s
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
