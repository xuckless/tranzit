package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/tranzit-route-save/internal/api"
	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/directions"
	"github.com/tranzit-route-save/internal/geo"
	"github.com/tranzit-route-save/internal/routeclient"
	"github.com/tranzit-route-save/internal/rtfeed"
	"github.com/tranzit-route-save/internal/session"
	"github.com/tranzit-route-save/internal/state"
)

// fixtureNow pins the test clock; candidate boarding times sit ahead of it so the
// run is an upcoming (boardable) trip rather than a departed one excluded by §5.2's
// past-floor.
const fixtureNow = 2_000_000_000

// Test identities: the fake verifier maps opaque tokens to user ids. tokenA is the
// default actor; tokenB is a second user used for ownership checks. Any other token
// (or none) is rejected, mirroring the real 401 path.
const (
	tokenA = "tok-a"
	userA  = "user-a"
	tokenB = "tok-b"
	userB  = "user-b"
)

// fakeVerifier is an in-memory auth.Verifier for tests: known token → user id, all
// else an error (→ 401).
type fakeVerifier map[string]string

func (f fakeVerifier) Verify(_ context.Context, token string) (string, error) {
	if uid, ok := f[token]; ok {
		return uid, nil
	}
	return "", errors.New("fake verifier: unknown token")
}

// fixture matching testdata/route_single.json's entry/exit stops.
func newFixture() *datasource.Fixture {
	entry := geo.LatLng{Lat: 51.047742299999996, Lng: -114.07078329999999}
	exit := geo.LatLng{Lat: 51.0379, Lng: -114.08972}
	fx := datasource.NewFixture()
	stops := []datasource.Stop{
		{StopID: "e", Name: "WB 6 Av SW @ 3 St SW", Loc: entry, Sequence: 1, ArrivalTime: fixtureNow + 600, DepartureTime: fixtureNow + 600},
		{StopID: "x", Name: "WB 17 AV SW @ 11 ST SW fs", Loc: exit, Sequence: 2, ArrivalTime: fixtureNow + 1200},
	}
	fx.StopsByTrip["T"] = stops
	fx.TripsByRoute["2"] = []datasource.TripCandidate{{TripID: "T", Stops: stops}}
	return fx
}

func newTestServer(t *testing.T) (*httptest.Server, *session.Manager, *routeclient.Fake, *routeclient.OTPFake) {
	t.Helper()
	fx := newFixture()
	routes := &routeclient.Fake{}
	otp := &routeclient.OTPFake{}
	mgr := session.NewManager(session.Deps{
		Data:      fx,
		RT:        &rtfeed.Fake{},
		Routes:    routes,
		OTPRoutes: otp,
		Clock:     &state.FakeClock{T: fixtureNow},
	})
	verifier := fakeVerifier{tokenA: userA, tokenB: userB}
	return httptest.NewServer(api.NewServer(mgr, fx, otp, verifier).Handler()), mgr, routes, otp
}

// ─── auth-aware request helpers ───────────────────────────────────────────────
// REST calls carry the token as a Bearer header; the WS upgrade carries it as the
// ?token= query param (the RN client can't set headers on the upgrade). Pass an
// empty token to exercise the unauthenticated path.

func doPost(t *testing.T, url, token string, body []byte) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new POST request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	return resp
}

func doGet(t *testing.T, url, token string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	return resp
}

func doDelete(t *testing.T, url, token string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodDelete, url, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("DELETE %s: %v", url, err)
	}
	return resp
}

// dialWS opens the trip WebSocket, passing the token as the ?token= query param.
// It returns the dialer's error and HTTP response so callers can assert on a
// rejected upgrade (gorilla returns the response on ErrBadHandshake).
func dialWS(t *testing.T, srvURL, wsPath, token string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(srvURL, "http") + wsPath
	if token != "" {
		wsURL += "?token=" + url.QueryEscape(token)
	}
	return websocket.DefaultDialer.Dial(wsURL, nil)
}

