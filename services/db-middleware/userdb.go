package main

// userdb.go adds a SECOND, fully separate database: the tranzit-user-db Postgres
// that lives privately on the tailnet. It does NOT touch the Supabase pool (`db`)
// or any existing route — it stands up its own pgxpool (`userDB`) and serves the
// 13 user-data tables under the /api/v1/user/ prefix:
//
//   GET    /api/v1/user/          → list user tables
//   GET    /api/v1/user/{table}   → query a user table (same PostgREST-ish filters as /api/v1)
//   POST   /api/v1/user/{table}   → upsert one row or an array of rows (INSERT … ON CONFLICT)
//   DELETE /api/v1/user/{table}   → delete rows matching the query filters (filter required)
//
// Reads are NOT cached here — user data is mutable per request, unlike the GTFS
// reference/realtime tables fronted by main.go's response cache.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// userDB is the pool for the tailnet tranzit-user-db. It is nil when the DB is
// not configured/reachable, in which case the /api/v1/user/ routes return 503 —
// the rest of the service (Supabase-backed) keeps working regardless.
var userDB *pgxpool.Pool

// userTables is the whitelist for the user database — no other table is queryable
// or writable, mirroring main.go's allowedTables guard against SQL injection via
// the table name.
var userTables = map[string]struct{}{
	"user_info":                       {},
	"user_defined_default_categories": {},
	"user_defined_default_themes":     {},
	"user_defined_events":             {},
	"cached_pre_routes":               {},
	"posts":                           {},
	"saved_addresses":                 {},
	"user_themes":                     {},
	"user_history":                    {},
	"user_calendar":                   {},
	"user_posts":                      {},
	"user_friendships":                {},
	"route_reports":                   {},
}

// userOwnedTables are the user-data tables whose every row belongs to one user via
// the `user_id` column. On these, an end user may only touch their own rows: the
// authenticated token `sub` is forced onto reads/deletes and required on upserts
// (ownership.go, AUTH.md). Service (mTLS) callers bypass this. user_friendships
// (two parties) and posts (owned via its event) have their own rules in
// ownership.go.
var userOwnedTables = map[string]struct{}{
	"user_info":                       {},
	"user_defined_default_categories": {},
	"user_defined_default_themes":     {},
	"user_defined_events":             {},
	"cached_pre_routes":               {},
	"saved_addresses":                 {},
	"user_themes":                     {},
	"user_history":                    {},
	"user_calendar":                   {},
	"user_posts":                      {},
	"route_reports":                   {},
}

// ownerLookupsImpl is swapped in tests; production queries the user DB.
var ownerLookupsImpl = dbOwnerLookups()

