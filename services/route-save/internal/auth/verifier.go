// Package auth verifies Supabase-issued JWTs and gates the HTTP/WebSocket
// surface. Supabase signs access tokens with asymmetric ES256 keys published at
// the project's JWKS endpoint; identity is the token's `sub` claim — the Supabase
// user UUID the rest of Tranzit keys on (guests, via anonymous sign-in, carry one
// too). Tokens are never persisted or logged here.
package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// Verifier validates a bearer token and returns the authenticated user id (the
// Supabase `sub` UUID). It is an interface so handlers and tests don't depend on
// the network-backed JWKS implementation.
type Verifier interface {
	Verify(ctx context.Context, token string) (userID string, err error)
}

// JWKSVerifier verifies Supabase access tokens against the project's JWKS. keyfunc
// fetches the keys up front and refreshes them in the background, so signing-key
// rotation (a new `kid`) needs no redeploy.
type JWKSVerifier struct {
	kf  keyfunc.Keyfunc
	iss string
}

// NewJWKSVerifier builds a verifier for the given Supabase project URL
// (e.g. https://<ref>.supabase.co). It fetches the JWKS once up front (returning an
// error if unreachable) and then refreshes it in the background.
func NewJWKSVerifier(supabaseURL string) (*JWKSVerifier, error) {
	supabaseURL = strings.TrimRight(strings.TrimSpace(supabaseURL), "/")
	if supabaseURL == "" {
		return nil, errors.New("auth: SUPABASE_URL is empty")
	}
	jwksURL := supabaseURL + "/auth/v1/.well-known/jwks.json"
	kf, err := keyfunc.NewDefault([]string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("auth: load JWKS from %s: %w", jwksURL, err)
	}
	return &JWKSVerifier{kf: kf, iss: supabaseURL + "/auth/v1"}, nil
}

// Verify parses and validates a Supabase access token, returning its `sub` (the
// user UUID). It enforces the ES256 signature against the JWKS plus the issuer,
// audience, and expiry. Anonymous (guest) tokens pass — they share the
// "authenticated" audience and carry a real `sub`.
func (v *JWKSVerifier) Verify(_ context.Context, token string) (string, error) {
	parsed, err := jwt.Parse(token, v.kf.Keyfunc,
		jwt.WithValidMethods([]string{"ES256"}),
		jwt.WithIssuer(v.iss),
		jwt.WithAudience("authenticated"),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return "", err
	}
	sub, err := parsed.Claims.GetSubject()
	if err != nil {
		return "", err
	}
	if sub == "" {
		return "", errors.New("auth: token has no subject")
	}
	return sub, nil
}

// DemoVerifier is the DEMO_USER_ID mode for the local demo stack: every request is
// UserID, whatever token (if any) it carries, and no Supabase is contacted.
// Never configure it on a real deployment.
type DemoVerifier struct{ UserID string }

// Verify ignores the token and returns the demo user id.
func (d DemoVerifier) Verify(context.Context, string) (string, error) { return d.UserID, nil }
