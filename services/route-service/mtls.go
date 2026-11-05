package main

// mtls.go provides the service-to-service mutual-TLS plumbing: the server config
// for the tailnet-only listener that sibling services call (verifying their client
// cert against the shared CA and pinning the CN allow-list), and the client config
// used when this service calls a sibling (tranzit-db-middleware). See AUTH.md.

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
)

// loadServerMTLS builds the *tls.Config for the mTLS listener. enforce selects
// RequireAndVerifyClientCert (hard) vs VerifyClientCertIfGiven (soft). allowed is
// the set of acceptable client CNs (empty = any cert chaining to the CA).
func loadServerMTLS(caPath, certPath, keyPath string, allowed []string, enforce bool) (*tls.Config, error) {
	leaf, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, fmt.Errorf("mtls: load keypair: %w", err)
	}
	caPool, err := loadCAPool(caPath)
	if err != nil {
		return nil, err
	}

	clientAuth := tls.VerifyClientCertIfGiven
	if enforce {
		clientAuth = tls.RequireAndVerifyClientCert
	}

	allowSet := make(map[string]struct{}, len(allowed))
	for _, a := range allowed {
		if a = strings.TrimSpace(a); a != "" {
			allowSet[a] = struct{}{}
		}
	}

	cfg := &tls.Config{
		Certificates: []tls.Certificate{leaf},
		ClientCAs:    caPool,
		ClientAuth:   clientAuth,
		MinVersion:   tls.VersionTLS12,
	}
	if len(allowSet) > 0 {
		cfg.VerifyPeerCertificate = func(_ [][]byte, chains [][]*x509.Certificate) error {
			if len(chains) == 0 { // soft mode, no cert presented
				return nil
			}
			cn := chains[0][0].Subject.CommonName
			if _, ok := allowSet[cn]; ok {
				return nil
			}
			for _, name := range chains[0][0].DNSNames {
				if _, ok := allowSet[name]; ok {
					return nil
				}
			}
			return fmt.Errorf("mtls: client %q is not in the allow-list", cn)
		}
	}
	return cfg, nil
}

// loadClientMTLS builds a *tls.Config for calling a sibling over mTLS. serverName
// must match a SAN on the sibling's cert (decoupling it from the dialed tailnet IP).
func loadClientMTLS(caPath, certPath, keyPath, serverName string) (*tls.Config, error) {
	leaf, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, fmt.Errorf("mtls: load keypair: %w", err)
	}
	caPool, err := loadCAPool(caPath)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		RootCAs:      caPool,
		Certificates: []tls.Certificate{leaf},
		ServerName:   serverName,
		MinVersion:   tls.VersionTLS12,
	}, nil
}

func loadCAPool(caPath string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(caPath)
	if err != nil {
		return nil, fmt.Errorf("mtls: read CA %s: %w", caPath, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, errors.New("mtls: no certificates found in CA file")
	}
	return pool, nil
}

// ── outbound: calls to tranzit-db-middleware ────────────────────────────────────

var (
	middlewareOnce   sync.Once
	middlewareURLVal string
	middlewareClient *http.Client
)

// middlewareCall returns the base URL + HTTP client for reaching tranzit-db-
// middleware. When MIDDLEWARE_MTLS_ADDR is set it dials that tailnet endpoint over
// mTLS; otherwise it falls back to the public Funnel URL with the default client
// (safe rollout — flip by setting the env var once certs are deployed).
func middlewareCall() (string, *http.Client) {
	middlewareOnce.Do(func() {
		if addr := os.Getenv("MIDDLEWARE_MTLS_ADDR"); addr != "" {
			cfg, err := loadClientMTLS(
				os.Getenv("MTLS_CA_CERT"), os.Getenv("MTLS_CERT"), os.Getenv("MTLS_KEY"),
				envOr("MIDDLEWARE_MTLS_SERVERNAME", "tranzit-db-middleware"),
			)
			if err != nil {
				log.Fatalf("mtls client (middleware): %v", err)
			}
			middlewareURLVal = "https://" + strings.TrimPrefix(strings.TrimPrefix(addr, "https://"), "http://")
			middlewareClient = &http.Client{Transport: &http.Transport{TLSClientConfig: cfg}}
			log.Printf("mtls: middleware calls via %s (mTLS, serverName=%s)", middlewareURLVal,
				envOr("MIDDLEWARE_MTLS_SERVERNAME", "tranzit-db-middleware"))
		} else {
			middlewareURLVal = middlewareBaseURL()
			middlewareClient = http.DefaultClient
		}
	})
	return middlewareURLVal, middlewareClient
}

// ── small env helpers ───────────────────────────────────────────────────────────

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}
