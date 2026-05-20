package main

import (
	"fmt"
	"net/http"
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

func startWSServer(hub *wsHub, host string, port int) {
	addr := fmt.Sprintf("%s:%d", host, port)
	mux := http.NewServeMux()
	mux.HandleFunc("/", hub.serveWS)
	srv := &http.Server{Addr: addr, Handler: mux}
	fmt.Printf("WebSocket GTFS-RT server on ws://%s  (0x01=vehicles  0x02=trips  0x03=alerts)\n", addr)
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Printf("WS server error: %v\n", err)
		}
	}()
}
