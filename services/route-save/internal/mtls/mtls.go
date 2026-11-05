// Package mtls builds the client-side mutual-TLS config Route Save uses to call its
// sibling services (tranzit-db-middleware, tranzit-route-service) over the tailnet.
// Route Save is only ever a CLIENT in the S2S mesh — nothing calls it service-to-
// service — so this package has no server half. The presented identity and the CA
// it trusts both come from the shared private CA (see the middleware repo's
// scripts/gen-mtls-certs.sh and AUTH.md).
package mtls

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
)

// ClientConfig builds a *tls.Config for dialing a sibling over mTLS. serverName must
// match a SAN on the sibling's certificate; it is used for verification (and SNI)
// instead of the dialed host, so the cert stays decoupled from the tailnet IP.
func ClientConfig(caPath, certPath, keyPath, serverName string) (*tls.Config, error) {
	leaf, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, fmt.Errorf("mtls: load keypair: %w", err)
	}
	pemBytes, err := os.ReadFile(caPath)
	if err != nil {
		return nil, fmt.Errorf("mtls: read CA %s: %w", caPath, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemBytes) {
		return nil, errors.New("mtls: no certificates found in CA file")
	}
	return &tls.Config{
		RootCAs:      pool,
		Certificates: []tls.Certificate{leaf},
		ServerName:   serverName,
		MinVersion:   tls.VersionTLS12,
	}, nil
}
