package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// fakeLookups: event e-alice / post p-alice belong to alice, e-bob / p-bob to bob.
func fakeLookups() ownerLookups {
	events := map[string]string{"e-alice": "alice", "e-bob": "bob"}
	posts := map[string]string{"p-alice": "alice", "p-bob": "bob"}
	return ownerLookups{
		eventOwner: func(_ context.Context, id string) (string, bool, error) {
			if id == "e-boom" {
				return "", false, errors.New("db down")
			}
			o, ok := events[id]
			return o, ok, nil
		},
		postOwner: func(_ context.Context, id string) (string, bool, error) {
			o, ok := posts[id]
			return o, ok, nil
		},
	}
}

func qv(kv ...string) url.Values {
	q := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		q.Set(kv[i], kv[i+1])
	}
	return q
}

func TestDecideScope(t *testing.T) {
	tests := []struct {
		name       string
		method     string
		table      string
		uid        string
		q          url.Values
		wantStatus int    // 0 = allowed
		wantUserID string // expected scoped user_id ("" = not checked)
		wantErr    bool
	}{
		{"ungoverned table passes", "GET", "calgary_transit_stops", "", qv(), 0, "", false},
		{"owned: anonymous → 401", "GET", "saved_addresses", "", qv(), 401, "", false},
		{"owned: scoped to caller", "GET", "saved_addresses", "alice", qv(), 0, "alice", false},
		{"owned: foreign user_id overridden", "DELETE", "saved_addresses", "alice", qv("user_id", "bob"), 0, "alice", false},
		{"user_posts is owned", "GET", "user_posts", "alice", qv("user_id", "bob"), 0, "alice", false},
		{"route_reports is owned", "DELETE", "route_reports", "alice", qv("report_id", "r1"), 0, "alice", false},

		{"friendships: anonymous → 401", "GET", "user_friendships", "", qv("requester_id", "alice"), 401, "", false},
		{"friendships: requester=caller", "GET", "user_friendships", "alice", qv("requester_id", "alice"), 0, "", false},
		{"friendships: eq.addressee=caller", "DELETE", "user_friendships", "alice", qv("addressee_id", "eq.alice"), 0, "", false},
		{"friendships: no party filter → 403", "GET", "user_friendships", "alice", qv("status", "ACTIVE"), 403, "", false},
		{"friendships: other user → 403", "GET", "user_friendships", "alice", qv("requester_id", "bob"), 403, "", false},
		{"friendships: IN filter → 403", "GET", "user_friendships", "alice", qv("requester_id", "in.(alice,bob)"), 403, "", false},
		{"friendships: neq filter → 403", "DELETE", "user_friendships", "alice", qv("addressee_id", "neq.alice"), 403, "", false},

		{"posts: read open, anonymous", "GET", "posts", "", qv(), 0, "", false},
		{"posts: delete own event", "DELETE", "posts", "alice", qv("event_id", "e-alice", "post_id", "p1"), 0, "", false},
		{"posts: delete other's event → 403", "DELETE", "posts", "alice", qv("event_id", "e-bob"), 403, "", false},
		{"posts: delete unknown event → 403", "DELETE", "posts", "alice", qv("event_id", "e-none"), 403, "", false},
		{"posts: delete without event_id → 403", "DELETE", "posts", "alice", qv("post_id", "p-alice"), 403, "", false},
		{"posts: delete anonymous → 401", "DELETE", "posts", "", qv("event_id", "e-alice"), 401, "", false},
		{"posts: lookup error surfaces", "DELETE", "posts", "alice", qv("event_id", "e-boom"), 0, "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig := cloneValues(tt.q)
			scoped, _, v, err := decideScope(context.Background(), tt.method, tt.table, tt.uid, tt.q, fakeLookups())
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			gotStatus := 0
			if v != nil {
				gotStatus = v.status
			}
			if gotStatus != tt.wantStatus {
				t.Fatalf("status = %d, want %d (%v)", gotStatus, tt.wantStatus, v)
			}
			if tt.wantUserID != "" && scoped.Get("user_id") != tt.wantUserID {
				t.Errorf("scoped user_id = %q, want %q", scoped.Get("user_id"), tt.wantUserID)
			}
			if tt.q.Encode() != orig.Encode() {
				t.Errorf("input query mutated: %v → %v", orig, tt.q)
			}
		})
	}
}

