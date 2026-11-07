package main

// ownership.go holds the per-user ownership DECISIONS for /api/v1/user/* as pure
// functions (no http, no DB — lookups are injected), so the rules are unit-tested
// in ownership_test.go. userdb.go's scopeToOwner / enforceUpsertOwner wrap them:
// service (mTLS) callers bypass, a violation becomes 401/403 when enforcing and a
// log line in soft mode, and the scoped query / stamped rows apply only when
// enforcing (soft mode never alters legitimate traffic). See AUTH.md.
//
// Three ownership shapes:
//   - userOwnedTables: one owner via `user_id` → forced on reads/deletes, stamped
//     or checked on upserts.
//   - user_friendships: two parties (requester_id / addressee_id) → reads/deletes
//     must filter on the caller as either party; upserts must be requested BY the
//     caller (requester_id stamped if absent).
//   - posts: no user column; owned through posts.event_id → user_defined_events.
//     Reads stay open; upserts/deletes must reference an event the caller owns.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"github.com/jackc/pgx/v5"
)

// violation is a rejected ownership check: the HTTP status + message to return
// when enforcing (soft mode logs it instead).
type violation struct {
	status int
	msg    string
}

func (v *violation) Error() string { return fmt.Sprintf("%d %s", v.status, v.msg) }

// ownerLookups resolves owners for the posts table. eventOwner returns the
// user_id owning a user_defined_events row; postOwner returns the owner of the
// event an EXISTING post hangs off (so an upsert can't re-parent someone else's
// post onto the caller's event). found=false means no such row.
type ownerLookups struct {
	eventOwner func(ctx context.Context, eventID string) (owner string, found bool, err error)
	postOwner  func(ctx context.Context, postID string) (owner string, found bool, err error)
}

// ownershipGoverned reports whether a table has any ownership rule at all.
func ownershipGoverned(table string) bool {
	if _, ok := userOwnedTables[table]; ok {
		return true
	}
	return table == "user_friendships" || table == "posts"
}

// exactFilter returns the plain exact-match value of a query filter (bare `val` or
// `eq.val`), or ok=false when the filter is absent or uses another operator / IN.
func exactFilter(q url.Values, col string) (string, bool) {
	raw := q.Get(col)
	if raw == "" {
		return "", false
	}
	pf := parseFilterValue(raw)
	if pf.isIN || pf.sqlOp != "=" || len(pf.values) != 1 || pf.values[0] == "" {
		return "", false
	}
	return pf.values[0], true
}

// decideScope applies ownership to a GET/DELETE query for end user uid. It returns
// the query to run when enforcing (possibly user-scoped; a copy, never the input)
// and a violation when the request must be rejected. note is a non-fatal remark
// worth logging (e.g. a foreign user_id that was overridden).
func decideScope(ctx context.Context, method, table, uid string, q url.Values, lk ownerLookups) (scoped url.Values, note string, v *violation, err error) {
	scoped = cloneValues(q)
	if !ownershipGoverned(table) {
		return scoped, "", nil, nil
	}
	if table == "posts" && method == http.MethodGet {
		return scoped, "", nil, nil // posts are readable by everyone
	}
	if uid == "" {
		return scoped, "", &violation{http.StatusUnauthorized, "authentication required"}, nil
	}

	switch table {
	case "user_friendships":
		if r, ok := exactFilter(q, "requester_id"); ok && r == uid {
			return scoped, "", nil, nil
		}
		if a, ok := exactFilter(q, "addressee_id"); ok && a == uid {
			return scoped, "", nil, nil
		}
		return scoped, "", &violation{http.StatusForbidden, "filter by requester_id or addressee_id equal to the authenticated user"}, nil

	case "posts": // DELETE
		eventID, ok := exactFilter(q, "event_id")
		if !ok {
			return scoped, "", &violation{http.StatusForbidden, "deleting posts requires an exact event_id filter for an event you own"}, nil
		}
		owner, found, err := lk.eventOwner(ctx, eventID)
		if err != nil {
			return scoped, "", nil, err
		}
		if !found || owner != uid {
			return scoped, "", &violation{http.StatusForbidden, "event_id is not an event owned by the authenticated user"}, nil
		}
		return scoped, "", nil, nil

	default: // userOwnedTables
		if cur := q.Get("user_id"); cur != "" && cur != uid {
			note = fmt.Sprintf("user_id=%s != owner %s — scoping to owner", cur, uid)
		}
		scoped.Set("user_id", uid)
		return scoped, note, nil, nil
	}
}

