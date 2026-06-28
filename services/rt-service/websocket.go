package main

import (
	"fmt"
	"net/http"
	"strconv"
	"sync"

	"github.com/gorilla/websocket"
)

var feedTag = map[string]byte{
	"vehicles": 0x01,
	"trips":    0x02,
	"alerts":   0x03,
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type wsHub struct {
	mu      sync.RWMutex
	clients map[*websocket.Conn]struct{}
}

func newHub() *wsHub {
	return &wsHub{clients: make(map[*websocket.Conn]struct{})}
}

func (h *wsHub) add(c *websocket.Conn) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *wsHub) remove(c *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}

func (h *wsHub) broadcast(feedName string, raw []byte) {
	tag, ok := feedTag[feedName]
	if !ok {
		tag = 0x00
	}
	payload := append([]byte{tag}, raw...)

	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		_ = c.WriteMessage(websocket.BinaryMessage, payload)
	}
}

func (h *wsHub) serveWS(w http.ResponseWriter, r *http.Request) {
	// Non-WS requests (e.g. Cloud Run health probes) get a plain 200.
	if r.Header.Get("Upgrade") != "websocket" {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("tranzit-rt-service ok"))
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	h.add(conn)
	defer func() {
		h.remove(conn)
		conn.Close()
	}()
	// Block until client disconnects.
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
}

// serveTripUpdates serves the OTP-facing GTFS-RT TripUpdates feed (live + synthesized
// cancellations) as a standard protobuf body. OTP's stop-time-updater polls this over HTTP.
func (f *tripUpdateFeed) serveTripUpdates(w http.ResponseWriter, r *http.Request) {
	f.mu.RLock()
	b := f.bytes
	f.mu.RUnlock()
	if b == nil {
		http.Error(w, "trip-update feed not ready", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.Header().Set("Cache-Control", "no-store")
	// Set Content-Length explicitly so the body is sent in one piece — the marshaled feed is large
	// enough that net/http would otherwise stream it chunked, which the Tailscale Funnel proxy has
	// occasionally truncated mid-message (OTP then logs InvalidProtocolBufferException).
	w.Header().Set("Content-Length", strconv.Itoa(len(b)))
	_, _ = w.Write(b)
}

func startWSServer(hub *wsHub, feed *tripUpdateFeed, addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/gtfs-rt/trip-updates", feed.serveTripUpdates)
	mux.HandleFunc("/", hub.serveWS)
	srv := &http.Server{Addr: addr, Handler: mux}
	fmt.Printf("WebSocket GTFS-RT server on ws://%s  (0x01=vehicles  0x02=trips  0x03=alerts)\n", addr)
	fmt.Printf("OTP TripUpdates feed on http://%s/gtfs-rt/trip-updates\n", addr)
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Printf("WS server error: %v\n", err)
		}
	}()
}