// scopeToOwner enforces row ownership on a read/delete query (decideScope). It
// returns the (possibly user-scoped) query and ok=false if the request was
// rejected (a response has already been written). Ungoverned tables and service
// callers pass through untouched. In soft mode violations are only logged and the
// query is never altered, so legitimate traffic is unchanged before the flip.
func scopeToOwner(w http.ResponseWriter, r *http.Request, table string, q url.Values) (url.Values, bool) {
	if !ownershipGoverned(table) || isServiceCaller(r.Context()) {
		return q, true
	}
	scoped, note, v, err := decideScope(r.Context(), r.Method, table, userIDOf(r.Context()), q, ownerLookupsImpl)
	if err != nil {
		log.Printf("ownership: %s /api/v1/user/%s lookup: %v", r.Method, table, err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return q, false
	}
	if v != nil {
		if authEnforce {
			log.Printf("ownership: rejected %s /api/v1/user/%s: %s", r.Method, table, v.msg)
			jsonError(w, v.msg, v.status)
			return q, false
		}
		log.Printf("ownership(soft): %s /api/v1/user/%s would reject (%d %s) — allowing", r.Method, table, v.status, v.msg)
		return q, true
	}
	if !authEnforce {
		if note != "" {
			log.Printf("ownership(soft): %s /api/v1/user/%s %s — would scope; allowing as-is", r.Method, table, note)
		}
		return q, true
	}
	if note != "" {
		log.Printf("ownership: %s /api/v1/user/%s %s", r.Method, table, note)
	}
	return scoped, true
}

// enforceUpsertOwner applies ownership to an upsert body (decideUpsert): when
// enforcing, violations are rejected (401/403) and owner columns are stamped onto
// the rows; soft mode only logs. Returns false when the request was rejected
// (response already written).
func enforceUpsertOwner(w http.ResponseWriter, r *http.Request, table string, rows []map[string]any) bool {
	if !ownershipGoverned(table) || isServiceCaller(r.Context()) {
		return true
	}
	stamps, v, err := decideUpsert(r.Context(), table, userIDOf(r.Context()), rows, ownerLookupsImpl)
	if err != nil {
		log.Printf("ownership: POST /api/v1/user/%s lookup: %v", table, err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return false
	}
	if v != nil {
		if authEnforce {
			log.Printf("ownership: rejected POST /api/v1/user/%s: %s", table, v.msg)
			jsonError(w, v.msg, v.status)
			return false
		}
		log.Printf("ownership(soft): POST /api/v1/user/%s would reject (%d %s) — allowing", table, v.status, v.msg)
		return true
	}
	if authEnforce {
		for _, st := range stamps {
			rows[st.row][st.col] = st.val // stamp absent / re-affirm matching
		}
	}
	return true
}

// userColMeta is the cached per-table schema needed to build safe SELECT/UPSERT.
type userColMeta struct {
	cols     []string            // all columns, ordinal order
	colSet   map[string]struct{} // membership test
	udt      map[string]string   // column → pg udt_name (int8, jsonb, timestamptz…) for placeholder casts
	writable map[string]struct{} // columns that may be inserted (excludes GENERATED ALWAYS / identity-always)
	pk       []string            // primary-key columns, ordinal order
}

var userMetaCache sync.Map // table → *userColMeta

// initUserDB stands up the user-database pool from TRANZIT_USER_DB_CONNECTION_STRING.
// It is deliberately non-fatal: a missing var or an unreachable tailnet at startup
// must never take down the Supabase-backed service. pgxpool connects lazily, so a
// failed initial ping is logged as a warning and the pool is kept for later retries.
func initUserDB(ctx context.Context) {
	dsn := os.Getenv("TRANZIT_USER_DB_CONNECTION_STRING")
	if dsn == "" {
		log.Println("user-db: TRANZIT_USER_DB_CONNECTION_STRING not set — /api/v1/user/ disabled")
		return
	}

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		log.Printf("user-db: ParseConfig failed, /api/v1/user/ disabled: %v", err)
		return
	}
	cfg.MaxConns = 5
	cfg.MinConns = 0
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.HealthCheckPeriod = time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		log.Printf("user-db: pool creation failed, /api/v1/user/ disabled: %v", err)
		return
	}
	userDB = pool

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := userDB.Ping(pingCtx); err != nil {
		// Keep the pool — it may become reachable once the tailnet is up.
		log.Printf("user-db: initial ping failed (will retry on demand): %v", err)
		return
	}
	log.Println("user-db: connected to tranzit-user-db")
}

// withCORSWrite is withCORS but also advertises the write methods for these endpoints.
func withCORSWrite(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}

// handleUserData routes /api/v1/user/ GET (read) and POST (upsert) requests.
func handleUserData(w http.ResponseWriter, r *http.Request) {
	if userDB == nil {
		jsonError(w, "user database not configured", http.StatusServiceUnavailable)
		return
	}

	segment := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/user/"), "/")

	switch r.Method {
	case http.MethodGet:
		if segment == "" {
			listUserTables(w)
			return
		}
		handleUserSelect(w, r, segment)
	case http.MethodPost:
		if segment == "" {
			jsonError(w, "a table must be specified, e.g. /api/v1/user/user_info", http.StatusBadRequest)
			return
		}
		handleUserUpsert(w, r, segment)
	case http.MethodDelete:
		if segment == "" {
			jsonError(w, "a table must be specified, e.g. /api/v1/user/saved_addresses", http.StatusBadRequest)
			return
		}
		handleUserDelete(w, r, segment)
	default:
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func listUserTables(w http.ResponseWriter) {
	tables := make([]string, 0, len(userTables))
	for t := range userTables {
		tables = append(tables, t)
	}
	sort.Strings(tables)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"tables": tables})
}