// stamp is one column value to set on an upsert row when enforcing.
type stamp struct {
	row int
	col string
	val string
}

// decideUpsert applies ownership to an upsert body for end user uid. It returns
// the stamps to apply when enforcing and a violation when the request must be
// rejected. rows are not modified.
func decideUpsert(ctx context.Context, table, uid string, rows []map[string]any, lk ownerLookups) ([]stamp, *violation, error) {
	if !ownershipGoverned(table) {
		return nil, nil, nil
	}
	if uid == "" {
		return nil, &violation{http.StatusUnauthorized, "authentication required"}, nil
	}

	var stamps []stamp
	for i, row := range rows {
		switch table {
		case "user_friendships":
			cur, has := row["requester_id"]
			if has && fmt.Sprintf("%v", cur) != uid {
				return nil, &violation{http.StatusForbidden, fmt.Sprintf("row %d: requester_id does not match the authenticated user", i)}, nil
			}
			stamps = append(stamps, stamp{i, "requester_id", uid})

		case "posts":
			eventID := ""
			if v, ok := row["event_id"]; ok && v != nil {
				eventID = fmt.Sprintf("%v", v)
			}
			if eventID == "" {
				return nil, &violation{http.StatusForbidden, fmt.Sprintf("row %d: event_id is required", i)}, nil
			}
			owner, found, err := lk.eventOwner(ctx, eventID)
			if err != nil {
				return nil, nil, err
			}
			if !found || owner != uid {
				return nil, &violation{http.StatusForbidden, fmt.Sprintf("row %d: event_id is not an event owned by the authenticated user", i)}, nil
			}
			if pid, ok := row["post_id"]; ok && pid != nil && lk.postOwner != nil {
				powner, pfound, err := lk.postOwner(ctx, fmt.Sprintf("%v", pid))
				if err != nil {
					return nil, nil, err
				}
				if pfound && powner != uid {
					return nil, &violation{http.StatusForbidden, fmt.Sprintf("row %d: post_id belongs to another user", i)}, nil
				}
			}

		default: // userOwnedTables
			cur, has := row["user_id"]
			if has && fmt.Sprintf("%v", cur) != uid {
				return nil, &violation{http.StatusForbidden, fmt.Sprintf("row %d: user_id does not match the authenticated user", i)}, nil
			}
			stamps = append(stamps, stamp{i, "user_id", uid})
		}
	}
	return stamps, nil, nil
}

func cloneValues(q url.Values) url.Values {
	out := make(url.Values, len(q))
	for k, v := range q {
		out[k] = append([]string(nil), v...)
	}
	return out
}

// dbOwnerLookups are the production lookups against the user DB.
func dbOwnerLookups() ownerLookups {
	return ownerLookups{
		eventOwner: func(ctx context.Context, eventID string) (string, bool, error) {
			return queryOwner(ctx, `SELECT user_id FROM user_defined_events WHERE event_id = $1`, eventID)
		},
		postOwner: func(ctx context.Context, postID string) (string, bool, error) {
			return queryOwner(ctx, `SELECT e.user_id FROM posts p JOIN user_defined_events e ON e.event_id = p.event_id WHERE p.post_id = $1`, postID)
		},
	}
}

func queryOwner(ctx context.Context, sql, id string) (string, bool, error) {
	var owner string
	err := userDB.QueryRow(ctx, sql, id).Scan(&owner)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return owner, true, nil
}