func TestDecideUpsert(t *testing.T) {
	tests := []struct {
		name       string
		table      string
		uid        string
		rows       []map[string]any
		wantStatus int
		wantStamps []stamp
		wantErr    bool
	}{
		{"ungoverned table passes", "calgary_transit_stops", "", []map[string]any{{"x": 1}}, 0, nil, false},
		{"owned: anonymous → 401", "saved_addresses", "", []map[string]any{{}}, 401, nil, false},
		{"owned: stamps absent user_id", "route_reports", "alice", []map[string]any{{"kind": "crowd"}}, 0, []stamp{{0, "user_id", "alice"}}, false},
		{"owned: foreign user_id → 403", "user_posts", "alice", []map[string]any{{"user_id": "alice"}, {"user_id": "bob"}}, 403, nil, false},

		{"friendships: stamps requester", "user_friendships", "alice", []map[string]any{{"addressee_id": "bob"}}, 0, []stamp{{0, "requester_id", "alice"}}, false},
		{"friendships: matching requester ok", "user_friendships", "alice", []map[string]any{{"requester_id": "alice", "addressee_id": "bob"}}, 0, []stamp{{0, "requester_id", "alice"}}, false},
		{"friendships: foreign requester → 403", "user_friendships", "alice", []map[string]any{{"requester_id": "bob", "addressee_id": "alice"}}, 403, nil, false},
		{"friendships: anonymous → 401", "user_friendships", "", []map[string]any{{"addressee_id": "bob"}}, 401, nil, false},

		{"posts: own event, new post", "posts", "alice", []map[string]any{{"event_id": "e-alice", "post_id": "p-new"}}, 0, nil, false},
		{"posts: own event, own post", "posts", "alice", []map[string]any{{"event_id": "e-alice", "post_id": "p-alice"}}, 0, nil, false},
		{"posts: other's event → 403", "posts", "alice", []map[string]any{{"event_id": "e-bob"}}, 403, nil, false},
		{"posts: missing event_id → 403", "posts", "alice", []map[string]any{{"post_id": "p-new"}}, 403, nil, false},
		{"posts: re-parent other's post → 403", "posts", "alice", []map[string]any{{"event_id": "e-alice", "post_id": "p-bob"}}, 403, nil, false},
		{"posts: anonymous → 401", "posts", "", []map[string]any{{"event_id": "e-alice"}}, 401, nil, false},
		{"posts: lookup error surfaces", "posts", "alice", []map[string]any{{"event_id": "e-boom"}}, 0, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			stamps, v, err := decideUpsert(context.Background(), tt.table, tt.uid, tt.rows, fakeLookups())
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			gotStatus := 0
			if v != nil {
				gotStatus = v.status
			}
			if gotStatus != tt.wantStatus {
				t.Fatalf("status = %d, want %d (%v)", gotStatus, tt.wantStatus, v)
			}
			if v == nil && !tt.wantErr {
				if len(stamps) != len(tt.wantStamps) {
					t.Fatalf("stamps = %v, want %v", stamps, tt.wantStamps)
				}
				for i := range stamps {
					if stamps[i] != tt.wantStamps[i] {
						t.Errorf("stamp %d = %v, want %v", i, stamps[i], tt.wantStamps[i])
					}
				}
			}
		})
	}
}