func TestLifecycle_StartConnectStream(t *testing.T) {
	srv, mgr, _, _ := newTestServer(t)
	defer srv.Close()

	routeJSON, err := os.ReadFile("../../testdata/route_single.json")
	if err != nil {
		t.Fatalf("read route: %v", err)
	}
	body, _ := json.Marshal(map[string]any{
		"route":                json.RawMessage(routeJSON),
		"destination_place_id": "place-xyz",
	})

	// Start the trip.
	resp := doPost(t, srv.URL+"/trips", tokenA, body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want 201", resp.StatusCode)
	}
	var start api.StartResponse
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	resp.Body.Close()
	if start.SessionID == "" {
		t.Fatal("empty session_id")
	}
	if mgr.Count() != 1 {
		t.Fatalf("session count = %d, want 1", mgr.Count())
	}

	// Connect the WebSocket and read the initial STATE export.
	conn, _, err := dialWS(t, srv.URL, start.WSURL, tokenA)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}

	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read STATE: %v", err)
	}
	var frame struct {
		Type  string `json:"type"`
		Stops []struct {
			StopID   string `json:"stop_id"`
			StopType string `json:"stop_type"`
		} `json:"stops"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatalf("unmarshal STATE: %v", err)
	}
	if frame.Type != "STATE" {
		t.Errorf("first frame type = %q, want STATE", frame.Type)
	}
	if len(frame.Stops) != 2 {
		t.Fatalf("STATE stops = %d, want 2", len(frame.Stops))
	}
	if frame.Stops[0].StopType != "FETCHED" {
		t.Errorf("boarding stop type = %q, want FETCHED", frame.Stops[0].StopType)
	}

	// Closing the socket tears the session down ("closed anytime").
	conn.Close()
	waitFor(t, 2*time.Second, func() bool { return mgr.Count() == 0 })
}

// TestStart_WalkOnlyRoute: a route with no transit steps (pure walk) is accepted
// (201, not 422) and exports a STATE with no stops and one walk leg.
func TestStart_WalkOnlyRoute(t *testing.T) {
	srv, mgr, _, _ := newTestServer(t)
	defer srv.Close()

	walkRoute := json.RawMessage(`{"distanceMeters":500,"duration":"600s","legs":[{"steps":[{"travelMode":"WALK"}]}]}`)
	body, _ := json.Marshal(map[string]any{
		"route":                walkRoute,
		"destination_place_id": "place-xyz",
	})

	resp := doPost(t, srv.URL+"/trips", tokenA, body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want 201 for walk-only route", resp.StatusCode)
	}
	var start api.StartResponse
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	resp.Body.Close()
	if start.SessionID == "" || mgr.Count() != 1 {
		t.Fatalf("session not started (id=%q count=%d)", start.SessionID, mgr.Count())
	}

	conn, _, err := dialWS(t, srv.URL, start.WSURL, tokenA)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read STATE: %v", err)
	}
	var frame struct {
		Type  string     `json:"type"`
		Stops []struct{} `json:"stops"`
		Legs  []struct {
			Mode string `json:"mode"`
		} `json:"legs"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatalf("unmarshal STATE: %v", err)
	}
	if frame.Type != "STATE" {
		t.Errorf("first frame type = %q, want STATE", frame.Type)
	}
	if len(frame.Stops) != 0 {
		t.Errorf("STATE stops = %d, want 0 for walk-only", len(frame.Stops))
	}
	if len(frame.Legs) != 1 || frame.Legs[0].Mode != "WALK" {
		t.Errorf("STATE legs = %+v, want one WALK leg", frame.Legs)
	}
}

func TestStart_RejectsMissingDestination(t *testing.T) {
	srv, _, _, _ := newTestServer(t)
	defer srv.Close()

	routeJSON, _ := os.ReadFile("../../testdata/route_single.json")
	body, _ := json.Marshal(map[string]any{"route": json.RawMessage(routeJSON)})

	resp := doPost(t, srv.URL+"/trips", tokenA, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for missing destination_place_id", resp.StatusCode)
	}
}

