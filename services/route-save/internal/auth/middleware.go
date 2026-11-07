package auth

import (
	"context"
	"log"
	"net/http"
	"strings"
)

// ctxKey is the private context key the verified user id is stored under, so only
// this package can set it (handlers read it back via UserID).
type ctxKey struct{}

// WithUserID returns a copy of ctx carrying the authenticated user id.
func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, ctxKey{}, userID)
}

// UserID returns the authenticated user id RequireAuth stored on the context.
func UserID(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(ctxKey{}).(string)
	return id, ok
}

// extractToken pulls the bearer token from the Authorization header, falling back
// to the `token` query param — the React Native WebSocket client can't set custom
// headers on the upgrade, so it passes the token there instead.
func extractToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if after, ok := strings.CutPrefix(h, "Bearer "); ok {
			return strings.TrimSpace(after)
		}
	}
	return r.URL.Query().Get("token")
}

// RequireAuth verifies the request's token (DemoVerifier: skips the token entirely) and injects the resolved user id into
// the request context before calling next. A missing or invalid token gets a 401.
// The token itself is never logged.
func RequireAuth(v Verifier, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if d, ok := v.(DemoVerifier); ok {
			// demo mode: every request is the demo user, token or not.
			next.ServeHTTP(w, r.WithContext(WithUserID(r.Context(), d.UserID)))
			return
		}
		token := extractToken(r)
		if token == "" {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
		uid, err := v.Verify(r.Context(), token)
		if err != nil {
			log.Printf("auth: rejected %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithUserID(r.Context(), uid)))
	})
}
