---
API

┌────────┬─────────────────┬──────────────────────────────────────────┐
│ Method │      Path       │               Description                │
├────────┼─────────────────┼──────────────────────────────────────────┤
│ GET    │ /health         │ DB ping — returns {"status":"ok"} or 503 │
├────────┼─────────────────┼──────────────────────────────────────────┤
│ GET    │ /api/v1/        │ List all queryable tables                │
├────────┼─────────────────┼──────────────────────────────────────────┤
│ GET    │ /api/v1/{table} │ Query any whitelisted table              │
└────────┴─────────────────┴──────────────────────────────────────────┘

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

Security notes

- Table name validated against a hard-coded whitelist (no SQL injection via table)
- Filter keys validated against information_schema.columns (no SQL injection via column)
- Filter values always passed as $N parameters (no SQL injection via value)
- Column list cached after first use per table
