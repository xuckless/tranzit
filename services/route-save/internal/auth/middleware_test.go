package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type rejectAll struct{}

func (rejectAll) Verify(context.Context, string) (string, error) { return "", errors.New("nope") }

func TestRequireAuthDemo(t *testing.T) {
	var got string
	h := RequireAuth(DemoVerifier{UserID: "demo-user"}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = UserID(r.Context())
	}))
	for _, target := range []string{"/trips", "/trips?token=demo", "/trips"} {
		for _, hdr := range []string{"", "Bearer demo", "Bearer other"} {
			got = ""
			r := httptest.NewRequest(http.MethodGet, target, nil)
			if hdr != "" {
				r.Header.Set("Authorization", hdr)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != http.StatusOK || got != "demo-user" {
				t.Errorf("%s %q: code=%d uid=%q", target, hdr, w.Code, got)
			}
		}
	}
}

func TestRequireAuthRejects(t *testing.T) {
	h := RequireAuth(rejectAll{}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	for _, hdr := range []string{"", "Bearer demo"} {
		r := httptest.NewRequest(http.MethodGet, "/trips", nil)
		if hdr != "" {
			r.Header.Set("Authorization", hdr)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("%q: code=%d, want 401", hdr, w.Code)
		}
	}
}
