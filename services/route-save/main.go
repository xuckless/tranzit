// Command tranzit-route-save is the live trip-tracking service. A client POSTs a
// chosen route to /trips, then opens a per-trip WebSocket; the service takes
// over — streaming real-time STATE, polling GTFS-RT, and rerouting via Map
// Service — until the client closes the socket.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"

	"github.com/tranzit-route-save/internal/api"
	"github.com/tranzit-route-save/internal/config"
	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/routeclient"
	"github.com/tranzit-route-save/internal/rtfeed"
	"github.com/tranzit-route-save/internal/session"
	"github.com/tranzit-route-save/internal/state"
)

func main() {
	_ = godotenv.Load()
	endpoints := config.LoadEndpoints()

	data := datasource.NewHTTPSource(endpoints.MiddlewareURL)
	mgr := session.NewManager(session.Deps{
		Data:   data,
		RT:     rtfeed.NewMiddleware(endpoints.MiddlewareURL),
		Routes: routeclient.NewHTTPClient(endpoints.RouteServiceURL),
		Clock:  state.SystemClock{},
	})

	srv := api.NewServer(mgr, data)
	httpSrv := &http.Server{Addr: endpoints.ServerAddr, Handler: srv.Handler()}

	// Trap SIGINT/SIGTERM so we can close every live session and drain the HTTP
	// server cleanly instead of dropping connections on exit.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("route-save listening on %s (middleware=%s route-service=%s)",
			endpoints.ServerAddr, endpoints.MiddlewareURL, endpoints.RouteServiceURL)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	log.Printf("route-save: shutdown signal received; closing %d session(s)", mgr.Count())
	mgr.CloseAll()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("route-save: graceful shutdown error: %v", err)
	}
	log.Print("route-save: stopped")
}
