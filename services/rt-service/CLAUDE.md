## Files

| File | What it does |
|---|---|
| `main.go` | Entry point: loads `.env`, creates DB pool, runs `setupSchema`, conditionally runs SODA2 scrape (`--force-reload` flag skips the loaded check), starts WS server, runs 30s polling loop |
| `config.go` | All URLs (Calgary SODA2 + GTFS-RT) and constants (`realtimeInterval`, `wsPort`) |
| `db.go` | `newPool`, `waitForDB`, `setupSchema` (drops and recreates realtime tables on every start; static tables use `CREATE IF NOT EXISTS`), `isSoda2Loaded` |
| `soda2.go` | Paginated SODA2 fetch, GeoJSON→WKT conversion, batch upserts for stops / routes / train stations |
| `realtime.go` | GTFS-RT fetch with gzip/zlib fallback; batch upserts for `trip_updates`, `stop_time_updates` (with delay calculation), `vehicle_positions`, `alerts` |
| `geo.go` | Haversine distance, bearing, speed, WKT point parser, closest-point-on-segment time interpolation |
| `websocket.go` | gorilla/websocket hub, `broadcast` with 1-byte feed-tag prefix (`0x01`=vehicles, `0x02`=trips, `0x03`=alerts) |
| `enums.go` | GTFS-RT enum→string maps, `enumStr` helper, `nullStr` helper |

## Database tables

**Static (persist across restarts — `CREATE IF NOT EXISTS`)**

| Table | Key columns | Notes |
|---|---|---|
| `calgary_transit_stops` | `globalid` PK, `teleride_number`, `point` WKT | `teleride_number` = stop ID; maps to `stop_time_updates.stop_id` |
| `calgary_transit_routes` | `globalid` PK, `route_short_name`, `multilinestring` WKT | Route geometry for map rendering |
| `calgary_train_stations` | `station_name` PK, directional distances, `point` WKT | CTrain stations |
| `stop_analytics` | `(stop_id, route_id)` PK | Incremental-mean delay/dwell history; survives restarts for long-run stats |

**Realtime (dropped and recreated on every startup)**

| Table | Key columns | Notes |
|---|---|---|
| `trip_updates` | `trip_id` PK, `route_id`, `timestamp` | One row per active trip; `timestamp` = feed header timestamp |
| `stop_time_updates` | `(trip_id, stop_sequence)` PK | See delay columns below |
| `vehicle_positions` | `vehicle_id` PK | `bearing` and `speed` are computed locally from consecutive positions; `route_id` is imputed from `trip_updates` when absent from the feed |
| `alerts` | `alert_id` PK | Service alerts from GTFS-RT alerts feed; `informed_route_id` / `informed_stop_id` hold every distinct informed entity, comma-joined |
| `trip_stop_delays` | `(trip_id, stop_sequence)` PK | Reserved for geospatial state machine (not yet populated) |

### Delay columns in `stop_time_updates`

| Column | How it's set |
|---|---|
| `scheduled_arrival_time` | First-ever `arrival.time` received from the feed for this `(trip_id, stop_sequence)`. Frozen on insert; never overwritten. Values ≤ 0 are treated as NULL (Calgary sends `-1` for past/unknown stops). |
| `scheduled_departure_time` | Same, for departure. |
| `arrival_time` | Current predicted arrival from the feed; updated every poll. |
| `departure_time` | Current predicted departure from the feed; updated every poll. |
| `arrival_delay` | `arrival_time − scheduled_arrival_time` in seconds. Positive = late, negative = early. NULL until a valid scheduled time is locked. |
| `departure_delay` | Same, for departure. |

The feed self-corrects predicted times as the bus approaches, so using `arrival_time` alone always converges to delay ≈ 0. Locking `scheduled_arrival_time` on first sight preserves the original prediction as the baseline.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `SUPABASE_DIRECT_CONNECTION_STRING` | Yes | Full Postgres DSN; used for both local and Supabase |
| `APP_TOKEN` | No | Calgary Open Data app token; improves rate limits (header omitted when unset — Socrata serves unauthenticated at lower limits) |
| `RT_VEHICLES_URL` / `RT_TRIPS_URL` / `RT_ALERTS_URL` | No | Override the GTFS-RT feed URLs (e.g. a local replay server); defaults in `config.go` |
| `GTFS_STATIC_URL` | No | Override the static GTFS zip URL |
| `STOPS_URL` / `ROUTES_URL` / `TRAIN_STATIONS_URL` | No | Override the Socrata SODA2 dataset URLs |
| `PORT` | No | Overrides `wsPort` (8765); injected by Cloud Run |

## Running locally

```bash
docker run -d --name tranzit-pg -e POSTGRES_PASSWORD=password -p 5432:5432 postgres:16
SUPABASE_DIRECT_CONNECTION_STRING="postgres://postgres:password@localhost:5432/postgres?sslmode=disable" \
APP_TOKEN="<your token>" \
go run .
```

Add `--force-reload` to re-fetch SODA2 static data even if already loaded.
