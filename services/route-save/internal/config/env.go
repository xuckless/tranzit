package config

import "os"

// Endpoints holds the runtime-configurable addresses Route Save talks to. They
// are read from the environment with sibling-service defaults.
type Endpoints struct {
	// ServerAddr is the listen address for the Route Save HTTP/WS server.
	ServerAddr string
	// MiddlewareURL is tranzit-db-middleware's base URL (RT arrivals, GTFS data).
	MiddlewareURL string
	// RouteServiceURL is tranzit-route-service's base URL (directions /route).
	RouteServiceURL string
	// SupabaseURL is the Supabase project URL (https://<ref>.supabase.co) whose
	// JWKS endpoint auth tokens are verified against. No default — it is
	// environment-specific and auth cannot run without it.
	SupabaseURL string

	// mTLS client material for service-to-service calls (AUTH.md). Route Save is a
	// client only. Cert paths default to the container mount; the *MTLSAddr fields
	// are empty by default, in which case calls fall back to the Funnel URLs above.
	MTLSCACert string
	MTLSCert   string
	MTLSKey    string
	// MiddlewareMTLSAddr / RouteServiceMTLSAddr are the siblings' tailnet mTLS
	// endpoints (host:port). Set to switch that sibling's calls from Funnel to mTLS.
	MiddlewareMTLSAddr   string
	RouteServiceMTLSAddr string
	// ServerName must match a SAN on the sibling's cert (default = its service name).
	MiddlewareMTLSServerName   string
	RouteServiceMTLSServerName string
}

// Tailnet MagicDNS URLs of the sibling services (local Docker nodes). Route Save
// connects to these by default; set MIDDLEWARE_URL / ROUTE_SERVICE_URL to override.
const (
	defaultMiddlewareURL   = "https://tranzit-db-middleware.tailnet-example.ts.net"
	defaultRouteServiceURL = "https://tranzit-route-service.tailnet-example.ts.net"
)

// LoadEndpoints reads endpoint config from the environment, applying defaults.
// PORT may be either ":8090" or "8090"; a bare port is prefixed with ":".
// MIDDLEWARE_URL and ROUTE_SERVICE_URL default to the sibling tailnet nodes.
func LoadEndpoints() Endpoints {
	return Endpoints{
		ServerAddr:      normalizeAddr(getenv("PORT", "8090")),
		MiddlewareURL:   getenv("MIDDLEWARE_URL", defaultMiddlewareURL),
		RouteServiceURL: getenv("ROUTE_SERVICE_URL", defaultRouteServiceURL),
		SupabaseURL:     os.Getenv("SUPABASE_URL"),

		MTLSCACert:                 getenv("MTLS_CA_CERT", "/certs/ca.crt"),
		MTLSCert:                   getenv("MTLS_CERT", "/certs/tranzit-route-save.crt"),
		MTLSKey:                    getenv("MTLS_KEY", "/certs/tranzit-route-save.key"),
		MiddlewareMTLSAddr:         os.Getenv("MIDDLEWARE_MTLS_ADDR"),
		RouteServiceMTLSAddr:       os.Getenv("ROUTE_SERVICE_MTLS_ADDR"),
		MiddlewareMTLSServerName:   getenv("MIDDLEWARE_MTLS_SERVERNAME", "tranzit-db-middleware"),
		RouteServiceMTLSServerName: getenv("ROUTE_SERVICE_MTLS_SERVERNAME", "tranzit-route-service"),
	}
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func normalizeAddr(s string) string {
	if s == "" {
		return ":8090"
	}
	if s[0] != ':' && !hasColon(s) {
		return ":" + s
	}
	return s
}

func hasColon(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			return true
		}
	}
	return false
}
