# Route Save — Microservice Design Document

**Service:** Route Save
**Platform:** Go service (backend), React Native / Expo (client)
**Status:** Build spec + in-progress implementation. Build-order steps 1–4 (trip load, state machine, WS/RT wiring, reroute) are **built and tested**; persistence onward is pending. **See §18 for the as-built code, how to run it, and where implementation diverged from this spec.** Remaining work is tracked in `TODO.md`.

---

## 1. Overview & Scope

Route Save is the live trip-tracking service for Tranzit. Once a user starts a trip, Route Save tracks them through it in real time: it tracks per-stop status, detects missed buses and at-risk transfers, and triggers dynamic rerouting — all over a persistent WebSocket connection.

It is the **only** entry point for directions from the client's perspective. The client calls Map Service directly for geocoding, place details, and autocomplete, but all direction fetching and live trip state flows through Route Save.

**In scope (this document):** data model, data sourcing, timing model, the per-stop state machine, missed detection, reroute logic, persistence schemas, WebSocket/SSE protocols.

**Open / to finalize during testing:** reconnection & resume protocol details, background-tracking strategy, horizontal scaling, optional velocity-based boarding confirmation. See §16.

---

## 2. Architecture & Integration

| Direction | Protocol | Counterpart | Payload |
|-----------|----------|-------------|---------|
| Input | SSE | DB Middleware | GTFS-RT predicted arrivals (per stop/trip), refreshed every 30s |
| Input / Output | WebSocket | Client | GPS location up (5s); full trip data structure exported read-only for rendering, plus ETA / reroute / notifications down |
| Input | REST response | Map Service | Directions (initial fetch + reroutes only) |
| Read / Write | PostgreSQL | Personal DB (Supabase) | Trip sessions, stops, state snapshots |
| Write | WebSocket sync | Client SQLite | Local cache mirror of trip state |

**Hard constraints (platform invariants):**

- WKT geometries are **longitude-latitude** order, not lat-lng.
- Place IDs from Map Service are **session-scoped** — never persist to SQLite or Postgres.
- `EXPO_PUBLIC_USE_LOCAL` affects only `TranzitApiService` on the client; it does **not** redirect SSE or WebSocket traffic.
- Supabase session tokens on the client must respect the 2 KB `expo-secure-store` iOS limit.

---

## 3. Terminology

| Term | Meaning |
|------|---------|
| Entry stop | Where the user boards a bus on a leg |
| Exit stop | Where the user alights on a leg |
| FETCHED stop | A stop where the user is expected to board (gates the MISSED check) |
| TRANSFER stop | A handoff point between two legs |
| Active stop | The stop the state machine is currently evaluating |
| Leg | One continuous mode segment (walk, or a single bus ride) |
| TimeRemaining | `BusArrivalTime − current_time` for the active stop |
| Moving goalpost | RT refresh (30s) recomputes `BusArrivalTime`, sliding the trigger moment |

---

## 4. Data Model

### 4.1 Per-Stop Record (Table 1)

This is the canonical row evaluated by the state machine.

```
StopRecord {
  stop_id:           string   // stop_id / teleride_number
  stop_name:         string   // human-readable stop name; from Google, static
  stop_lat:          float    // static
  stop_lng:          float    // static
  route_id:          string   // BusNumber, static
  trip_id:           string   // resolved trip (see §5.2)
  stop_type:         enum     // FETCHED | TRANSFER
  bus_arrival_time:  int64    // epoch; GTFS-RT, refreshed 30s
  user_arrival_time: int64    // epoch; Google static, fallback only (§5.3)
  user_distance_m:   float    // haversine(user, stop); refreshed 5s
  time_remaining_s:  int      // bus_arrival_time − now; refreshed 1s
  status:            enum     // COMPLETED | ACTIVE | EXPECTED | UNSURE | MISSED
}
```

### 4.2 Trip State (per session, server-held + persisted)

```
TripState {
  session_id:         uuid
  user_id:            string?            // nullable until auth wired (Clerk pending)
  origin:             {lat, lng}
  destination:        {lat, lng}
  legs:               Leg[]              // §11
  stops:              StopRecord[]       // filtered entry→exit, ordered
  current_stop_index: int
  overall_status:     enum
  user_location:      {lat, lng, speed_mps, heading_deg, ts}
  last_rt_update:     int64
  last_reroute:       int64
  state_version:      int                // monotonic; for resume reconciliation
  created_at, updated_at: timestamp
}
```