func TestGetTrip_RefreshesAndReturnsRoute(t *testing.T) {
	srv, _, routes, _ := newTestServer(t)
	defer srv.Close()

	routeJSON, err := os.ReadFile("../../testdata/route_single.json")
	if err != nil {
		t.Fatalf("read route: %v", err)
	}
	// A GET re-plans: it calls /route from the rider's position to the destination.
	// Program the fake to return a fresh route the fixture can resolve, tagged so we
	// can confirm the GET served the *re-fetched* route, not the posted one.
	parsed, err := directions.ParseSingle(routeJSON)
	if err != nil {
		t.Fatalf("parse route: %v", err)
	}
	freshRaw := json.RawMessage(`{"refreshed":true,"polyline":{"encodedPolyline":"abc"}}`)
	routes.RouteFn = func(_ context.Context, origin geo.LatLng, destPlaceID string) (directions.Route, json.RawMessage, error) {
		if destPlaceID != "place-xyz" {
			t.Errorf("refresh dest = %q, want place-xyz", destPlaceID)
		}
		if origin == (geo.LatLng{}) {
			t.Error("refresh origin is zero; want the rider's planned stop or fix")
		}
		return parsed, freshRaw, nil
	}

	body, _ := json.Marshal(map[string]any{
		"route":                json.RawMessage(routeJSON),
		"destination_place_id": "place-xyz",
	})
	resp := doPost(t, srv.URL+"/trips", tokenA, body)
	var start api.StartResponse
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	resp.Body.Close()

	getResp := doGet(t, srv.URL+"/trips/"+start.SessionID, tokenA)
	defer getResp.Body.Close()
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", getResp.StatusCode)
	}
	var snap struct {
		Type  string          `json:"type"`
		Stops []struct{}      `json:"stops"`
		Route json.RawMessage `json:"route"`
	}
	if err := json.NewDecoder(getResp.Body).Decode(&snap); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if snap.Type != "STATE" {
		t.Errorf("snapshot type = %q, want STATE", snap.Type)
	}
	if len(snap.Stops) != 2 {
		t.Errorf("snapshot stops = %d, want 2", len(snap.Stops))
	}
	if routes.Calls == 0 {
		t.Error("GET did not trigger a route re-fetch")
	}
	if !bytes.Contains(snap.Route, []byte("refreshed")) {
		t.Errorf("snapshot route is not the re-fetched one: %s", snap.Route)
	}
}

func TestGetTrip_FallsBackToLastRouteOnRefreshError(t *testing.T) {
	srv, _, routes, _ := newTestServer(t)
	defer srv.Close()

	routeJSON, err := os.ReadFile("../../testdata/route_single.json")
	if err != nil {
		t.Fatalf("read route: %v", err)
	}
	// Refresh fails: the GET must still return the last known-good route (the one
	// the client POSTed), never an empty/stale snapshot.
	routes.RouteFn = func(_ context.Context, _ geo.LatLng, _ string) (directions.Route, json.RawMessage, error) {
		return directions.Route{}, nil, errors.New("route service down")
	}

	body, _ := json.Marshal(map[string]any{
		"route":                json.RawMessage(routeJSON),
		"destination_place_id": "place-xyz",
	})
	resp := doPost(t, srv.URL+"/trips", tokenA, body)
	var start api.StartResponse
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	resp.Body.Close()

	getResp := doGet(t, srv.URL+"/trips/"+start.SessionID, tokenA)
	defer getResp.Body.Close()
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", getResp.StatusCode)
	}
	var snap struct {
		Route json.RawMessage `json:"route"`
	}
	if err := json.NewDecoder(getResp.Body).Decode(&snap); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if len(snap.Route) == 0 {
		t.Error("fallback snapshot has no route; want the last known-good route")
	}
}

func TestGetTrip_UnknownSession(t *testing.T) {
	srv, _, _, _ := newTestServer(t)
	defer srv.Close()

	resp := doGet(t, srv.URL+"/trips/does-not-exist", tokenA)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404 for unknown session", resp.StatusCode)
	}
}

// fixtureEntry / fixtureExit mirror newFixture's trip "T" stops, so an OTP route
// referencing them builds against the fixture.
var (
	fixtureEntry = geo.LatLng{Lat: 51.047742299999996, Lng: -114.07078329999999}
	fixtureExit  = geo.LatLng{Lat: 51.0379, Lng: -114.08972}
)

// TestStart_OpenTripSource: a client-fetched OTP route POSTed to /trips with
// source="opentrip" starts an OTP session. Stops are windowed by the OTP-supplied
// trip_id/stop_ids (no Google resolution, no place ID), destination is coords.
func TestStart_OpenTripSource(t *testing.T) {
	srv, mgr, _, _ := newTestServer(t)
	defer srv.Close()

	envelope := map[string]any{
		"source": "opentrip",
		"itineraries": []any{map[string]any{
			"duration_seconds": 600,
			"legs": []any{map[string]any{
				"mode": "BUS", "trip_id": "T", "from_stop_id": "e", "to_stop_id": "x",
				"route_short_name": "2",
			}},
		}},
	}
	routeRaw, _ := json.Marshal(envelope)
	body, _ := json.Marshal(map[string]any{
		"source":      "opentrip",
		"route":       json.RawMessage(routeRaw),
		"destination": map[string]float64{"lat": 51.04, "lng": -114.09},
	})

	resp := doPost(t, srv.URL+"/trips", tokenA, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want 201", resp.StatusCode)
	}
	var start api.StartResponse
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	if start.SessionID == "" {
		t.Fatal("empty session_id")
	}
	if mgr.Count() != 1 {
		t.Fatalf("session count = %d, want 1", mgr.Count())
	}
}

