package main

// feeds.go serves three read-only, shaped endpoints (no user ids in any output):
//
//   GET /api/v1/alerts?route_id=&stop_id=          → currently-active GTFS-RT service
//       alerts (Supabase/GTFS pool, table written by rt-service). Replaces the generic
//       /api/v1/alerts table read with an app-friendly shape.
//   GET /api/v1/reports/summary?route_id=&minutes= → community report counts by kind
//   GET /api/v1/reports/recent?route_id=&limit=    → newest community reports
//
// Reports live in the user DB (route_reports, written by the app through the generic
// POST /api/v1/user/route_reports, owner-stamped by ownership.go).

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// serviceAlert is one entry of GET /api/v1/alerts.
type serviceAlert struct {
	AlertID     string   `json:"alert_id"`
	Header      string   `json:"header"`
	Description string   `json:"description"`
	Cause       *string  `json:"cause"`
	Effect      *string  `json:"effect"`
	Severity    *string  `json:"severity"`
	URL         *string  `json:"url"`
	RouteIDs    []string `json:"route_ids"`
	StopIDs     []string `json:"stop_ids"`
	ActiveStart *int64   `json:"active_start"`
	ActiveEnd   *int64   `json:"active_end"`
}

// splitIDs turns rt-service's comma-joined informed_* column into a list.
func splitIDs(s *string) []string {
	out := []string{}
	if s == nil {
		return out
	}
	for _, p := range strings.Split(*s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// zeroToNil maps rt-service's 0 ("unbounded" in GTFS-RT) to null.
func zeroToNil(v *int64) *int64 {
	if v == nil || *v == 0 {
		return nil
	}
	return v
}

func handleAlerts(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if _, ok := allowedTables["alerts"]; !ok {
		jsonError(w, `unknown table "alerts"`, http.StatusNotFound)
		return
	}
	q := r.URL.Query()
	routeID := strings.TrimSpace(q.Get("route_id"))
	stopID := strings.TrimSpace(q.Get("stop_id"))

	ctx, cancel := context.WithTimeout(r.Context(), dbQueryTimeout)
	defer cancel()
	rows, err := db.Query(ctx, `
		SELECT alert_id, header_text, description_text, cause, effect, severity_level, url,
		       informed_route_id, informed_stop_id, active_period_start, active_period_end
		FROM alerts
		WHERE (active_period_start IS NULL OR active_period_start <= $1)
		  AND (active_period_end IS NULL OR active_period_end = 0 OR active_period_end >= $1)
		  AND ($2::text = '' OR $2::text = ANY(string_to_array(COALESCE(informed_route_id, ''), ',')))
		  AND ($3::text = '' OR $3::text = ANY(string_to_array(COALESCE(informed_stop_id, ''), ',')))
		ORDER BY active_period_start DESC NULLS LAST, alert_id`,
		time.Now().Unix(), routeID, stopID,
	)
	if err != nil {
		log.Printf("handleAlerts: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	out := make([]serviceAlert, 0)
	for rows.Next() {
		var a serviceAlert
		var header, desc, routes, stops *string
		var start, end *int64
		if err := rows.Scan(&a.AlertID, &header, &desc, &a.Cause, &a.Effect, &a.Severity, &a.URL,
			&routes, &stops, &start, &end); err != nil {
			log.Printf("handleAlerts scan: %v", err)
			jsonError(w, "internal server error", http.StatusInternalServerError)
			return
		}
		rawHeader, rawDesc := "", ""
		if header != nil {
			rawHeader = *header
		}
		if desc != nil {
			rawDesc = *desc
		}
		a.RouteIDs = splitIDs(routes)
		a.Effect = alertEffect(a.Effect, rawDesc)
		a.Header = alertHeader(rawHeader, a.Effect, a.RouteIDs)
		a.Description = alertPlainText(rawDesc)
		a.StopIDs = splitIDs(stops)
		a.ActiveStart = zeroToNil(start)
		a.ActiveEnd = zeroToNil(end)
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		log.Printf("handleAlerts rows: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// ── community reports ──────────────────────────────────────────────────────────

// clampInt parses v as an int in [1, max], falling back to def.
func clampInt(v string, def, max int) int {
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// reportsReady guards the report endpoints: user DB configured + table whitelisted.
func reportsReady(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet {
		jsonError(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if userDB == nil {
		jsonError(w, "user database not configured", http.StatusServiceUnavailable)
		return false
	}
	if _, ok := userTables["route_reports"]; !ok {
		jsonError(w, `unknown table "route_reports"`, http.StatusNotFound)
		return false
	}
	return true
}

func handleReportsSummary(w http.ResponseWriter, r *http.Request) {
	if !reportsReady(w, r) {
		return
	}
	q := r.URL.Query()
	routeID := strings.TrimSpace(q.Get("route_id"))
	minutes := clampInt(q.Get("minutes"), 60, 1440)

	ctx, cancel := context.WithTimeout(r.Context(), dbQueryTimeout)
	defer cancel()
	rows, err := userDB.Query(ctx, `
		SELECT kind, count(*)
		FROM route_reports
		WHERE created_at >= now() - make_interval(mins => $1::int)
		  AND ($2::text = '' OR route_id = $2::text)
		GROUP BY kind`,
		minutes, routeID,
	)
	if err != nil {
		log.Printf("handleReportsSummary: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	byKind := map[string]int64{}
	var total int64
	for rows.Next() {
		var kind string
		var n int64
		if err := rows.Scan(&kind, &n); err != nil {
			log.Printf("handleReportsSummary scan: %v", err)
			jsonError(w, "internal server error", http.StatusInternalServerError)
			return
		}
		byKind[kind] = n
		total += n
	}
	if err := rows.Err(); err != nil {
		log.Printf("handleReportsSummary rows: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}

	var route any // null when unfiltered
	if routeID != "" {
		route = routeID
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"route_id": route,
		"minutes":  minutes,
		"total":    total,
		"by_kind":  byKind,
	})
}

// recentReport is one entry of GET /api/v1/reports/recent — deliberately no user_id.
type recentReport struct {
	ReportID  string    `json:"report_id"`
	Kind      string    `json:"kind"`
	Severity  int16     `json:"severity"`
	RouteID   *string   `json:"route_id"`
	TripID    *string   `json:"trip_id"`
	StopID    *string   `json:"stop_id"`
	CreatedAt time.Time `json:"created_at"`
}

func handleReportsRecent(w http.ResponseWriter, r *http.Request) {
	if !reportsReady(w, r) {
		return
	}
	q := r.URL.Query()
	routeID := strings.TrimSpace(q.Get("route_id"))
	limit := clampInt(q.Get("limit"), 20, 100)

	ctx, cancel := context.WithTimeout(r.Context(), dbQueryTimeout)
	defer cancel()
	rows, err := userDB.Query(ctx, `
		SELECT report_id, kind, severity, route_id, trip_id, stop_id, created_at
		FROM route_reports
		WHERE ($1::text = '' OR route_id = $1::text)
		ORDER BY created_at DESC
		LIMIT $2`,
		routeID, limit,
	)
	if err != nil {
		log.Printf("handleReportsRecent: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	out := make([]recentReport, 0)
	for rows.Next() {
		var rr recentReport
		if err := rows.Scan(&rr.ReportID, &rr.Kind, &rr.Severity, &rr.RouteID, &rr.TripID, &rr.StopID, &rr.CreatedAt); err != nil {
			log.Printf("handleReportsRecent scan: %v", err)
			jsonError(w, "internal server error", http.StatusInternalServerError)
			return
		}
		out = append(out, rr)
	}
	if err := rows.Err(); err != nil {
		log.Printf("handleReportsRecent rows: %v", err)
		jsonError(w, "internal server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}
