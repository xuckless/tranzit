package main

// auth.go gates the public (Funnel) listener with Supabase JWT auth. End users
// (the mobile app) send their Supabase access token (asymmetric ES256, verified
// against the project JWKS); identity is the token `sub`. Sibling services do NOT
// use this path — they reach the separate mTLS listener (mtls.go) and are
// authenticated by their client certificate at the TLS handshake. See AUTH.md.
//
// Rollout is soft-first: while AUTH_ENFORCE is false the token is verified and the
// result logged, but the request is allowed through; flipping it to true turns
// failures into 401s. Tokens are never logged.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/gofiber/fiber/v2"
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

// buildVerifier constructs the Supabase JWT verifier. SUPABASE_URL is required when
// enforcing; in soft mode an empty/unreachable JWKS only disables verification.
func buildVerifier(enforce bool) Verifier {
	supabaseURL := envOr("SUPABASE_URL", "")
	if supabaseURL == "" {
		if enforce {
			log.Fatal("SUPABASE_URL is required when AUTH_ENFORCE=true")
		}
		log.Println("auth: SUPABASE_URL unset — JWT verification disabled (soft mode)")
		return nil
	}
	v, err := newJWKSVerifier(supabaseURL)
	if err != nil {
		if enforce {
			log.Fatalf("auth: %v", err)
		}
		log.Printf("auth: JWKS unavailable, verification disabled (soft mode): %v", err)
		return nil
	}
	return v
}

// openPaths bypass JWT auth on the public listener (health/landing + quota view).
var openPaths = map[string]struct{}{"/": {}, "/limits": {}}

// fiberAuth is the public-listener JWT middleware (soft/enforce per flag).
func fiberAuth(v Verifier, enforce bool) fiber.Handler {
	return func(c *fiber.Ctx) error {
		if _, ok := openPaths[c.Path()]; ok {
			return c.Next()
		}
		token := fiberBearer(c)
		if token == "" {
			if enforce {
				return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "missing bearer token"})
			}
			log.Printf("auth(soft): allowing unauthenticated %s %s (no token)", c.Method(), c.Path())
			return c.Next()
		}
		if v == nil {
			return c.Next()
		}
		uid, err := v.Verify(c.UserContext(), token)
		if err != nil {
			if enforce {
				log.Printf("auth: rejected %s %s: %v", c.Method(), c.Path(), err)
				return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "invalid token"})
			}
			log.Printf("auth(soft): allowing %s %s with invalid token: %v", c.Method(), c.Path(), err)
			return c.Next()
		}
		c.Locals("userID", uid)
		return c.Next()
	}
}

// fiberBearer pulls the token from the Authorization header, falling back to a
// `token` query param.
func fiberBearer(c *fiber.Ctx) string {
	if h := c.Get("Authorization"); h != "" {
		if after, ok := strings.CutPrefix(h, "Bearer "); ok {
			return strings.TrimSpace(after)
		}
	}
	return c.Query("token")
}