// TestStart_OpenTripSource_RejectsMissingDestination: the OTP path needs dest coords
// (there is no place ID), so a posted OTP route without a destination is a 400.
func TestStart_OpenTripSource_RejectsMissingDestination(t *testing.T) {
	srv, _, _, _ := newTestServer(t)
	defer srv.Close()

	envelope := `{"source":"opentrip","itineraries":[{"duration_seconds":600,"legs":[{"mode":"BUS","trip_id":"T","from_stop_id":"e","to_stop_id":"x"}]}]}`
	body, _ := json.Marshal(map[string]any{"source": "opentrip", "route": json.RawMessage(envelope)})

	resp := doPost(t, srv.URL+"/trips", tokenA, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for missing destination on opentrip route", resp.StatusCode)
	}
}

// TestTranzitRoute_StartsOTPSession: the server-owned path fetches the route from the
// OTP client, builds the trip, and returns the chosen route so the client can render
// immediately (source tag intact).
func TestTranzitRoute_StartsOTPSession(t *testing.T) {
	srv, mgr, _, otp := newTestServer(t)
	defer srv.Close()

	otpRoute := directions.Route{Legs: []directions.ParsedLeg{{
		Mode: directions.ModeBus, RouteID: "2", TripID: "T", EntryStopID: "e", ExitStopID: "x",
		Entry: &directions.StopEndpoint{Loc: fixtureEntry, TimeEpoch: fixtureNow + 600},
		Exit:  &directions.StopEndpoint{Loc: fixtureExit, TimeEpoch: fixtureNow + 1200},
	}}}
	otpRaw := json.RawMessage(`{"source":"opentrip","itineraries":[{"duration_seconds":600}]}`)

	var gotOrigin, gotDest geo.LatLng
	otp.RouteFn = func(_ context.Context, origin, dest geo.LatLng, mode string, num int) (directions.Route, json.RawMessage, error) {
		gotOrigin, gotDest = origin, dest
		if mode != "walk_transit" {
			t.Errorf("mode = %q, want default walk_transit", mode)
		}
		return otpRoute, otpRaw, nil
	}

	body, _ := json.Marshal(map[string]any{
		"origin":      map[string]float64{"lat": 51.05, "lng": -114.07},
		"destination": map[string]float64{"lat": 51.04, "lng": -114.09},
	})
	resp := doPost(t, srv.URL+"/tranzit-route", tokenA, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want 201", resp.StatusCode)
	}
	var start api.StartResponse
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	if start.SessionID == "" || mgr.Count() != 1 {
		t.Fatalf("session not started (id=%q count=%d)", start.SessionID, mgr.Count())
	}
	if otp.Calls != 1 {
		t.Errorf("otp client calls = %d, want 1", otp.Calls)
	}
	if (gotOrigin == geo.LatLng{}) || (gotDest == geo.LatLng{}) {
		t.Errorf("otp called with origin=%+v dest=%+v; both should be set", gotOrigin, gotDest)
	}
	if !bytes.Contains(start.Route, []byte("opentrip")) {
		t.Errorf("response route does not carry the OTP envelope: %s", start.Route)
	}
}

// TestTranzitRoute_RejectsMissingCoords: origin and destination coords are required.
func TestTranzitRoute_RejectsMissingCoords(t *testing.T) {
	srv, _, _, _ := newTestServer(t)
	defer srv.Close()

	body, _ := json.Marshal(map[string]any{"origin": map[string]float64{"lat": 51.05, "lng": -114.07}})
	resp := doPost(t, srv.URL+"/tranzit-route", tokenA, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for missing destination", resp.StatusCode)
	}
}

// TestHealth_NoAuth: /health is the one open route — reachable with no token.
func TestHealth_NoAuth(t *testing.T) {
	srv, _, _, _ := newTestServer(t)
	defer srv.Close()

	resp := doGet(t, srv.URL+"/health", "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200 for open /health", resp.StatusCode)
	}
}

