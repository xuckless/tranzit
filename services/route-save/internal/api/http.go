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
	"net/http"

	"github.com/gorilla/websocket"

	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
	"github.com/tranzit-route-save/internal/session"
	"github.com/tranzit-route-save/internal/trip"
)

// Server wires the session manager and trip-build datasource to HTTP handlers.
type Server struct {
	mgr      *session.Manager
	data     datasource.DataSource
	upgrader websocket.Upgrader
}

// NewServer builds the API server. data is used to resolve+load stops when
// building a trip from the posted route.
func NewServer(mgr *session.Manager, data datasource.DataSource) *Server {
	return &Server{
		mgr:  mgr,
		data: data,
		upgrader: websocket.Upgrader{
			// Trust is handled upstream; the client is the Tranzit app.
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
}

// Handler returns the routed mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /trips", s.handleStart)
	mux.HandleFunc("GET /trips/{id}/ws", s.handleWS)
	mux.HandleFunc("DELETE /trips/{id}", s.handleStop)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleStart parses the posted route, builds the trip, and starts a session.
func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	var req StartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	if len(req.Route) == 0 {
		http.Error(w, "missing route", http.StatusBadRequest)
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
		http.Error(w, fmt.Sprintf("build trip: %v", err), http.StatusUnprocessableEntity)
		return
	}
	if req.UserID != nil {
		ts.UserID = req.UserID
	}

	s.mgr.Create(ts, req.DestinationPlaceID)
	writeJSON(w, http.StatusCreated, StartResponse{
		SessionID: sessionID,
		WSURL:     "/trips/" + sessionID + "/ws",
	})
}

// handleWS upgrades and attaches the client connection to an existing session.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	sess := s.mgr.Get(r.PathValue("id"))
	if sess == nil {
		http.Error(w, "unknown session", http.StatusNotFound)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the error
	}
	sess.Attach(conn)
}

// handleStop tears a session down (idempotent).
func (s *Server) handleStop(w http.ResponseWriter, r *http.Request) {
	if sess := s.mgr.Get(r.PathValue("id")); sess != nil {
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
