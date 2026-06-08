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
	"github.com/tranzit-route-save/internal/geo"
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
	snapshot   chan snapshotReq
	replanPlan chan chan refreshPlan
	replanDone chan refreshApplyReq
	send       chan []byte

	// lastRoute is the raw Google route object for the journey as it stands: the
	// route the client POSTed, then the latest reroute's route. Served by the GET
	// /trips/{id} pull path so a client can fetch the current polyline on demand.
	lastRoute json.RawMessage

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

	createdAt int64 // server time the session was created (attach-grace watchdog)
	attached  bool  // a client WebSocket has attached at least once
}

func newSession(ts *trip.TripState, destPlaceID string, initialRoute json.RawMessage, deps Deps, mgr *Manager) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Session{
		deps:        deps,
		mgr:         mgr,
		trip:        ts,
		destPlaceID: destPlaceID,
		lastRoute:   initialRoute,
		clientMsgs:  make(chan []byte, 16),
		rtArrivals:  make(chan []rtfeed.Arrival, 4),
		rerouteOut:  make(chan rerouteResult, 4),
		attach:      make(chan *websocket.Conn, 1),
		snapshot:    make(chan snapshotReq),
		replanPlan:  make(chan chan refreshPlan),
		replanDone:  make(chan refreshApplyReq),
		send:        make(chan []byte, sendBuffer),
		ctx:         ctx,
		cancel:      cancel,
		done:        make(chan struct{}),
		debug:       stateLogEnabled(),
		createdAt:   deps.Clock.Now(),
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
			// Tear down a session that POST /trips created but no client ever attached
			// to, so an orphaned trip doesn't tick forever. A normal disconnect is
			// caught by readLoop's error; the half-open peer by the ws read deadline.
			if !s.attached && s.deps.Clock.Now()-s.createdAt > config.SessionAttachGraceS {
				log.Printf("session %s: no client attached within %ds; closing",
					shortID(s.trip.SessionID), config.SessionAttachGraceS)
				s.Close()
				return
			}
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

		case req := <-s.snapshot:
			// Build the snapshot on the loop goroutine so the GET reads trip state
			// where it is mutated, with no locks (§18.3).
			req.reply <- wsproto.SnapshotMessage(s.trip, s.deps.Clock.Now(), s.lastRoute)

		case reply := <-s.replanPlan:
			// Phase 1 of a GET-triggered refresh: compute origin/keep on the loop.
			reply <- s.planRefresh()

		case req := <-s.replanDone:
			// Phase 3: splice the freshly-fetched route on, return the new snapshot.
			req.reply <- s.applyRefresh(req)
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

// snapshotReq asks the loop to build a consistent STATE+route snapshot for the
// GET /trips/{id} pull path; reply carries it back to the HTTP goroutine.
type snapshotReq struct {
	reply chan wsproto.SnapshotMsg
}

// Snapshot returns the current STATE export plus the latest route (polyline) for
// an HTTP GET. It is built on the loop goroutine for a race-free read; ok is false
// if the session is closing.
func (s *Session) Snapshot() (wsproto.SnapshotMsg, bool) {
	reply := make(chan wsproto.SnapshotMsg, 1)
	select {
	case s.snapshot <- snapshotReq{reply: reply}:
	case <-s.done:
		return wsproto.SnapshotMsg{}, false
	}
	select {
	case m := <-reply:
		return m, true
	case <-s.done:
		return wsproto.SnapshotMsg{}, false
	}
}

// --- GET-triggered route refresh ---
//
// A GET /trips/{id} is a *refresh*, not just a read: it re-fetches the route for
// the remaining journey from the rider's current position to the destination,
// splices it onto the already-completed prefix, and returns the fresh snapshot —
// so the client never sees stale data beyond the part of the trip already done.
// Network I/O stays off the loop (§18.3): the loop computes the plan and applies
// the result; the HTTP goroutine does the /route call in between.

// refreshPlan is the loop-computed input for a re-plan: where to fetch from and
// how much of the current trip to keep.
type refreshPlan struct {
	origin         geo.LatLng
	dest           geo.LatLng
	sessionID      string
	keepThroughIdx int
	ok             bool // false when there is nothing to re-plan (no stops yet)
}

// refreshApplyReq carries an off-loop fetched re-plan back to the loop to splice;
// reply returns the resulting snapshot.
type refreshApplyReq struct {
	keepThroughIdx int
	newTrip        *trip.TripState
	raw            json.RawMessage
	reply          chan wsproto.SnapshotMsg
}

// planRefresh computes the re-plan origin and kept prefix on the loop goroutine.
// Origin is the rider's fresh GPS fix, else the stop they are currently heading to
// (so we always have a valid origin). keepThroughIdx keeps only the completed
// prefix — everything from the active stop onward is re-fetched.
func (s *Session) planRefresh() refreshPlan {
	ts := s.trip
	if len(ts.Stops) == 0 {
		return refreshPlan{ok: false}
	}
	origin, ok := s.machine.FreshUserFix()
	if !ok {
		idx := ts.CurrentStopIndex
		if idx < 0 {
			idx = 0
		}
		if idx >= len(ts.Stops) {
			idx = len(ts.Stops) - 1
		}
		origin = ts.Stops[idx].Loc()
	}
	return refreshPlan{
		origin:         origin,
		dest:           ts.Destination,
		sessionID:      ts.SessionID,
		keepThroughIdx: ts.CurrentStopIndex - 1, // keep completed stops only (§9.3 Case 2)
		ok:             true,
	}
}

// applyRefresh splices the freshly-built remaining trip onto the kept prefix,
// updates the served route, and pushes a fresh STATE so any attached WS client
// stays in sync. Runs on the loop goroutine; returns the new snapshot.
func (s *Session) applyRefresh(req refreshApplyReq) wsproto.SnapshotMsg {
	trip.Splice(s.trip, req.keepThroughIdx, req.newTrip)
	s.lastRoute = req.raw
	s.trip.LastReroute = s.deps.Clock.Now()
	s.trip.CurrentStopIndex = req.keepThroughIdx + 1 // re-enter at the first new stop
	s.trip.OverallStatus = trip.StatusActive
	if s.debug {
		log.Printf("session %s: REFRESH (GET) keep=%d legs=%d stops=%d",
			shortID(s.trip.SessionID), req.keepThroughIdx, len(s.trip.Legs), len(s.trip.Stops))
	}
	s.forcePushState()
	return wsproto.SnapshotMessage(s.trip, s.deps.Clock.Now(), s.lastRoute)
}

// RefreshRoute re-fetches the remaining route and returns the updated snapshot for
// a GET /trips/{id}. It computes the plan on the loop, calls /route + rebuilds off
// the loop, then applies the splice on the loop. On any failure (no route service,
// route fetch error, or an empty route) it falls back to the current snapshot —
// the last known-good route — rather than wiping a valid trip. ok is false only
// when the session is closing.
func (s *Session) RefreshRoute() (wsproto.SnapshotMsg, bool) {
	planReply := make(chan refreshPlan, 1)
	select {
	case s.replanPlan <- planReply:
	case <-s.done:
		return wsproto.SnapshotMsg{}, false
	}
	var plan refreshPlan
	select {
	case plan = <-planReply:
	case <-s.done:
		return wsproto.SnapshotMsg{}, false
	}

	if !plan.ok || s.deps.Routes == nil || s.destPlaceID == "" {
		return s.Snapshot()
	}

	route, raw, err := s.deps.Routes.Route(s.ctx, plan.origin, s.destPlaceID)
	var newTrip *trip.TripState
	if err == nil {
		newTrip, err = trip.BuildTrip(plan.sessionID, plan.origin, plan.dest, route, s.deps.Data, s.deps.Clock.Now())
	}
	if err != nil || newTrip == nil || len(newTrip.Legs) == 0 || len(raw) == 0 {
		if err != nil {
			log.Printf("session %s: refresh failed: %v", shortID(plan.sessionID), err)
		}
		return s.Snapshot() // graceful: serve the last known-good route
	}

	applyReply := make(chan wsproto.SnapshotMsg, 1)
	apply := refreshApplyReq{keepThroughIdx: plan.keepThroughIdx, newTrip: newTrip, raw: raw, reply: applyReply}
	select {
	case s.replanDone <- apply:
	case <-s.done:
		return wsproto.SnapshotMsg{}, false
	}
	select {
	case m := <-applyReply:
		return m, true
	case <-s.done:
		return wsproto.SnapshotMsg{}, false
	}
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
	s.attached = true
	go s.writeLoop(conn)
	go s.readLoop(conn)
	s.forcePushState()
}

// readLoop pumps client frames into the loop. It enforces a read deadline that the
// pong handler extends on every keepalive pong, so a silently-dropped peer (no TCP
// FIN) fails ReadMessage within WSPongWaitS and the deferred Close fires — instead
// of blocking here forever and leaving the session ticking.
func (s *Session) readLoop(conn *websocket.Conn) {
	defer s.Close()
	pongWait := config.WSPongWaitS * time.Second
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		// Any client frame also proves the peer is alive; extend the deadline.
		conn.SetReadDeadline(time.Now().Add(pongWait))
		select {
		case s.clientMsgs <- raw:
		case <-s.done:
			return
		}
	}
}

// writeLoop drains the send queue and emits a keepalive ping every WSPingIntervalS
// so the peer's pong keeps readLoop's deadline alive. Write deadlines keep a stuck
// socket from blocking the loop indefinitely.
func (s *Session) writeLoop(conn *websocket.Conn) {
	ping := time.NewTicker(config.WSPingIntervalS * time.Second)
	defer ping.Stop()
	writeWait := config.WSPingIntervalS * time.Second
	for {
		select {
		case <-s.done:
			return
		case msg := <-s.send:
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				s.Close()
				return
			}
		case <-ping.C:
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
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
