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

Plus, on stop_time_updates only:
  active=1   Server-now future-only filter: keeps rows whose boarding time
             (COALESCE(departure_time, arrival_time)) is >= now()-grace. Lets a
             caller drop already-departed rows without trusting its own clock.
  grace=N    Seconds of slack for active= (default 120).

Example:
GET /api/v1/vehicle_positions?route_id=3&order_by=timestamp&order=DESC&limit=50
GET /api/v1/calgary_transit_stops?status=ACTIVE&limit=200
GET /api/v1/stop_time_updates?stop_id=6866&active=1&order_by=departure_time
GET /api/v1/alerts

Response shape:
{ "table": "vehicle_positions", "count": 50, "limit": 50, "offset": 0, "data": [...] }

GET /api/v1/resolve_trip

Resolves the single current trip a rider boards for one bus leg and returns its
entry→exit windowed stops. Used by route-save instead of pulling every candidate
trip for the route and filtering client-side.

Query parameters:
  route_id       (required) GTFS route id (bus number)
  entry_stop_id  (required) teleride_number of the boarding stop
  exit_stop_id   (required) teleride_number of the alighting stop
  time           (required, unix epoch) target boarding time (Google's ETA), the
                 nearest-run tie-break
  now            (optional, unix epoch; default server clock) future-only reference
  grace          (optional, seconds; default 120) boarding may be >= now-grace

Picks the trip on route_id serving entry_stop_id before exit_stop_id (entry_seq <
exit_seq), whose entry boarding time is at/after now-grace (not yet departed) and
nearest to time. Stale cross-day rows for a reused trip_id are dropped by the floor.

Response: { "route_id", "trip_id", "entry_seq", "exit_seq", "count",
            "data": [ { stop_id, stop_name, stop_lat, stop_lng, stop_sequence,
                        arrival_time, departure_time } … ] }

400 if a required param is missing; 404 if no current in-order trip serves the stops.

Example:
GET /api/v1/resolve_trip?route_id=22&entry_stop_id=6866&exit_stop_id=8961&time=1780275000

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

Each stop row: { route_id, trip_id, stop_id, stop_lat, stop_lng, arrival_time, departure_time }

The trip is locked on connect; polls every 30 s and pushes diffs as arrival/departure
times change. Returns 400 if params missing, 404 if no matching trip exists.

Example:
GET /api/v1/stream/route?route_id=3&time=1748000000

Security notes

- Table name validated against a hard-coded whitelist (no SQL injection via table)
- Filter keys validated against information_schema.columns (no SQL injection via column)
- Filter values always passed as $N parameters (no SQL injection via value)
- Column list cached after first use per table

Fill in SUPABASE_DIRECT_CONNECTION_STRING in .env (the same DSN the scraper uses) and run with go run . or go build && ./tranzit-db-middleware.