package api_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/tranzit-route-save/internal/api"
	"github.com/tranzit-route-save/internal/datasource"
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

func newTestServer(t *testing.T) (*httptest.Server, *session.Manager) {
	t.Helper()
	fx := newFixture()
	mgr := session.NewManager(session.Deps{
		Data:   fx,
		RT:     &rtfeed.Fake{},
		Routes: &routeclient.Fake{},
		Clock:  &state.FakeClock{T: fixtureNow},
	})
	return httptest.NewServer(api.NewServer(mgr, fx).Handler()), mgr
}

func TestLifecycle_StartConnectStream(t *testing.T) {
	srv, mgr := newTestServer(t)
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
	resp, err := http.Post(srv.URL+"/trips", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /trips: %v", err)
	}
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
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + start.WSURL
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
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

func TestStart_RejectsMissingDestination(t *testing.T) {
	srv, _ := newTestServer(t)
	defer srv.Close()

	routeJSON, _ := os.ReadFile("../../testdata/route_single.json")
	body, _ := json.Marshal(map[string]any{"route": json.RawMessage(routeJSON)})

	resp, err := http.Post(srv.URL+"/trips", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for missing destination_place_id", resp.StatusCode)
	}
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
