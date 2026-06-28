---
API

┌────────┬────────────────────────┬──────────────────────────────────────────────────────┐
│ Method │          Path          │                     Description                      │
├────────┼────────────────────────┼──────────────────────────────────────────────────────┤
│ GET    │ /health                │ DB ping — returns {"status":"ok"} or 503             │
├────────┼────────────────────────┼──────────────────────────────────────────────────────┤
│ GET    │ /api/v1/               │ List all queryable tables                            │
├────────┼────────────────────────┼──────────────────────────────────────────────────────┤
│ GET    │ /api/v1/{table}        │ Query any whitelisted table                          │
├────────┼────────────────────────┼──────────────────────────────────────────────────────┤
│ GET    │ /api/v1/stream/route   │ SSE — live stop predictions for a route+time query   │
└────────┴────────────────────────┴──────────────────────────────────────────────────────┘

Allowed tables: calgary_transit_stops, calgary_transit_routes, calgary_train_stations, trip_updates, stop_time_updates, vehicle_positions, alerts, trip_stop_delays,
stop_analytics

Query parameters:

┌──────────┬───────────────────────────────────────────┐
│  Param   │                  Effect                   │
├─────────────────────┼────────────────────────────────────────────────────┤
│ limit               │ Row cap (default 100, max 10 000)                  │
├─────────────────────┼────────────────────────────────────────────────────┤
│ offset              │ Pagination offset                                  │
├─────────────────────┼────────────────────────────────────────────────────┤
│ order_by            │ Column to sort by (must be a real column)          │
├─────────────────────┼────────────────────────────────────────────────────┤
│ order               │ ASC (default) or DESC                              │
├─────────────────────┼────────────────────────────────────────────────────┤
│ {column_name}=value │ Exact-match WHERE filter — any column in the table │
└─────────────────────┴────────────────────────────────────────────────────┘

Example:
GET /api/v1/vehicle_positions?route_id=3&order_by=timestamp&order=DESC&limit=50
GET /api/v1/calgary_transit_stops?status=ACTIVE&limit=200
GET /api/v1/alerts

Response shape:
{ "table": "vehicle_positions", "count": 50, "limit": 50, "offset": 0, "data": [...] }

SSE — /api/v1/stream/route

Query parameters: route_id (required), time (required, unix epoch integer)

Resolves the trip on route_id whose predicted stop arrival times are nearest to time,
then streams live predictions for all stops on that trip.

┌──────────┬───────────────────────────────────────────────────────────────┐
│  Event   │  Payload                                                      │
├──────────┼───────────────────────────────────────────────────────────────┤
│ snapshot │ { "trip_id", "route_id", "count", "data": [stop…] }          │
│ update   │ { "trip_id", "route_id", "added", "updated", "removed" }     │
│ : ping   │ heartbeat comment — no change since last poll                 │
└──────────┴───────────────────────────────────────────────────────────────┘

Each stop row: { route_id, trip_id, stop_id, stop_lat, stop_lng, arrival_time, departure_time, arrival_delay, departure_delay }

The trip is locked on connect; polls every 30 s and pushes diffs as arrival/departure
times change. Returns 400 if params missing, 404 if no matching trip exists.

Example:
GET /api/v1/stream/route?route_id=3&time=1748000000

GET /api/v1/resolve_trip — resolve one bus leg to its current trip + windowed stops

Params: route_id, entry_stop_id, exit_stop_id, time (target epoch) required;
now (default server clock) and grace (default 120s) bound the future-only floor.
Picks the trip serving entry before exit (entry_seq < exit_seq) whose entry boarding
time is >= now-grace and nearest time; returns the entry→exit windowed stops:
{ route_id, trip_id, entry_seq, exit_seq, count, data:[{stop_id, stop_name, stop_lat,
stop_lng, stop_sequence, arrival_time, departure_time}…] }. 400 missing params,
404 no current in-order trip. Selecting in SQL drops stale cross-day rows that a
client-side scan would otherwise pick (route-save's "prefers past" bug).

Generic query extra (stop_time_updates only): active=1 keeps rows whose boarding time
(COALESCE(departure_time,arrival_time)) >= now()-grace — a server-now future-only
filter so callers need not trust their own (possibly skewed) clock. grace=N (default 120).

Security notes

- Table name validated against a hard-coded whitelist (no SQL injection via table)
- Filter keys validated against information_schema.columns (no SQL injection via column)
- Filter values always passed as $N parameters (no SQL injection via value)
- Column list cached after first use per table

Auth — see AUTH.md (full reference)

- Two listeners: end users hit the Funnel port with a Supabase JWT (Bearer/?token);
  sibling services hit a separate tailnet-only mTLS port (client cert + CN allow-list).
- /api/v1/user/* enforces per-user ownership (token sub == user_id) on the user-owned
  tables; service (mTLS) callers bypass. /health is always open.
- Rollout is soft (AUTH_ENFORCE=false) → log + allow; flip to true for hard 401/403 +
  RequireAndVerifyClientCert. Certs: scripts/gen-mtls-certs.sh.
