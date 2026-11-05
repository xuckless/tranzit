package main

// auth.go gates the HTTP surface with two independent mechanisms (see AUTH.md):
//
//   - End users (the mobile app) reach the PUBLIC listener over the Tailscale
//     Funnel and authenticate with a Supabase access token (asymmetric ES256,
//     verified against the project JWKS). Identity is the token `sub` — the
//     Supabase user UUID the rest of Tranzit keys on. Guests (anonymous sign-in)
//     carry a valid token too.
//   - Sibling services reach the separate mTLS listener and are authenticated at
//     the TLS handshake by their client certificate; requests arriving there are
//     marked isService and bypass per-user ownership.
//
// Rollout is soft-first: while AUTH_ENFORCE is false the JWT is verified and the
// result logged, but the request is allowed through (as anonymous on failure).
// Flipping AUTH_ENFORCE to true turns failures into 401s. Tokens are never logged.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// Verifier validates a bearer token and returns the Supabase user id (`sub`).
type Verifier interface {
	Verify(ctx context.Context, token string) (userID string, err error)
}

// jwksVerifier verifies Supabase access tokens against the project JWKS. keyfunc
// fetches the keys up front and refreshes them in the background, so signing-key
// rotation (a new kid) needs no redeploy.
type jwksVerifier struct {
	kf  keyfunc.Keyfunc
	iss string
}

// newJWKSVerifier builds a verifier for the given Supabase project URL
// (https://<ref>.supabase.co). Fetches the JWKS once up front.
func newJWKSVerifier(supabaseURL string) (*jwksVerifier, error) {
	supabaseURL = strings.TrimRight(strings.TrimSpace(supabaseURL), "/")
	if supabaseURL == "" {
		return nil, errors.New("auth: SUPABASE_URL is empty")
	}
	jwksURL := supabaseURL + "/auth/v1/.well-known/jwks.json"
	kf, err := keyfunc.NewDefault([]string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("auth: load JWKS from %s: %w", jwksURL, err)
	}
	return &jwksVerifier{kf: kf, iss: supabaseURL + "/auth/v1"}, nil
}

func (v *jwksVerifier) Verify(_ context.Context, token string) (string, error) {
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

// ── request context ────────────────────────────────────────────────────────────

type ctxKeyUser struct{}
type ctxKeyService struct{}

func withUserID(ctx context.Context, uid string) context.Context {
	return context.WithValue(ctx, ctxKeyUser{}, uid)
}

// userIDOf returns the authenticated user id, or "" if the request is anonymous.
func userIDOf(ctx context.Context) string {
	id, _ := ctx.Value(ctxKeyUser{}).(string)
	return id
}

func withService(ctx context.Context, peer string) context.Context {
	return context.WithValue(ctx, ctxKeyService{}, peer)
}

// isServiceCaller reports whether the request arrived on the mTLS service
// listener (i.e. from a verified sibling service, not an end user).
func isServiceCaller(ctx context.Context) bool {
	_, ok := ctx.Value(ctxKeyService{}).(string)
	return ok
}

// bearerToken pulls the token from the Authorization header, falling back to a
// `token` query param (so SSE/EventSource clients that can't set headers still work).
func bearerToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if after, ok := strings.CutPrefix(h, "Bearer "); ok {
			return strings.TrimSpace(after)
		}
	}
	return r.URL.Query().Get("token")
}

// requireUserAuth is the PUBLIC-listener middleware. /health is always open.
// With a valid token it stashes the user id on the context. On a missing/invalid
// token it returns 401 when enforce is true, or logs and continues as anonymous
// when false (soft rollout). A nil verifier (no SUPABASE_URL) disables JWT
// checking entirely — tolerated only in soft mode (main fatals otherwise).
func requireUserAuth(v Verifier, enforce bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		token := bearerToken(r)
		if token == "" {
			if enforce {
				http.Error(w, "missing bearer token", http.StatusUnauthorized)
				return
			}
			log.Printf("auth(soft): allowing unauthenticated %s %s (no token)", r.Method, r.URL.Path)
			next.ServeHTTP(w, r)
			return
		}
		if v == nil {
			// soft mode without a configured verifier: can't check, just pass through.
			next.ServeHTTP(w, r)
			return
		}
		uid, err := v.Verify(r.Context(), token)
		if err != nil {
			if enforce {
				log.Printf("auth: rejected %s %s: %v", r.Method, r.URL.Path, err)
				http.Error(w, "invalid token", http.StatusUnauthorized)
				return
			}
			log.Printf("auth(soft): allowing %s %s with invalid token: %v", r.Method, r.URL.Path, err)
			next.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(withUserID(r.Context(), uid)))
	})
}

// markServiceCaller is the mTLS-listener middleware. The TLS handshake has already
// verified the client cert (RequireAndVerifyClientCert when enforcing); here we
// just record the peer's identity so handlers can treat it as a trusted service.
func markServiceCaller(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer := "unknown"
		if r.TLS != nil && len(r.TLS.PeerCertificates) > 0 {
			peer = r.TLS.PeerCertificates[0].Subject.CommonName
		}
		next.ServeHTTP(w, r.WithContext(withService(r.Context(), peer)))
	})
}