### 4.3 Status Enum

| Status | Meaning |
|--------|---------|
| EXPECTED | Future stop; not yet evaluated (TimeRemaining above trigger) |
| ACTIVE | User is on the bus / has boarded at this stop |
| COMPLETED | User has passed/alighted at this stop |
| UNSURE | At trigger, user is in the ambiguous band (boarding < d ≤ missed radius) |
| MISSED | At trigger, user is beyond the missed radius |

---

## 5. Data Sources & Loading

### 5.1 Sources

**From Google Directions (initial fetch):**
- Entry stop: lat, lng, **stop name**
- BusNumber → `route_id`
- UserArrivalTime (static; fallback)
- Exit stop info

**From our SSE / DB:**
- Stop info → `stop_id`
- `stop_id` + `route_id` + time → `trip_id` (§5.2)
- `trip_id` → all stops on the trip + ETA (`bus_arrival_time`)
- Filter: load only the stops **between entry and exit** stop

**From client:**
- User location (lat, lng), refreshed every 5s

### 5.2 Trip Resolution

`route_id` → `trip_id` is **not** 1:1 — a route has many trips per service day and direction. Resolve by time-matching against Google's provided arrival time.

```
resolve_trip(entry_stop_id, route_id, google_eta_epoch):
  candidates = trips WHERE route_id matches
                     AND serves entry_stop_id
                     AND active on today's service calendar
  best = argmin over candidates of
           abs(candidate.departure_at(entry_stop_id) − google_eta_epoch)
  return best.trip_id
```

> **Known edge case — high-frequency routes.** On routes with short headways (~5 min), if the Google time is off by more than the headway you can match the adjacent trip ("right route, wrong run"). Acceptable for v1; revisit if it surfaces in testing.

### 5.3 UserArrivalTime

Static, sourced from Google, used as a **last-ditch fallback only**. The live `time_remaining_s` is driven by `bus_arrival_time` (RT) minus current time. `user_arrival_time` is consulted only when live derivation is unavailable.

### 5.4 FETCHED vs TRANSFER Classification

Every loaded stop is flagged:
- **FETCHED** — a stop where the user is expected to board. The MISSED check (§8) applies here.
- **TRANSFER** — a leg handoff. Being 50m away while on the bus approaching a transfer is normal and must **not** be read as missed.

---

## 6. Timing Model

### 6.1 TimeRemaining

```
time_remaining_s = bus_arrival_time − server_now()
```

### 6.2 Clock Authority

`server_now()` is the **Route Save server clock**, in the same epoch as the GTFS-RT feed. Never use the client clock for TimeRemaining — client drift would corrupt the trigger.

### 6.3 Update Cadences

| Quantity | Cadence | Source |
|----------|---------|--------|
| user_location, user_distance_m | 5s | Client WebSocket |
| bus_arrival_time | 30s | GTFS-RT via DB Middleware SSE |
| time_remaining_s + evaluation | 1s | Server tick |

### 6.4 Moving Goalpost

`bus_arrival_time` is refreshed every 30s from RT. If the bus is delayed, the next RT update pushes the arrival later, `time_remaining_s` grows again, and the trigger moment slides out. This is what prevents a delayed bus from producing a false MISSED — the trigger only ever arms at the *current* predicted arrival.

---

## 7. State Machine

### 7.1 Evaluation Loop

```
on RT_UPDATE (30s):
  for stop in trip.stops:
    stop.bus_arrival_time = rt.predicted_arrival(stop.trip_id, stop.stop_id)
  // time_remaining recomputed on next tick

on LOCATION_UPDATE (5s):
  trip.user_location = msg
  active = trip.stops[current_stop_index]
  active.user_distance_m = haversine(user_location, {active.stop_lat, active.stop_lng})

on TICK (1s):
  active = trip.stops[current_stop_index]
  active.time_remaining_s = active.bus_arrival_time − server_now()
  evaluate(active)
  push_state_if_changed()
```

### 7.2 Distance Tiers (evaluated at trigger)

