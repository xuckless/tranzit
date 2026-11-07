// Command tranzit-route-save is the live trip-tracking service. A client POSTs a
// chosen route to /trips, then opens a per-trip WebSocket; the service takes
// over — streaming real-time STATE, polling GTFS-RT, and rerouting via Map
// Service — until the client ends the trip (DELETE) or stays disconnected past
// the reattach grace.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"

	"github.com/tranzit-route-save/internal/api"
	"github.com/tranzit-route-save/internal/auth"
	"github.com/tranzit-route-save/internal/config"
	"github.com/tranzit-route-save/internal/datasource"
	"github.com/tranzit-route-save/internal/mtls"
	"github.com/tranzit-route-save/internal/routeclient"
	"github.com/tranzit-route-save/internal/rtfeed"
	"github.com/tranzit-route-save/internal/session"
	"github.com/tranzit-route-save/internal/state"
)

func main() {
	_ = godotenv.Load()
	endpoints := config.LoadEndpoints()

	var verifier auth.Verifier
	if endpoints.DemoUserID != "" {
		// Demo stack: no Supabase. Siblings are reached over plain HTTP
		// (MIDDLEWARE_URL / ROUTE_SERVICE_URL, no *_MTLS_ADDR) and run in demo mode too.
		log.Printf("DEMO MODE: every request is user %s; auth disabled", endpoints.DemoUserID)
		verifier = auth.DemoVerifier{UserID: endpoints.DemoUserID}
	} else {
		jwks, err := auth.NewJWKSVerifier(endpoints.SupabaseURL)
		if err != nil {
			log.Fatalf("route-save: auth setup failed (is SUPABASE_URL set?): %v", err)
		}
		verifier = jwks
	}

	// Resolve how to reach each sibling: mTLS over the tailnet when its *_MTLS_ADDR
	// is set, otherwise the public Funnel URL (safe rollout). One transport per
	// sibling is shared across that sibling's clients.
	mwBase, mwTransport := siblingTransport(endpoints, endpoints.MiddlewareMTLSAddr, endpoints.MiddlewareMTLSServerName, endpoints.MiddlewareURL)
	rsBase, rsTransport := siblingTransport(endpoints, endpoints.RouteServiceMTLSAddr, endpoints.RouteServiceMTLSServerName, endpoints.RouteServiceURL)

	data := datasource.NewHTTPSource(mwBase)
	rt := rtfeed.NewMiddleware(mwBase)
	if mwTransport != nil {
		data.Client.Transport = mwTransport
		rt.HTTP.Transport = mwTransport
	}

	routes := routeclient.NewHTTPClient(rsBase)
	otpClient := routeclient.NewOTPClient(rsBase)
	if rsTransport != nil {
		routes.HTTP.Transport = rsTransport
		otpClient.HTTP.Transport = rsTransport
	}

	mgr := session.NewManager(session.Deps{
		Data:      data,
		RT:        rt,
		Routes:    routes,
		OTPRoutes: otpClient,
		Clock:     state.SystemClock{},
	})

	srv := api.NewServer(mgr, data, otpClient, verifier)
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

// siblingTransport returns the base URL and HTTP transport for reaching a sibling
// service. When mtlsAddr is set it builds a mutual-TLS transport (pinned to
// serverName, which must match the sibling's cert SAN) targeting https://<mtlsAddr>;
// otherwise it returns the Funnel URL and a nil transport so the client keeps its
// default. Fatal on cert misconfiguration so a broken mount can't silently fall
// back to unauthenticated transport.
func siblingTransport(e config.Endpoints, mtlsAddr, serverName, funnelURL string) (string, *http.Transport) {
	if mtlsAddr == "" {
		return funnelURL, nil
	}
	cfg, err := mtls.ClientConfig(e.MTLSCACert, e.MTLSCert, e.MTLSKey, serverName)
	if err != nil {
		log.Fatalf("route-save: mTLS client setup for %s: %v", serverName, err)
	}
	base := "https://" + strings.TrimPrefix(strings.TrimPrefix(mtlsAddr, "https://"), "http://")
	log.Printf("route-save: %s calls via %s (mTLS)", serverName, base)
	return base, &http.Transport{TLSClientConfig: cfg}
}