// userTableMeta loads (and caches) the column/PK metadata for a whitelisted table.
func userTableMeta(ctx context.Context, table string) (*userColMeta, error) {
	if v, ok := userMetaCache.Load(table); ok {
		return v.(*userColMeta), nil
	}

	m := &userColMeta{
		colSet:   make(map[string]struct{}),
		udt:      make(map[string]string),
		writable: make(map[string]struct{}),
	}

	rows, err := userDB.Query(ctx, `
		SELECT column_name, udt_name, is_identity, identity_generation, is_generated
		FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = $1
		ORDER BY ordinal_position`,
		table,
	)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var name, udt, isIdentity, isGenerated string
		var identityGen *string
		if err := rows.Scan(&name, &udt, &isIdentity, &identityGen, &isGenerated); err != nil {
			rows.Close()
			return nil, err
		}
		m.cols = append(m.cols, name)
		m.colSet[name] = struct{}{}
		m.udt[name] = udt
		genAlways := isGenerated == "ALWAYS" ||
			(isIdentity == "YES" && identityGen != nil && *identityGen == "ALWAYS")
		if !genAlways {
			m.writable[name] = struct{}{}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(m.cols) == 0 {
		return nil, fmt.Errorf("table %q has no columns (does it exist?)", table)
	}

	pkRows, err := userDB.Query(ctx, `
		SELECT kcu.column_name
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
		  ON kcu.constraint_name = tc.constraint_name
		 AND kcu.table_schema = tc.table_schema
		WHERE tc.table_schema = 'public'
		  AND tc.table_name = $1
		  AND tc.constraint_type = 'PRIMARY KEY'
		ORDER BY kcu.ordinal_position`,
		table,
	)
	if err != nil {
		return nil, err
	}
	for pkRows.Next() {
		var c string
		if err := pkRows.Scan(&c); err != nil {
			pkRows.Close()
			return nil, err
		}
		m.pk = append(m.pk, c)
	}
	pkRows.Close()
	if err := pkRows.Err(); err != nil {
		return nil, err
	}

	userMetaCache.Store(table, m)
	return m, nil
}

// quoteIdent double-quotes a SQL identifier. Identifiers here always originate
// from the table whitelist or information_schema, never from raw user input.
func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// ── GET: read a user table ─────────────────────────────────────────────────────

func handleUserSelect(w http.ResponseWriter, r *http.Request, table string) {
	if _, ok := userTables[table]; !ok {
		jsonError(w, fmt.Sprintf("unknown table %q", table), http.StatusNotFound)
		return
	}

	q, ok := scopeToOwner(w, r, table, r.URL.Query())
	if !ok {
		return
	}
	body, err := buildUserSelect(r.Context(), table, q)
	if err != nil {
		log.Printf("user-db select(%s): %v", table, err)
		jsonError(w, "query failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

// buildUserSelect runs a parameterised query against the user DB. It mirrors the
// PostgREST-ish filter handling in buildTableResponse (limit/offset/order_by/order,
// per-column filters, ?or=(…)), reusing parseFilterValue/parseORTerms from main.go.
func buildUserSelect(ctx context.Context, table string, q url.Values) ([]byte, error) {
	m, err := userTableMeta(ctx, table)
	if err != nil {
		return nil, err
	}

	limit, offset := 100, 0
	if v := q.Get("limit"); v != "" {
		if n, err2 := strconv.Atoi(v); err2 == nil && n > 0 && n <= 10_000 {
			limit = n
		}
	}
	if v := q.Get("offset"); v != "" {
		if n, err2 := strconv.Atoi(v); err2 == nil && n >= 0 {
			offset = n
		}
	}

	var orderClause string
	if ob := q.Get("order_by"); ob != "" {
		if _, ok := m.colSet[ob]; ok {
			dir := "ASC"
			if strings.ToUpper(q.Get("order")) == "DESC" {
				dir = "DESC"
			}
			orderClause = fmt.Sprintf(" ORDER BY %s %s", quoteIdent(ob), dir)
		}
	}

	var conds []string
	var args []any
	idx := 1

	for key, vals := range q {
		switch key {
		case "limit", "offset", "order_by", "order", "or", "upsert":
			continue
		}
		if _, ok := m.colSet[key]; !ok {
			continue
		}
		pf := parseFilterValue(vals[0])
		if pf.isIN {
			if len(pf.values) == 0 {
				continue
			}
			placeholders := make([]string, len(pf.values))
			for i, v := range pf.values {
				placeholders[i] = fmt.Sprintf("$%d", idx)
				args = append(args, strings.TrimSpace(v))
				idx++
			}
			conds = append(conds, fmt.Sprintf("%s IN (%s)", quoteIdent(key), strings.Join(placeholders, ", ")))
		} else {
			conds = append(conds, fmt.Sprintf("%s %s $%d", quoteIdent(key), pf.sqlOp, idx))
			args = append(args, pf.values[0])
			idx++
		}
	}

	if orVal := q.Get("or"); orVal != "" {
		if terms := parseORTerms(orVal, m.colSet); len(terms) > 0 {
			orParts := make([]string, len(terms))
			for i, t := range terms {
				orParts[i] = fmt.Sprintf("%s %s $%d", quoteIdent(t.col), t.sqlOp, idx)
				args = append(args, t.val)
				idx++
			}
			conds = append(conds, "("+strings.Join(orParts, " OR ")+")")
		}
	}

	query := "SELECT * FROM " + quoteIdent(table)
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	query += orderClause
	query += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)

	rows, err := userDB.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	fds := rows.FieldDescriptions()
	colNames := make([]string, len(fds))
	for i, fd := range fds {
		colNames[i] = string(fd.Name)
	}

	result := make([]map[string]any, 0)
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			log.Printf("user-db row.Values: %v", err)
			continue
		}
		row := make(map[string]any, len(colNames))
		for i, name := range colNames {
			row[name] = vals[i]
		}
		result = append(result, row)
	}
	if rows.Err() != nil {
		return nil, rows.Err()
	}

	return json.Marshal(map[string]any{
		"table":  table,
		"count":  len(result),
		"limit":  limit,
		"offset": offset,
		"data":   result,
	})
}

// ── POST: upsert into a user table ─────────────────────────────────────────────

func handleUserUpsert(w http.ResponseWriter, r *http.Request, table string) {
	if _, ok := userTables[table]; !ok {
		jsonError(w, fmt.Sprintf("unknown table %q", table), http.StatusNotFound)
		return
	}

	raw, err := io.ReadAll(io.LimitReader(r.Body, 5<<20)) // 5 MiB cap
	if err != nil {
		jsonError(w, "could not read request body", http.StatusBadRequest)
		return
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		jsonError(w, "request body is empty", http.StatusBadRequest)
		return
	}

	// Accept either a single JSON object or an array of objects. UseNumber keeps
	// integers exact (avoids float64 widening) so they cast cleanly per column type.
	var inputRows []map[string]any
	dec := json.NewDecoder(strings.NewReader(trimmed))
	dec.UseNumber()
	if trimmed[0] == '[' {
		if err := dec.Decode(&inputRows); err != nil {
			jsonError(w, "invalid JSON array of rows", http.StatusBadRequest)
			return
		}
	} else {
		var one map[string]any
		if err := dec.Decode(&one); err != nil {
			jsonError(w, "invalid JSON object", http.StatusBadRequest)
			return
		}
		inputRows = []map[string]any{one}
	}
	if len(inputRows) == 0 {
		jsonError(w, "no rows to insert", http.StatusBadRequest)
		return
	}

	if !enforceUpsertOwner(w, r, table, inputRows) {
		return
	}

	m, err := userTableMeta(r.Context(), table)
	if err != nil {
		log.Printf("user-db meta(%s): %v", table, err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}

	tx, err := userDB.Begin(r.Context())
	if err != nil {
		log.Printf("user-db begin: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(r.Context())

	returned := make([]map[string]any, 0, len(inputRows))
	for i, row := range inputRows {
		sqlText, args, badReq, err := buildUserUpsert(table, row, m)
		if err != nil {
			if badReq {
				jsonError(w, fmt.Sprintf("row %d: %v", i, err), http.StatusBadRequest)
				return
			}
			log.Printf("user-db build upsert(%s): %v", table, err)
			jsonError(w, "internal server error", http.StatusInternalServerError)
			return
		}

		rows, err := tx.Query(r.Context(), sqlText, args...)
		if err != nil {
			log.Printf("user-db upsert(%s): %v", table, err)
			status, msg := pgWriteError(err, i)
			jsonError(w, msg, status)
			return
		}
		fds := rows.FieldDescriptions()
		colNames := make([]string, len(fds))
		for j, fd := range fds {
			colNames[j] = string(fd.Name)
		}
		for rows.Next() {
			vals, err := rows.Values()
			if err != nil {
				rows.Close()
				log.Printf("user-db returning values: %v", err)
				jsonError(w, "internal server error", http.StatusInternalServerError)
				return
			}
			out := make(map[string]any, len(colNames))
			for j, name := range colNames {
				out[name] = vals[j]
			}
			returned = append(returned, out)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			log.Printf("user-db returning rows: %v", err)
			status, msg := pgWriteError(err, i)
			jsonError(w, msg, status)
			return
		}
		rows.Close()
	}

	if err := tx.Commit(r.Context()); err != nil {
		log.Printf("user-db commit(%s): %v", table, err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"table": table,
		"count": len(returned),
		"data":  returned,
	})
}

// ── DELETE: remove rows from a user table ──────────────────────────────────────

// handleUserDelete deletes rows matching the query filters, reusing the same
// PostgREST-ish filter parsing as the GET path. It refuses an unfiltered delete
// (no WHERE) so a stray request can never wipe a whole table. On user-owned tables
// the delete is scoped to the authenticated user (scopeToOwner) when enforcing.
func handleUserDelete(w http.ResponseWriter, r *http.Request, table string) {
	if _, ok := userTables[table]; !ok {
		jsonError(w, fmt.Sprintf("unknown table %q", table), http.StatusNotFound)
		return
	}

	m, err := userTableMeta(r.Context(), table)
	if err != nil {
		log.Printf("user-db meta(%s): %v", table, err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}

	q, ok := scopeToOwner(w, r, table, r.URL.Query())
	if !ok {
		return
	}

	var conds []string
	var args []any
	idx := 1
	for key, vals := range q {
		if _, ok := m.colSet[key]; !ok {
			continue
		}
		pf := parseFilterValue(vals[0])
		if pf.isIN {
			if len(pf.values) == 0 {
				continue
			}
			placeholders := make([]string, len(pf.values))
			for i, v := range pf.values {
				placeholders[i] = fmt.Sprintf("$%d", idx)
				args = append(args, strings.TrimSpace(v))
				idx++
			}
			conds = append(conds, fmt.Sprintf("%s IN (%s)", quoteIdent(key), strings.Join(placeholders, ", ")))
		} else {
			conds = append(conds, fmt.Sprintf("%s %s $%d", quoteIdent(key), pf.sqlOp, idx))
			args = append(args, pf.values[0])
			idx++
		}
	}

	if len(conds) == 0 {
		jsonError(w, "refusing to delete without a filter", http.StatusBadRequest)
		return
	}

	query := "DELETE FROM " + quoteIdent(table) + " WHERE " + strings.Join(conds, " AND ")
	tag, err := userDB.Exec(r.Context(), query, args...)
	if err != nil {
		log.Printf("user-db delete(%s): %v", table, err)
		status, msg := pgWriteError(err, 0)
		jsonError(w, msg, status)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"table":   table,
		"deleted": tag.RowsAffected(),
	})
}

// pgWriteError maps postgres errors to an HTTP status + message for the client.
func pgWriteError(err error, rowIdx int) (int, string) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return http.StatusConflict, fmt.Sprintf("row %d: conflict — %s", rowIdx, pgErr.Detail)
	}
	return http.StatusInternalServerError, "internal server error"
}

// naturalKeys lists tables whose primary key is DB-generated but which carry a
// UNIQUE natural key the client always supplies. Upserts on these conflict on the
// natural key, so re-saving a row updates it instead of failing with 409.
var naturalKeys = map[string][]string{
	"user_calendar": {"user_id", "event_id"}, // UNIQUE (user_id, event_id)
}

// conflictTarget picks the ON CONFLICT columns for an upsert: the PK when every
// PK column is present, else the table's natural key when every one of its
// columns is present, else nil (plain INSERT).
func conflictTarget(table string, row map[string]any, pk []string) []string {
	all := func(cols []string) bool {
		if len(cols) == 0 {
			return false
		}
		for _, c := range cols {
			if _, ok := row[c]; !ok {
				return false
			}
		}
		return true
	}
	if all(pk) {
		return pk
	}
	if nk := naturalKeys[table]; all(nk) {
		return nk
	}
	return nil
}

// buildUserUpsert builds an INSERT … ON CONFLICT … RETURNING * for one row.
//
//   - Only whitelisted, writable columns are inserted; GENERATED ALWAYS / identity
//     columns are silently dropped (the DB generates them). Unknown columns are a 400.
//   - Each placeholder is cast to its column's pg type ($n::udt_name) and the value
//     is bound as text/JSON, so Postgres' input functions handle every type uniformly.
//   - When every PK column is supplied, conflicts UPDATE the non-PK columns (or DO
//     NOTHING if there are none). When the PK is DB-generated (not supplied), it's a
//     plain INSERT.
//
// badReq reports whether a returned error is the caller's fault (→ 400).
func buildUserUpsert(table string, row map[string]any, m *userColMeta) (sqlText string, args []any, badReq bool, err error) {
	if len(row) == 0 {
		return "", nil, true, fmt.Errorf("empty row")
	}

	// Deterministic column order for stable SQL.
	insertCols := make([]string, 0, len(row))
	for _, c := range m.cols {
		if _, present := row[c]; !present {
			continue
		}
		if _, ok := m.writable[c]; !ok {
			continue // generated-always: ignore any supplied value
		}
		insertCols = append(insertCols, c)
	}
	// Reject columns that don't exist on the table (typo protection / no silent loss).
	for k := range row {
		if _, ok := m.colSet[k]; !ok {
			return "", nil, true, fmt.Errorf("unknown column %q", k)
		}
	}
	if len(insertCols) == 0 {
		return "", nil, true, fmt.Errorf("no writable columns provided")
	}

	cols := make([]string, len(insertCols))
	placeholders := make([]string, len(insertCols))
	args = make([]any, len(insertCols))
	for i, c := range insertCols {
		cols[i] = quoteIdent(c)
		placeholders[i] = fmt.Sprintf("$%d::%s", i+1, m.udt[c])
		v, err := normalizeArg(row[c])
		if err != nil {
			return "", nil, true, fmt.Errorf("column %q: %v", c, err)
		}
		args[i] = v
	}

	var b strings.Builder
	fmt.Fprintf(&b, "INSERT INTO %s (%s) VALUES (%s)",
		quoteIdent(table), strings.Join(cols, ", "), strings.Join(placeholders, ", "))

	// Upsert on the full PK when it is supplied. A table whose PK is DB-generated
	// can still name a UNIQUE natural key (naturalKeys) to upsert on; otherwise it
	// is a plain INSERT.
	conflict := conflictTarget(table, row, m.pk)
	if len(conflict) > 0 {
		keySet := make(map[string]struct{}, len(conflict))
		quotedKey := make([]string, len(conflict))
		for i, k := range conflict {
			keySet[k] = struct{}{}
			quotedKey[i] = quoteIdent(k)
		}
		var updates []string
		for _, c := range insertCols {
			if _, isKey := keySet[c]; isKey {
				continue
			}
			updates = append(updates, fmt.Sprintf("%s = EXCLUDED.%s", quoteIdent(c), quoteIdent(c)))
		}
		if len(updates) > 0 {
			fmt.Fprintf(&b, " ON CONFLICT (%s) DO UPDATE SET %s",
				strings.Join(quotedKey, ", "), strings.Join(updates, ", "))
		} else {
			fmt.Fprintf(&b, " ON CONFLICT (%s) DO NOTHING", strings.Join(quotedKey, ", "))
		}
	}
	b.WriteString(" RETURNING *")
	return b.String(), args, false, nil
}

// normalizeArg renders a decoded JSON value as a bound parameter. Scalars become
// their text form and nested objects/arrays become JSON text; combined with the
// per-column ::udt_name cast in the SQL, Postgres' input functions convert each to
// the right type (int, numeric, bool, timestamptz, jsonb, …).
func normalizeArg(v any) (any, error) {
	switch t := v.(type) {
	case nil:
		return nil, nil
	case string:
		return t, nil
	case bool:
		return strconv.FormatBool(t), nil
	case json.Number:
		return t.String(), nil
	case float64: // only if UseNumber were off; kept for safety
		return strconv.FormatFloat(t, 'f', -1, 64), nil
	case map[string]any, []any:
		b, err := json.Marshal(t)
		if err != nil {
			return nil, err
		}
		return string(b), nil
	default:
		return nil, fmt.Errorf("unsupported value type %T", v)
	}
}
