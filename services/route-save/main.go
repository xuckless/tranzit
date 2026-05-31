// Command tranzit-route-save is the live trip-tracking service. A client POSTs a
// chosen route to /trips, then opens a per-trip WebSocket; the service takes
// over — streaming real-time STATE, polling GTFS-RT, and rerouting via Map
// Service — until the client closes the socket.
package main

import (
	"log"
	"net/http"

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

	log.Printf("route-save listening on %s (middleware=%s route-service=%s)",
		endpoints.ServerAddr, endpoints.MiddlewareURL, endpoints.RouteServiceURL)
	if err := http.ListenAndServe(endpoints.ServerAddr, srv.Handler()); err != nil {
		log.Fatal(err)
	}
}