| Distance from active stop | Result |
|---------------------------|--------|
| `d > MISSED_RADIUS_M` (50m) | MISSED |
| `BOARDING_RADIUS_M < d ≤ 50m` | UNSURE |
| `d ≤ BOARDING_RADIUS_M` | ACTIVE (boarded) |

### 7.3 evaluate(stop)

```
evaluate(stop):
  if stop.stop_type == TRANSFER and user is ON_BUS:
    // approaching a transfer while riding is normal; do not run MISSED check here
    advance_when_appropriate()
    return

  if stop.time_remaining_s > MISSED_EVAL_THRESHOLD_S:   // not yet armed
    stop.status = EXPECTED
    return

  // ARMED: time_remaining ≤ ~1s — make the call using latest sampled distance
  d = stop.user_distance_m
  if d > MISSED_RADIUS_M:
    stop.status = MISSED
    handle_missed(stop)                 // §9
  else if d > BOARDING_RADIUS_M:
    stop.status = UNSURE
    handle_unsure(stop)                 // §10
  else:
    stop.status = ACTIVE
    advance_current_stop()
```

### 7.4 Advancing

When the active stop resolves to ACTIVE/COMPLETED, set `current_stop_index += 1`; the next stop becomes active (EXPECTED until its own trigger). Prior stops are marked COMPLETED.

