package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

var (
	db          *pgxpool.Pool
	columnCache sync.Map // map[string][]string — table → column list
)

// allowedTables is a whitelist — no other table can be queried.
var allowedTables = map[string]struct{}{
	"calgary_transit_stops":  {},
	"calgary_transit_routes": {},
	"calgary_train_stations": {},
	"trip_updates":           {},
	"stop_time_updates":      {},
	"vehicle_positions":      {},
	"alerts":                 {},
	"trip_stop_delays":       {},
	"stop_analytics":         {},
}

func main() {
	_ = godotenv.Load()

	dsn := os.Getenv("SUPABASE_DIRECT_CONNECTION_STRING")
	if dsn == "" {
		log.Fatal("SUPABASE_DIRECT_CONNECTION_STRING is not set")
	}

	var err error
	db, err = pgxpool.New(context.Background(), dsn)
	if err != nil {
		log.Fatalf("pgxpool.New: %v", err)
	}
	defer db.Close()

	if err := db.Ping(context.Background()); err != nil {
		log.Fatalf("database ping failed: %v", err)
	}
	log.Println("connected to database")

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/api/v1/", withCORS(handleQuery))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

// withCORS wraps a handler with permissive CORS headers.
func withCORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h(w, r)
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	err := db.Ping(r.Context())
	if err != nil {
		jsonError(w, "database unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// handleQuery is the single handler for all /api/v1/{table} requests.
func handleQuery(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// /api/v1/          → list available tables
	// /api/v1/{table}   → query that table
	segment := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/"), "/")
	if segment == "" {
		listTables(w)
		return
	}

	table := segment
	if _, ok := allowedTables[table]; !ok {
		jsonError(w, fmt.Sprintf("unknown table %q", table), http.StatusNotFound)
		return
	}

	cols, err := tableColumns(r.Context(), table)
	if err != nil {
		log.Printf("tableColumns(%s): %v", table, err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	colSet := make(map[string]struct{}, len(cols))
	for _, c := range cols {
		colSet[c] = struct{}{}
	}

	q := r.URL.Query()

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
		if _, ok := colSet[ob]; ok {
			dir := "ASC"
			if strings.ToUpper(q.Get("order")) == "DESC" {
				dir = "DESC"
			}
			orderClause = fmt.Sprintf(" ORDER BY %s %s", ob, dir)
		}
	}

	// Build parameterised WHERE from remaining query params that match column names.
	var conds []string
	var args []any
	idx := 1
	for key, vals := range q {
		switch key {
		case "limit", "offset", "order_by", "order":
			continue
		}
		if _, ok := colSet[key]; !ok {
			continue
		}
		conds = append(conds, fmt.Sprintf("%s = $%d", key, idx))
		args = append(args, vals[0])
		idx++
	}

	query := "SELECT * FROM " + table
	if len(conds) > 0 {
		query += " WHERE " + strings.Join(conds, " AND ")
	}
	query += orderClause
	query += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)

	rows, err := db.Query(r.Context(), query, args...)
	if err != nil {
		log.Printf("query error: %v", err)
		jsonError(w, "query failed", http.StatusInternalServerError)
		return
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
			log.Printf("row.Values: %v", err)
			continue
		}
		row := make(map[string]any, len(colNames))
		for i, name := range colNames {
			row[name] = vals[i]
		}
		result = append(result, row)
	}
	if rows.Err() != nil {
		log.Printf("rows.Err: %v", rows.Err())
		jsonError(w, "query failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"table":  table,
		"count":  len(result),
		"limit":  limit,
		"offset": offset,
		"data":   result,
	})
}

func listTables(w http.ResponseWriter) {
	tables := make([]string, 0, len(allowedTables))
	for t := range allowedTables {
		tables = append(tables, t)
	}
	sort.Strings(tables)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"tables": tables})
}

// tableColumns returns the ordered column names for a table, caching the result.
func tableColumns(ctx context.Context, table string) ([]string, error) {
	if v, ok := columnCache.Load(table); ok {
		return v.([]string), nil
	}
	rows, err := db.Query(ctx,
		`SELECT column_name
		 FROM information_schema.columns
		 WHERE table_schema = 'public' AND table_name = $1
		 ORDER BY ordinal_position`,
		table,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cols []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		cols = append(cols, c)
	}
	columnCache.Store(table, cols)
	return cols, nil
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