// TestAuth_RejectsUnauthenticated: protected REST routes 401 with no token and with
// a token the verifier rejects.
func TestAuth_RejectsUnauthenticated(t *testing.T) {
	srv, mgr, _, _ := newTestServer(t)
	defer srv.Close()

	routeJSON, _ := os.ReadFile("../../testdata/route_single.json")
	body, _ := json.Marshal(map[string]any{
		"route":                json.RawMessage(routeJSON),
		"destination_place_id": "place-xyz",
	})

	for _, tc := range []struct{ name, token string }{
		{"missing token", ""},
		{"invalid token", "garbage"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := doPost(t, srv.URL+"/trips", tc.token, body)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized {
				t.Errorf("status = %d, want 401", resp.StatusCode)
			}
		})
	}
	if mgr.Count() != 0 {
		t.Errorf("unauthenticated POSTs created %d session(s), want 0", mgr.Count())
	}
}

// TestAuth_WSRejectsMissingToken: the WS upgrade is gated too — no ?token= → 401,
// before any session lookup.
func TestAuth_WSRejectsMissingToken(t *testing.T) {
	srv, _, _, _ := newTestServer(t)
	defer srv.Close()

	routeJSON, _ := os.ReadFile("../../testdata/route_single.json")
	body, _ := json.Marshal(map[string]any{
		"route":                json.RawMessage(routeJSON),
		"destination_place_id": "place-xyz",
	})
	resp := doPost(t, srv.URL+"/trips", tokenA, body)
	var start api.StartResponse
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	resp.Body.Close()

	conn, wsResp, err := dialWS(t, srv.URL, start.WSURL, "")
	if err == nil {
		conn.Close()
		t.Fatal("WS upgrade succeeded without a token; want rejected")
	}
	if wsResp == nil || wsResp.StatusCode != http.StatusUnauthorized {
		t.Errorf("WS upgrade status = %v, want 401", wsResp)
	}
}

// TestOwnership_OtherUserCannotAccess: a trip started by user A is invisible to
// user B — GET/WS 404 (not even existence is leaked) and B's DELETE is a no-op
// (idempotent 204 without teardown). A keeps a socket open so the never-attached
// watchdog can't be what tears the trip down.
func TestOwnership_OtherUserCannotAccess(t *testing.T) {
	srv, mgr, _, _ := newTestServer(t)
	defer srv.Close()

	routeJSON, _ := os.ReadFile("../../testdata/route_single.json")
	body, _ := json.Marshal(map[string]any{
		"route":                json.RawMessage(routeJSON),
		"destination_place_id": "place-xyz",
	})
	resp := doPost(t, srv.URL+"/trips", tokenA, body)
	var start api.StartResponse
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatalf("decode start: %v", err)
	}
	resp.Body.Close()

	// Owner attaches and stays connected to keep the session alive.
	ownerConn, _, err := dialWS(t, srv.URL, start.WSURL, tokenA)
	if err != nil {
		t.Fatalf("owner ws dial: %v", err)
	}
	defer ownerConn.Close()
	ownerConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err := ownerConn.ReadMessage(); err != nil {
		t.Fatalf("owner read STATE: %v", err)
	}

	// User B: GET → 404.
	getResp := doGet(t, srv.URL+"/trips/"+start.SessionID, tokenB)
	getResp.Body.Close()
	if getResp.StatusCode != http.StatusNotFound {
		t.Errorf("non-owner GET status = %d, want 404", getResp.StatusCode)
	}

	// User B: WS → rejected with 404.
	conn, wsResp, err := dialWS(t, srv.URL, start.WSURL, tokenB)
	if err == nil {
		conn.Close()
		t.Error("non-owner WS upgrade succeeded; want rejected")
	} else if wsResp == nil || wsResp.StatusCode != http.StatusNotFound {
		t.Errorf("non-owner WS status = %v, want 404", wsResp)
	}

	// User B: DELETE → 204 but must NOT tear the trip down.
	delResp := doDelete(t, srv.URL+"/trips/"+start.SessionID, tokenB)
	delResp.Body.Close()
	if delResp.StatusCode != http.StatusNoContent {
		t.Errorf("non-owner DELETE status = %d, want 204", delResp.StatusCode)
	}
	if mgr.Count() != 1 {
		t.Fatalf("non-owner DELETE tore down the trip (count=%d)", mgr.Count())
	}

	// Owner DELETE tears it down.
	ownerDel := doDelete(t, srv.URL+"/trips/"+start.SessionID, tokenA)
	ownerDel.Body.Close()
	if ownerDel.StatusCode != http.StatusNoContent {
		t.Errorf("owner DELETE status = %d, want 204", ownerDel.StatusCode)
	}
	waitFor(t, 2*time.Second, func() bool { return mgr.Count() == 0 })
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}
