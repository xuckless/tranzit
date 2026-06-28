// Package api is the HTTP/WebSocket surface of Route Save: the client POSTs a
// route to start a trip, then opens a per-trip WebSocket for the live STATE
// stream (doc §13). It can tear the trip down anytime by closing the socket or
// calling DELETE.
package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/gorilla/websocket"

	"github.com/tranzit-route-save/internal/auth"
	"github.com/tranzit-route-save/internal/config"
	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
	"github.com/tranzit-route-save/internal/routeclient"
	"github.com/tranzit-route-save/internal/session"
	"github.com/tranzit-route-save/internal/trip"
)

// Server wires the session manager and trip-build datasource to HTTP handlers.
type Server struct {
	mgr      *session.Manager
	data     datasource.DataSource
	otp      routeclient.OTPClient // server-owned OTP fetch for POST /tranzit-route; may be nil
	verifier auth.Verifier         // verifies Supabase JWTs on every route except /health
	upgrader websocket.Upgrader
}

// NewServer builds the API server. data is used to resolve+load stops when
// building a trip from the posted route. otp is the OpenTripPlanner client the
// server-owned POST /tranzit-route path fetches with; pass nil to disable that path.
// verifier authenticates every request except GET /health.
func NewServer(mgr *session.Manager, data datasource.DataSource, otp routeclient.OTPClient, verifier auth.Verifier) *Server {
	return &Server{
		mgr:      mgr,
		data:     data,
		otp:      otp,
		verifier: verifier,
		upgrader: websocket.Upgrader{
			// Trust is handled upstream; the client is the Tranzit app.
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
}

// Handler returns the routed mux. GET /health stays open; every other route is
// wrapped in RequireAuth (the catch-all "/" pattern), so a verified Supabase JWT —
// and, via the context, the owner UUID — is guaranteed by the time a handler runs.
func (s *Server) Handler() http.Handler {
	protected := http.NewServeMux()
	protected.HandleFunc("POST /trips", s.handleStart)
	protected.HandleFunc("POST /tranzit-route", s.handleStartOTP)
	protected.HandleFunc("GET /trips/{id}", s.handleGet)
	protected.HandleFunc("GET /trips/{id}/ws", s.handleWS)
	protected.HandleFunc("DELETE /trips/{id}", s.handleStop)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.Handle("/", auth.RequireAuth(s.verifier, protected))
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleStart parses the posted route, builds the trip, and starts a session. The
// route style is selected by req.Source: "opentrip" routes go through the OTP parser
// and start an OTP session (reroutes call /route/otp from the dest coords); anything
// else is the Google place-ID path.
func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	var req StartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if len(req.Route) == 0 {
		http.Error(w, "missing route", http.StatusBadRequest)
		return
	}
	if req.Source == directions.SourceOpenTrip {
		s.startPostedOTP(w, uid, req)
		return
	}
	if req.DestinationPlaceID == "" {
		http.Error(w, "missing destination_place_id", http.StatusBadRequest)
		return
	}

	route, err := directions.ParseSingle(req.Route)
	if err != nil {
		http.Error(w, fmt.Sprintf("parse route: %v", err), http.StatusBadRequest)
		return
	}

	sessionID := newID()
	origin := latLng(req.Origin)
	dest := latLng(req.Destination)

	ts, err := trip.BuildTrip(sessionID, origin, dest, route, s.data, s.mgr.Now())
	if err != nil {
		// Log the build failure: without this a 422 leaves no trace in docker logs,
		// so a resolution gap (e.g. no in-order trip for a route) is invisible.
		log.Printf("POST /trips: build failed: %v", err)
		http.Error(w, fmt.Sprintf("build trip: %v", err), http.StatusUnprocessableEntity)
		return
	}
	ts.UserID = &uid

	s.mgr.Create(ts, uid, req.DestinationPlaceID, req.Route)
	log.Printf("POST /trips: session %s started — %d stops across %d legs",
		sessionID, len(ts.Stops), len(ts.Legs))
	writeJSON(w, http.StatusCreated, StartResponse{
		SessionID: sessionID,
		WSURL:     "/trips/" + sessionID + "/ws",
	})
}

// startPostedOTP starts an OTP session from a route the client fetched and POSTed
// (source="opentrip"). The destination is coords (not a place ID); reroutes re-fetch
// via /route/otp. The posted envelope is kept verbatim as the served route so its
// source tag stays intact for the client's OTP parser.
func (s *Server) startPostedOTP(w http.ResponseWriter, uid string, req StartRequest) {
	if isZeroLatLng(req.Destination) {
		http.Error(w, "missing destination {lat,lng} for opentrip route", http.StatusBadRequest)
		return
	}
	route, err := directions.ParseOTP(req.Route)
	if err != nil {
		http.Error(w, fmt.Sprintf("parse otp route: %v", err), http.StatusBadRequest)
		return
	}

	sessionID := newID()
	origin := latLng(req.Origin)
	dest := latLng(req.Destination)

	ts, err := trip.BuildTrip(sessionID, origin, dest, route, s.data, s.mgr.Now())
	if err != nil {
		log.Printf("POST /trips (otp): build failed: %v", err)
		http.Error(w, fmt.Sprintf("build trip: %v", err), http.StatusUnprocessableEntity)
		return
	}
	ts.UserID = &uid

	mode, num := otpProfile(req.Mode, req.NumItineraries)
	s.mgr.CreateOTP(ts, uid, mode, num, req.Route)
	log.Printf("POST /trips (otp): session %s started — %d stops across %d legs",
		sessionID, len(ts.Stops), len(ts.Legs))
	writeJSON(w, http.StatusCreated, StartResponse{
		SessionID: sessionID,
		WSURL:     "/trips/" + sessionID + "/ws",
	})
}

// handleStartOTP is the server-owned OTP path (POST /tranzit-route): the client sends
// only its position and destination as coordinates, Route Save fetches the route from
// OTP, picks the best itinerary, and starts tracking. It returns the chosen route so
// the client can render immediately without a follow-up GET.
func (s *Server) handleStartOTP(w http.ResponseWriter, r *http.Request) {
	if s.otp == nil {
		http.Error(w, "otp routing not configured", http.StatusBadGateway)
		return
	}
	uid, _ := auth.UserID(r.Context())
	var req OTPStartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if isZeroLatLng(req.Origin) {
		http.Error(w, "missing origin {lat,lng}", http.StatusBadRequest)
		return
	}
	if isZeroLatLng(req.Destination) {
		http.Error(w, "missing destination {lat,lng}", http.StatusBadRequest)
		return
	}

	origin := latLng(req.Origin)
	dest := latLng(req.Destination)
	mode, num := otpProfile(req.Mode, req.NumItineraries)

	route, raw, err := s.otp.RouteOTP(r.Context(), origin, dest, mode, num)
	if err != nil {
		log.Printf("POST /tranzit-route: otp fetch failed: %v", err)
		http.Error(w, fmt.Sprintf("otp fetch: %v", err), http.StatusBadGateway)
		return
	}

	sessionID := newID()
	ts, err := trip.BuildTrip(sessionID, origin, dest, route, s.data, s.mgr.Now())
	if err != nil {
		log.Printf("POST /tranzit-route: build failed: %v", err)
		http.Error(w, fmt.Sprintf("build trip: %v", err), http.StatusUnprocessableEntity)
		return
	}
	ts.UserID = &uid

	s.mgr.CreateOTP(ts, uid, mode, num, raw)
	log.Printf("POST /tranzit-route: session %s started — %d stops across %d legs",
		sessionID, len(ts.Stops), len(ts.Legs))
	writeJSON(w, http.StatusCreated, StartResponse{
		SessionID: sessionID,
		WSURL:     "/trips/" + sessionID + "/ws",
		Route:     raw,
	})
}

// otpProfile applies the OTP travel-profile defaults when the client omits them.
func otpProfile(mode string, num int) (string, int) {
	if mode == "" {
		mode = config.OTPDefaultMode
	}
	if num <= 0 {
		num = config.OTPDefaultNumItineraries
	}
	return mode, num
}

// handleGet refreshes and returns the trip snapshot. A GET is a re-plan, not just
// a read: Route Save re-fetches the route for the remaining journey (rider's
// current position → destination), splices it onto the already-completed prefix,
// and returns the fresh STATE export plus the new route (polyline). The client
// gets up-to-date directions on demand with no stale data beyond the completed
// part of the trip. If the re-fetch can't be made, the last known-good route is
// returned instead of failing.
func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	sess := s.mgr.Get(r.PathValue("id"))
	// A session owned by another user is indistinguishable from a missing one, so
	// the session id can't be probed by non-owners.
	if sess == nil || sess.Owner() != uid {
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	snap, ok := sess.RefreshRoute()
	if !ok {
		http.Error(w, "session closed", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, snap)
}

// handleWS upgrades and attaches the client connection to an existing session.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	sess := s.mgr.Get(r.PathValue("id"))
	// Gate the upgrade on ownership (token verified in RequireAuth via ?token=).
	if sess == nil || sess.Owner() != uid {
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the error
	}
	sess.Attach(conn)
}

// handleStop tears a session down (idempotent). Only the owner can tear down their
// trip; a non-owner (or unknown id) gets the same 204 without any teardown, so the
// call neither leaks existence nor lets one user stop another's trip.
func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	uid, _ := auth.UserID(r.Context())
	if sess := s.mgr.Get(r.PathValue("id")); sess != nil && sess.Owner() == uid {
		sess.Close()
	}
	w.WriteHeader(http.StatusNoContent)
}

func latLng(p *LatLng) geo.LatLng {
	if p == nil {
		return geo.LatLng{}
	}
	return geo.LatLng{Lat: p.Lat, Lng: p.Lng}
}

// isZeroLatLng reports whether a coordinate is absent or the null island (0,0) — the
// same "unset" test route-service uses for OTP origin/destination.
func isZeroLatLng(p *LatLng) bool {
	return p == nil || (p.Lat == 0 && p.Lng == 0)
}

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
