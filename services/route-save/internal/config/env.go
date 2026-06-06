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
}

// Live Cloud Run URLs of the sibling services. Route Save connects to these by
// default; set MIDDLEWARE_URL / ROUTE_SERVICE_URL to override (e.g. for local
// instances).
const (
	defaultMiddlewareURL   = "https://tranzit-db-middleware-000000000000.us-central1.run.app"
	defaultRouteServiceURL = "https://tranzit-route-service-000000000000.us-central1.run.app"
)

// LoadEndpoints reads endpoint config from the environment, applying defaults.
// PORT may be either ":8090" or "8090"; a bare port is prefixed with ":".
// MIDDLEWARE_URL and ROUTE_SERVICE_URL default to the live Cloud Run instances.
func LoadEndpoints() Endpoints {
	return Endpoints{
		ServerAddr:      normalizeAddr(getenv("PORT", "8090")),
		MiddlewareURL:   getenv("MIDDLEWARE_URL", defaultMiddlewareURL),
		RouteServiceURL: getenv("ROUTE_SERVICE_URL", defaultRouteServiceURL),
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
