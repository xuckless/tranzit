package main

// mtls.go builds the TLS config for the service-to-service listener. Sibling
// services present a client certificate issued by the shared private CA; we verify
// it against that CA and pin the leaf's CN/SAN to an allow-list, so only known
// services (not just anything holding a CA-signed cert) are accepted. See AUTH.md.

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"
)

// loadServerMTLS builds a *tls.Config for the mTLS listener. enforce selects
// RequireAndVerifyClientCert (hard) vs VerifyClientCertIfGiven (soft, logs but
// allows a missing cert during rollout). allowed is the set of acceptable client
// CNs; empty means "any cert chaining to the CA".
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
			// chains is populated because the cert already verified against ClientCAs.
			// In soft mode a client may send no cert at all → no chains → allow.
			if len(chains) == 0 {
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
