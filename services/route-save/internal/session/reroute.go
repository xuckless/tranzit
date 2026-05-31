package session

import (
	"log"

	"github.com/tranzit-route-save/internal/geo"
	"github.com/tranzit-route-save/internal/trip"
	"github.com/tranzit-route-save/internal/wsproto"
)

// rerouteReq is recorded by the OnMissed hook and dispatched off-loop.
type rerouteReq struct {
	reason         string
	onBus          bool
	origin         geo.LatLng
	keepThroughIdx int
	notify         *wsproto.NotifyMsg // sent on dispatch (Case 1)
}

// rerouteResult carries an async /route + rebuild back to the loop.
type rerouteResult struct {
	req     rerouteReq
	newTrip *trip.TripState
	err     error
}

// onMissed is the state.Hooks.OnMissed callback. It runs on the loop goroutine
// during evaluation; it only *records* the reroute, which is dispatched after.
func (s *Session) onMissed(ts *trip.TripState, stopIdx int) {
	if s.deps.Routes == nil || s.destPlaceID == "" {
		return // reroute not available; leave the stop MISSED
	}
	req := rerouteReq{reason: "MISSED", onBus: s.machine.OnBus()}

	if req.onBus {
		// Case 1 (§9.1): assume we reach the next stop on the current bus; reroute
		// from there, and warn that the transfer will be missed.
		nextIdx := stopIdx + 1
		if nextIdx >= len(ts.Stops) {
			nextIdx = stopIdx
		}
		req.origin = ts.Stops[nextIdx].Loc()
		req.keepThroughIdx = nextIdx
		req.notify = &wsproto.NotifyMsg{
			Type:    wsproto.TypeNotify,
			Kind:    "TRANSFER_AT_RISK",
			StopID:  ts.Stops[stopIdx].StopID,
			Message: "Your transfer will be missed. Rerouting.",
		}
	} else {
		// Case 2 (§9.2): reroute from the user's current location.
		req.origin = ts.UserLocation.Loc
		req.keepThroughIdx = ts.CurrentStopIndex - 1
	}

	// Make the location that drove the decision explicit in docker logs: the
	// rider's last fix, how far it was from the missed stop, and the origin the
	// new route will be fetched from.
	missed := &ts.Stops[stopIdx]
	caseName := "Case2-fromUser"
	if req.onBus {
		caseName = "Case1-fromNextStop"
	}
	log.Printf("session %s: MISSED stop=%s dist=%.0fm user=%.5f,%.5f onBus=%t origin=%.5f,%.5f (%s)",
		shortID(ts.SessionID), missed.StopID, missed.UserDistanceM,
		ts.UserLocation.Loc.Lat, ts.UserLocation.Loc.Lng, req.onBus,
		req.origin.Lat, req.origin.Lng, caseName)

	s.pending = &req
}

// onUnsure prompts the client to confirm boarding (§10). UNSURE does not reroute
// on its own; the answer arrives as UNSURE_RESPONSE.
func (s *Session) onUnsure(ts *trip.TripState, stopIdx int) {
	if s.debug {
		log.Printf("session %s: NOTIFY->client CONFIRM_BOARDING stop=%s",
			shortID(ts.SessionID), ts.Stops[stopIdx].StopID)
	}
	s.enqueue(wsproto.NotifyMsg{
		Type:             wsproto.TypeNotify,
		Kind:             "CONFIRM_BOARDING",
		StopID:           ts.Stops[stopIdx].StopID,
		RequiresResponse: true,
		Message:          "Did you board the bus?",
	})
}

// dispatchPendingReroute launches the async /route fetch for a recorded reroute.
func (s *Session) dispatchPendingReroute() {
	if s.pending == nil {
		return
	}
	req := *s.pending
	s.pending = nil
	if req.notify != nil {
		if s.debug {
			log.Printf("session %s: NOTIFY->client %s stop=%s",
				shortID(s.trip.SessionID), req.notify.Kind, req.notify.StopID)
		}
		s.enqueue(*req.notify)
	}
	// Capture immutable trip fields on the loop; the fetch goroutine must not
	// read s.trip directly.
	go s.fetchReroute(req, s.trip.SessionID, s.trip.Destination)
}

// fetchReroute calls route-service and rebuilds the remaining legs off the loop,
// then posts the result back for splicing.
func (s *Session) fetchReroute(req rerouteReq, sessionID string, dest geo.LatLng) {
	route, err := s.deps.Routes.Route(s.ctx, req.origin, s.destPlaceID)
	var newTrip *trip.TripState
	if err == nil {
		newTrip, err = trip.BuildTrip(sessionID, req.origin, dest, route, s.deps.Data)
	}
	select {
	case s.rerouteOut <- rerouteResult{req: req, newTrip: newTrip, err: err}:
	case <-s.done:
	}
}

// applyReroute splices the rebuilt legs onto the kept prefix (§9.3) and pushes
// REROUTE + a fresh STATE. Runs on the loop goroutine.
func (s *Session) applyReroute(res rerouteResult) {
	if res.err != nil {
		log.Printf("session %s: reroute failed: %v", s.trip.SessionID, res.err)
		return
	}
	trip.Splice(s.trip, res.req.keepThroughIdx, res.newTrip)
	s.trip.LastReroute = s.deps.Clock.Now()
	if !res.req.onBus {
		// Re-enter the machine at the first new stop (§9.2).
		s.trip.CurrentStopIndex = res.req.keepThroughIdx + 1
	}
	s.trip.OverallStatus = trip.StatusActive

	if s.debug {
		log.Printf("session %s: REROUTE->client reason=%s onBus=%t from=%.5f,%.5f legs=%d",
			shortID(s.trip.SessionID), res.req.reason, res.req.onBus,
			res.req.origin.Lat, res.req.origin.Lng, len(s.trip.Legs))
	}
	s.enqueue(wsproto.RerouteMessage(s.trip, res.req.reason,
		wsproto.LatLng{Lat: res.req.origin.Lat, Lng: res.req.origin.Lng}))
	s.forcePushState()
}

// geoLatLng is a small constructor used by the client-frame handlers.
func geoLatLng(lat, lng float64) geo.LatLng { return geo.LatLng{Lat: lat, Lng: lng} }