> **Non-boarding edge (user at stop, ≤50m, doesn't board).** Not caught at this stop by design (MISSED needs >50m). It self-heals at the **next** stop: the user's location never tracks toward it, that stop's TimeRemaining hits trigger with the user >50m → MISSED → reroute from current location. Detection lags by one stop; accepted for v1.

### 7.5 Example Output (simplified)

```
stop  bus  status
1     3    Completed
11    3    Active
111   3    Expected
21    17   Expected
```

---

## 8. Missed Detection — Precise Rule

MISSED is determined **only** by time and distance. There is no other condition.

```
MISSED  ⟺  (time_remaining_s ≤ MISSED_EVAL_THRESHOLD_S)  AND  (user_distance_m > MISSED_RADIUS_M)
```

- The check is **armed only** when `time_remaining_s` reaches the threshold (~1s). Before that, the stop is EXPECTED regardless of distance.
- The 30s RT refresh slides the trigger out for delayed buses (§6.4), so a delayed bus does not false-trigger.
- Applies to **FETCHED** stops. TRANSFER stops being approached while riding are exempt (§7.3).

---

## 9. Reroute Logic

Triggered on MISSED. Two cases, distinguished by whether the user is currently on a bus.

### 9.1 Case 1 — User is ON the bus

(Previous stop COMPLETED/ACTIVE; user moving with a bus. The MISSED is an upcoming **transfer** that will now be missed.)

1. Assume the user will reach the next stop on the current bus.
2. Re-fetch directions from the **next stop → destination**.
3. Send notification: *transfer will be missed*.
4. **Re-arm:** redo the directions when the user is within `REROUTE_REARM_RADIUS_M` (50m) of that stop (so the new ETA reflects actual arrival).
5. **Preserve current bus state** — do not discard the completed/active legs.

### 9.2 Case 2 — User is NOT on a bus

(Arrived at stop = COMPLETED; next is active but far / walking.)

1. Re-fetch directions from the **user's current location → destination**.
2. Re-enter the state machine from the top with the new trip.

### 9.3 Splicing (preserve state)

A reroute never rebuilds the whole trip. The completed/active portion is retained; only the remaining legs are recomputed and spliced on:

```
keep   = trip.stops[0 .. current_stop_index]   // COMPLETED + current ACTIVE
new    = load_pipeline(reroute_origin, destination)  // §5, full load+filter
trip.stops = keep ++ new
trip.state_version += 1
persist(trip); push REROUTE message to client
```

`reroute_origin` = next stop (Case 1) or user current location (Case 2).

---

## 10. Unsure Handling & Notifications

At trigger, `BOARDING_RADIUS_M < d ≤ 50m` → UNSURE.

- UNSURE is a **holding state**. It does **not** reroute on its own.
- A reroute from UNSURE fires **only if** a large deviation occurs **and** the user's velocity is carrying them **away** from the stop. A user lingering near the stop (not receding) stays UNSURE pending resolution.
- A notification hook may ask the user to confirm boarding. The response (`UNSURE_RESPONSE`) resolves the state to ACTIVE or MISSED.

> *Open:* a hard timeout backstop for an UNSURE state that neither resolves nor recedes (e.g., GPS parked at 30m). To finalize in testing.

---

## 11. Legs & Transfers (Multi-Leg)

A full trip is a chain of legs: `walk → bus → (transfer) → bus → walk`. Each `Leg` carries its own ordered `StopRecord[]` with entry and exit stops.

- A leg's exit stop that is also the next leg's context is flagged **TRANSFER**.
- The per-stop logic (§7–§8) runs **per leg**.
- Missed-transfer detection is the Case 1 reroute (§9.1): the transfer stop is the FETCHED entry stop of the *next* leg; missing it triggers reroute from the next reachable stop.

```
Leg {
  leg_index:  int
  mode:       enum   // WALK | BUS
  route_id:   string?      // null for WALK
  trip_id:    string?      // resolved; null for WALK
  entry_stop: StopRecord?  // null for pure-walk legs
  exit_stop:  StopRecord?
  stops:      StopRecord[]
}
```

---

## 12. Persistence

### 12.1 PostgreSQL (Personal DB)

```sql
create table trip_sessions (
  id              uuid primary key,
  user_id         text,                       -- nullable until Clerk wired
  origin_lat      double precision not null,
  origin_lng      double precision not null,
  dest_lat        double precision not null,
  dest_lng        double precision not null,
  overall_status  text not null,
  state_version   int  not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table trip_stops (
  id                bigserial primary key,
  session_id        uuid references trip_sessions(id) on delete cascade,
  leg_index         int  not null,
  stop_index        int  not null,
  stop_id           text not null,
  stop_name         text,                      -- human-readable, from Google
  route_id          text,
  trip_id           text,
  stop_type         text not null,             -- FETCHED | TRANSFER
  stop_lat          double precision not null,
  stop_lng          double precision not null,
  bus_arrival_time  bigint,                    -- epoch
  user_arrival_time bigint,                    -- epoch, fallback
  status            text not null,
  unique (session_id, leg_index, stop_index)
);

-- Full serialized state for crash/disconnect recovery
create table trip_state_snapshots (
  session_id  uuid references trip_sessions(id) on delete cascade,
  version     int  not null,
  state       jsonb not null,
  created_at  timestamptz not null default now(),
  primary key (session_id, version)
);
```

Snapshot cadence: write a snapshot on every reroute and on every status transition of the active stop. Between transitions, in-memory state is authoritative.

### 12.2 SQLite (client cache, WAL)

Mirror of the active trip for offline render and resume. Minimal columns: `session_id`, `state_version`, `stops(stop_id, route_id, status, time_remaining_s, eta)`, `overall_status`. Last-write-wins keyed on `state_version`.

> Do not store Place IDs (session-scoped). Do not exceed the secure-store token budget on the client.

---

## 13. WebSocket Protocol

Connection is **per-trip**: opened on directions request, torn down on trip end or navigation away.

### 13.0 Read-Only Data Export

Beyond handling all trip logic, Route Save **exports the entire trip data structure read-only over the WebSocket** for dynamic rendering on the frontend. The client does not compute or mutate trip state — it renders whatever Route Save pushes. Each `STATE` message carries the full current view (every leg, every `StopRecord` field including `stop_name`, plus overall status), so the UI can redraw the whole trip from a single message.

- The export is authoritative and one-directional: server → client for rendering only.
- The client's sole inputs back to the server are `LOCATION`, `UNSURE_RESPONSE`, and `RESUME` (§13.1).
- `state_version` lets the client discard stale frames and detect missed updates.

### 13.1 Client → Server

```json
{ "type": "LOCATION", "lat": 51.0447, "lng": -114.0719, "speed_mps": 1.4, "heading_deg": 271, "ts": 1730000000 }
{ "type": "UNSURE_RESPONSE", "stop_id": "8123", "boarded": true }
{ "type": "RESUME", "session_id": "…", "state_version": 42, "lat": 51.04, "lng": -114.07 }
```

### 13.2 Server → Client

The `STATE` message is the full read-only export — the complete stop list with all renderable fields.

```json
{ "type": "STATE", "session_id": "…", "version": 43, "overall": "ACTIVE",
  "stops": [
    { "stop_id": "1",   "stop_name": "City Hall",        "route_id": "3",  "stop_type": "FETCHED",  "status": "COMPLETED", "time_remaining_s": -180, "eta": 1729999820, "lat": 51.045, "lng": -114.058 },
    { "stop_id": "11",  "stop_name": "7 Ave & 2 St SW",  "route_id": "3",  "stop_type": "FETCHED",  "status": "ACTIVE",    "time_remaining_s": 0,    "eta": 1730000000, "lat": 51.047, "lng": -114.071 },
    { "stop_id": "111", "stop_name": "Sunalta Station",  "route_id": "3",  "stop_type": "TRANSFER", "status": "EXPECTED",  "time_remaining_s": 240,  "eta": 1730000240, "lat": 51.044, "lng": -114.097 }
  ] }

{ "type": "REROUTE", "reason": "MISSED", "from": { "lat": 51.05, "lng": -114.08 }, "legs": [ /* spliced legs */ ] }

{ "type": "NOTIFY", "kind": "TRANSFER_AT_RISK", "stop_id": "21", "requires_response": false,
  "message": "Your transfer to route 17 will be missed. Rerouting." }
```

---

## 14. SSE Consumption (from DB Middleware)

Route Save subscribes to the full GTFS-RT feed. On each event it maps predicted arrivals onto the `bus_arrival_time` of matching `(trip_id, stop_id)` pairs across all active sessions.

```json
{ "trip_id": "…", "stop_id": "11", "predicted_arrival": 1730000000 }
```

RT enrichment is what makes the static Google directions responsive — it is the authoritative source for `bus_arrival_time` once the trip is underway.

---

## 15. Configuration Constants

| Constant | Default | Notes |
|----------|---------|-------|
| `LOCATION_UPDATE_INTERVAL_S` | 5 | Client GPS cadence |
| `RT_UPDATE_INTERVAL_S` | 30 | GTFS-RT refresh |
| `TICK_INTERVAL_S` | 1 | Server evaluation tick |
| `CLIENT_PUSH_INTERVAL_S` | 2 | Downstream STATE push cadence (on-change, throttled; as-built) |
| `LOCATION_STALE_AFTER_S` | 15 | `3×LOCATION_UPDATE_INTERVAL_S`; older fix counts as "no fix" (as-built) |
| `MISSED_EVAL_THRESHOLD_S` | 1 | TimeRemaining at which MISSED arms |
| `MISSED_RADIUS_M` | 50 | Beyond this at trigger → MISSED |
| `BOARDING_RADIUS_M` | 20 | Within this at trigger → ACTIVE (widened from 5m for GPS accuracy; tune in testing) |
| `REROUTE_REARM_RADIUS_M` | 50 | On-bus reroute re-fetch distance |

UNSURE band is implicitly `(BOARDING_RADIUS_M, MISSED_RADIUS_M]`.

---

## 16. Open Items (to finalize during testing)

1. **Reconnection & resume.** Transit means tunnels and backgrounded apps — the socket will drop mid-trip. Protocol sketch: client reconnects → sends `RESUME` (last `session_id`, `state_version`, current GPS) → server loads the latest snapshot, reconciles against live RT and current location, replays the state machine forward, returns a fresh `STATE`. Reconciliation rules to be nailed down.
2. **Background tracking.** OS kills background sockets. Decide between background location + push notifications vs. periodic wake for phone-in-pocket rides.
3. **Scaling.** One state machine per active session with 1s/5s/30s cadences. Prefer event-driven evaluation (on GPS/RT/tick events) over literal per-user timers. Define instance capacity and sharding.
4. **Optional hardening — velocity boarding confirmation.** Primary detection stays distance+time per spec. As a later enhancement, the at-stop non-boarding edge (§7.4) could be closed *at* the stop instead of one stop later by checking whether the user's velocity/heading tracks the departing bus vector. Deferred.
5. **UNSURE timeout backstop** (§10).
6. **Proposed — user-GPS augmentation of vehicle position.** Once a user is confirmed ACTIVE on a bus (high-confidence boarding), feed that user's GPS stream back in to *supplement* the bus's reported position. The vehicle's GTFS-RT position refreshes only every 30s; the boarded user's phone reports every 5s, so treating the passenger's location as a proxy for the vehicle between RT updates raises both the **refresh rate** and the **integrity** of that vehicle's live position. Design considerations to settle in testing:
   - **Gate on confidence.** Only augment when boarding is unambiguous (ACTIVE confirmed, ideally velocity/heading tracking the vehicle — ties into item 4). A misclassified non-passenger would otherwise pollute the vehicle position.
   - **Blend, don't replace.** Use the user GPS to interpolate/smooth between RT updates; snap back to the authoritative RT fix when it arrives. Discard user fixes that diverge sharply from the route polyline.
   - **Multi-passenger upside.** If several Tranzit users are confirmed on the same `trip_id`, their fixes can be fused for a sharper position — and that improved position can sharpen ETAs for *other* users waiting downstream on the same trip.
   - **Scope.** Augmentation is internal to Route Save's position model; it does not write back to the GTFS-RT feed or DB Middleware.

---

## 17. Build Order (suggested)

1. Trip load pipeline + trip resolution (§5) — pure, testable in isolation.
2. State machine + missed detection (§7–§8) against recorded GPS/RT fixtures.
3. WebSocket + SSE wiring (§13–§14).
4. Reroute splicing (§9).
5. Persistence + snapshots (§12).
6. Reconnection/resume (§16.1).
7. Background + scaling (§16.2–§16.3).

**Status:** 1–4 done. 5–7 + the §16 open items are pending (see `TODO.md`).

---

## 18. Implementation Status (as-built)

This section documents the actual Go service. It is the source of truth for *how
the code works today*; §1–§17 remain the design intent. Where the two differ, the
divergence is called out below.

**Module:** `github.com/tranzit-route-save` · **Go:** 1.26.3 · **Deps:**
`gorilla/websocket`, `joho/godotenv` (pgx to be added with persistence).

### 18.1 Package map

```
main.go                 Wiring: load env, build deps, start HTTP/WS server.
internal/config/        §15 constants + LoadEndpoints (PORT, MIDDLEWARE_URL, ROUTE_SERVICE_URL).
internal/geo/           HaversineM over LatLng (decimal degrees, lat,lng order).
internal/directions/    Parse Google Routes → WALK/BUS legs. Parse/Best ({routes:[…]} wrapper),
                        ParseSingle (single route object = the client start body).
internal/datasource/    DataSource iface: own trip resolution (§5.2) + entry→exit stop load (§5).
                        Fixture (tests) + HTTPSource (tranzit-db-middleware).
internal/trip/          §4 model (StopRecord, TripState, Leg, enums), BuildTrip, Splice (§9.3).
internal/state/         §7–§8 machine: OnRTUpdate/OnLocationUpdate/OnTick, missed rule,
                        ResolveUnsure (§10), MISSED/UNSURE Hooks, Clock (Fake for tests).
internal/wsproto/       §13 message structs + codec; StateMessage/RerouteMessage exporters.
internal/rtfeed/        RT arrival Source iface; Middleware (30s poll) + Fake.
internal/routeclient/   tranzit-route-service POST /route client iface + Fake.
internal/session/       Per-trip actor: Manager (registry), Session (event loop), reroute (§9).
internal/api/           HTTP/WS surface + StartRequest/Response.
```

### 18.2 Lifecycle (the client→server contract)

1. Client fetches directions from Map Service itself, picks one route, then
   **`POST /trips`** with body:
   ```json
   { "route": { /* single Google route object */ },
     "destination_place_id": "ChIJ…",        // required; in-memory only, never persisted
     "origin": {"lat":…,"lng":…},            // optional, record-keeping
     "user_id": "…" }                        // optional, until Clerk
   ```
   → `201 { "session_id": "…", "ws_url": "/trips/<id>/ws" }`. The server parses the
   route, resolves trips, loads stops, and **starts tracking immediately**.
2. Client opens **`GET /trips/{id}/ws`** (WebSocket). Server pushes the initial
   full `STATE`, then streams `STATE`/`REROUTE`/`NOTIFY`. Client sends `LOCATION`
   (~5s), `UNSURE_RESPONSE`, `RESUME`. **Live location arrives only over the WS**,
   not in the POST.
3. Service takes over: 1s tick drives the machine, 30s poll refreshes RT ETAs, and
   it reroutes itself via `/route` on MISSED.
4. **`DELETE /trips/{id}`** or simply closing the socket tears the trip down. Also
   `GET /health`.

### 18.3 Concurrency model

One **actor goroutine per session** owns *all* TripState mutation — there are no
locks on trip state. It `select`s over: the 1s tick, the 30s RT trigger, decoded
client frames, async reroute results, and WS attach. Around it: a WS reader
goroutine (frames → loop), a WS writer goroutine (drains the send queue), and
transient goroutines for the 30s RT fetch and the reroute `/route` call (network
work is kept *off* the loop; results are posted back and applied on it). WS attach
is routed through the loop so the first `STATE` export reads trip state on the loop
goroutine. Verified with `go test -race`.

### 18.4 Divergences from §1–§17 (intentional)

- **§14 RT consumption is polling, not SSE.** Middleware's only RT SSE
  (`/api/v1/stream/route`) is route+time scoped and re-runs its own trip
  resolution; since we do our *own* resolution (§5.2), we instead **poll
  `GET /api/v1/stop_time_updates?trip_id=` every 30s** for the trips we resolved.
  Same data, deterministic mapping. Behind the `rtfeed.Source` interface, so a true
  SSE impl can replace it later.
- **Direction-aware trip resolution.** A route runs both directions under one
  `route_id`, so matching only the entry stop + time can select a wrong-direction
  trip (symptom: `LoadLegStops` errors with "entry seq N is after exit seq M").
  `ResolveTrip` therefore requires a candidate to serve **both** entry and exit
  with `entry_seq < exit_seq`; only the correct-direction run qualifies.
- **§5.4 classification resolved.** Only the **boarding stop of each bus leg is
  FETCHED**; every other loaded stop (ride-through + exit/handoff) is **TRANSFER**
  (exempt from MISSED while ON_BUS). This matches §3's definition of FETCHED and
  keeps the MISSED gate clean. The §11 wording (a transfer stop *also* being the
  next leg's FETCHED entry) is the open ambiguity — revisit when multi-leg/transfer
  reroute is exercised live.
- **Leg = a run of Google `steps` by `travelMode`**, not Google's `legs` (Google
  returns one `legs[0]` interleaving WALK/TRANSIT steps).
- **MAX BRT route_id aliasing.** Google labels Calgary's MAX lines by letter code
  in `transitLine.nameShort` (`MG`, `MO`, `MY`, `MT`, `MP`), but the GTFS-RT feed
  (`trip_updates.route_id`) uses numeric ids. `directions.canonicalRouteID` maps
  `MG→301, MO→303, MY→304, MT→306, MP→307` at parse time so resolution and the
  STATE export use the accurate number; other routes pass through unchanged.
  Extend `maxLineAliases` in `internal/directions/parse.go` as more MAX lines
  surface (Google sometimes already returns the numeric id, e.g. `302`).
- **Stop names come from GTFS** (covers intermediate stops the STATE export needs),
  not Google (which only names entry/exit).
- **Reroute Case 1 (on-bus) re-arm** (`REROUTE_REARM_RADIUS_M`) is **not yet
  wired**; the realistic v1 path is Case 2 (off-bus, reroute from user location),
  which is implemented and tested. Case 1 branch exists but is rarely reached given
  the transfer-while-riding exemption.
- **Timer-driven escalation, GPS as confirming signal (as-built, P0).** The timer
  is the initiator (§8) and must not stall when GPS is silent (backgrounded app,
  tunnel, GPS not yet acquired). At trigger (armed) on a FETCHED boarding stop,
  `state.evaluate`: with **no fresh fix** (`UserLocation.RecvAt` server-stamped, older
  than `LOCATION_STALE_AFTER_S` or never set) → `UNSURE` and prompt the user, rather
  than declaring MISSED blind or holding `EXPECTED` forever (a zero `user_distance_m`
  never reads as "boarded"); with a **fresh fix** → the distance tiers (`≤20m` ACTIVE/
  board, `20–50m` UNSURE, `>50m` MISSED). `UNSURE` is **not** locked — each tick
  re-evaluates, so a later clear fix auto-resolves it (`≤20m`→ACTIVE, `>50m`→MISSED),
  and `UNSURE_RESPONSE{boarded}` resolves it explicitly (`ResolveUnsure`). There is no
  UNSURE timeout: the user's answer or a clear fix are the only resolvers. `OnUnsure`
  and `OnMissed` fire **once** on the transition into the state (`setUnsure`/`setMissed`
  guards) so the prompt isn't re-sent and the async reroute isn't double-queued each
  tick. `OnTick` recomputes the active stop's distance from the latest fresh fix every
  tick (not just on the 5s LOCATION frame), so the decision and reroute origin track the
  rider's live position. The `MISSED …` decision and the reroute origin are logged to
  `docker logs`.
- **Reroute origin falls back to the planned stop (as-built).** Case 2 (off-bus)
  reroutes from the rider's **fresh fix** when available, else from the **planned
  (missed) stop's lat-lng** (`Machine.FreshUserFix`) — the no-GPS MISSED is exactly when
  this matters, and a `0,0` origin would otherwise be sent to `/route`. Destination is
  always the session destination place ID.
- **REROUTE echoes the raw Google route (as-built).** `/route` returns Google's
  `{routes:[…]}`; `directions.BestWithRaw` keeps the chosen route's **raw JSON object**
  alongside the parsed `Route`, threaded through `routeclient.Client`→`rerouteResult`→
  `RerouteMessage` into `RerouteMsg.Route` (`json:"route,omitempty"`). The payload is the
  remaining journey (origin→destination), so the client re-renders from the same shape it
  originally fetched; the server keeps the COMPLETED prefix via `Splice`. STATE keeps the
  existing string statuses — no new flag field; the client maps `UNSURE`→prompt,
  `MISSED`→consume new directions.
- **Downstream STATE push is throttled (as-built, P0).** The 1s tick drives the
  machine but no longer pushes inline; a `CLIENT_PUSH_INTERVAL_S` (2s) ticker flushes a
  single coalesced, version-bumped STATE only when state changed. `REROUTE`/`NOTIFY`
  and the first attach STATE still go out immediately. Every STATE carries a fresh
  `time_remaining_s` for **all** stops (`StateMessage(ts, now)`), so the client counts
  down without a per-second frame.
- **Graceful shutdown (as-built, P0).** `main.go` runs an `http.Server` and traps
  SIGINT/SIGTERM via `signal.NotifyContext` → `Manager.CloseAll()` (closes every
  session) → `Shutdown(ctx)`.
- **`RESUME` is acknowledged but deferred** (§16.1): the server just re-sends the
  current `STATE`; no snapshot reconciliation yet.
- **`TripState` is in-memory only** — no Postgres/snapshots yet (§12).

### 18.5 Environment & sibling services

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `:8090` | Route Save listen address (bare port is `:`-prefixed) |
| `MIDDLEWARE_URL` | `https://tranzit-db-middleware-qsv32inqpq-uc.a.run.app` | tranzit-db-middleware (RT + GTFS data) — live Cloud Run; override for local |
| `ROUTE_SERVICE_URL` | `https://tranzit-route-service-qsv32inqpq-uc.a.run.app` | tranzit-route-service (`/route` directions) — live Cloud Run; override for local |
| `LOG_STATE` | `1` (on) | Tabular STATE logging to stdout (`docker logs`); set `0` to silence |
| `SUPABASE_DIRECT_CONNECTION_STRING` | — | reserved for persistence (§12), unused today |

Siblings: **tranzit-db-middleware** `:8080` (SSE + generic table queries, no auth),
**tranzit-route-service** `:3100` (Google Routes/Places proxy; `/route` takes
`{origin:{lat,lng}, destination_id:<placeId>}`), **tranzit-rt-service** `:8765`
(raw GTFS-RT protobuf WS; Route Save does not consume it directly).

### 18.6 Build, test, run

```bash
go build ./...
go vet ./...
gofmt -l .            # expect no output
go test -race ./...   # all packages green
go run .              # starts the server on $PORT (needs siblings for live data)
```

The HTTP/WS surface, state machine, and reroute splice are covered by unit and
`httptest`+websocket-dialer tests using **fakes**; the `HTTPSource`, `rtfeed.Middleware`,
and `routeclient.HTTPClient` adapters are wired but only fake-tested — they need a
live smoke test against `:8080`/`:3100` (see `TODO.md`).