// TestScopeToOwnerModes checks the http wrapper: enforce rejects, soft logs and
// leaves the query untouched, service callers bypass.
func TestScopeToOwnerModes(t *testing.T) {
	orig := ownerLookupsImpl
	ownerLookupsImpl = fakeLookups()
	defer func() { ownerLookupsImpl = orig; authEnforce = true }()

	run := func(enforce, service bool, uid string, q url.Values) (url.Values, bool, int) {
		authEnforce = enforce
		r := httptest.NewRequest(http.MethodGet, "/api/v1/user/user_friendships", nil)
		ctx := r.Context()
		if uid != "" {
			ctx = withUserID(ctx, uid)
		}
		if service {
			ctx = withService(ctx, "tranzit-route-save")
		}
		w := httptest.NewRecorder()
		out, ok := scopeToOwner(w, r.WithContext(ctx), "user_friendships", q)
		return out, ok, w.Code
	}

	if _, ok, code := run(true, false, "alice", qv("requester_id", "bob")); ok || code != 403 {
		t.Errorf("enforce: ok=%v code=%d, want rejected 403", ok, code)
	}
	if out, ok, _ := run(false, false, "alice", qv("requester_id", "bob")); !ok || out.Get("requester_id") != "bob" {
		t.Errorf("soft: ok=%v q=%v, want allowed unchanged", ok, out)
	}
	if _, ok, _ := run(true, true, "", qv()); !ok {
		t.Errorf("service caller should bypass")
	}

	// enforce on an owned table scopes user_id; soft leaves it.
	authEnforce = true
	r := httptest.NewRequest(http.MethodGet, "/api/v1/user/saved_addresses", nil)
	r = r.WithContext(withUserID(r.Context(), "alice"))
	out, ok := scopeToOwner(httptest.NewRecorder(), r, "saved_addresses", qv("user_id", "bob"))
	if !ok || out.Get("user_id") != "alice" {
		t.Errorf("enforce owned: ok=%v user_id=%q, want alice", ok, out.Get("user_id"))
	}
	authEnforce = false
	out, ok = scopeToOwner(httptest.NewRecorder(), r, "saved_addresses", qv("user_id", "bob"))
	if !ok || out.Get("user_id") != "bob" {
		t.Errorf("soft owned: ok=%v user_id=%q, want bob", ok, out.Get("user_id"))
	}
}

func TestDemoAuth(t *testing.T) {
	var got string
	h := requireUserAuth(demoVerifier{uid: "demo-user"}, true, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = userIDOf(r.Context())
	}))
	for _, hdr := range []string{"", "Bearer demo", "Bearer anything-else"} {
		got = ""
		r := httptest.NewRequest(http.MethodGet, "/api/v1/user/saved_addresses", nil)
		if hdr != "" {
			r.Header.Set("Authorization", hdr)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 || got != "demo-user" {
			t.Errorf("auth %q: code=%d uid=%q, want 200 demo-user", hdr, w.Code, got)
		}
	}
}

func TestSplitIDsAndClamp(t *testing.T) {
	s := "3, 301,,7"
	if got := splitIDs(&s); len(got) != 3 || got[1] != "301" {
		t.Errorf("splitIDs = %v", got)
	}
	if got := splitIDs(nil); got == nil || len(got) != 0 {
		t.Errorf("splitIDs(nil) = %v, want []", got)
	}
	for _, c := range []struct {
		in       string
		def, max int
		want     int
	}{{"", 60, 1440, 60}, {"0", 60, 1440, 60}, {"-5", 20, 100, 20}, {"5000", 60, 1440, 1440}, {"30", 60, 1440, 30}, {"x", 20, 100, 20}} {
		if got := clampInt(c.in, c.def, c.max); got != c.want {
			t.Errorf("clampInt(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestConflictTarget(t *testing.T) {
	row := map[string]any{"user_id": "u", "event_id": "e", "travel_time": 12}
	if got := conflictTarget("user_calendar", row, []string{"calendar_entry_id"}); len(got) != 2 || got[0] != "user_id" || got[1] != "event_id" {
		t.Fatalf("user_calendar natural key: got %v", got)
	}
	if got := conflictTarget("user_calendar", map[string]any{"user_id": "u"}, []string{"calendar_entry_id"}); got != nil {
		t.Fatalf("partial natural key should be a plain insert, got %v", got)
	}
	if got := conflictTarget("user_defined_events", map[string]any{"event_id": "e"}, []string{"event_id"}); len(got) != 1 {
		t.Fatalf("pk supplied: got %v", got)
	}
	if got := conflictTarget("user_history", map[string]any{"user_id": "u"}, []string{"history_id"}); got != nil {
		t.Fatalf("generated pk, no natural key: got %v", got)
	}
}
