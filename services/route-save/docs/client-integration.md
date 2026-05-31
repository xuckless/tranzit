# Route Save — Client Integration Guide

How a Tranzit client (React Native / Expo) wires into **Route Save** for live trip
tracking, and into **Map Service** (tranzit-route-service) for the directions it
hands off.

---

## 1. The big picture

```
        ┌────────────────────────── Tranzit Client (Expo) ──────────────────────────┐
        │                                                                            │
        │  1. autocomplete / details / search   ──► Map Service  (direct)            │
        │  2. fetch directions  POST /route     ──► Map Service  (direct)            │
        │  3. pick ONE route, POST /trips       ──► Route Save                       │
        │  4. open WebSocket  /trips/{id}/ws     ◄─► Route Save  (live STATE stream)  │
        │  5. stream LOCATION up, render STATE down, react to REROUTE / NOTIFY        │
        │  6. close socket (or DELETE) to end the trip                               │
        └────────────────────────────────────────────────────────────────────────────┘

Route Save talks to Map Service (reroutes) and DB Middleware (GTFS-RT) on the
server side — the client does NOT call those for trip logic.
```

**Division of responsibility**
- **Map Service** (direct from client): place autocomplete, place details,
  text/nearby search, and the **initial directions fetch** (`POST /route`).
- **Route Save**: everything live — it takes your chosen route, tracks the rider
  stop-by-stop, detects missed buses, reroutes itself, and streams the full trip
  state back for rendering. The client renders; it never computes trip state.

---

## 2. Base URLs

| Service | Base URL | Who calls it |
|---------|----------|--------------|
| **Map Service** (tranzit-route-service) | `https://tranzit-route-service-qsv32inqpq-uc.a.run.app` | Client (direct) |
| **DB Middleware** (tranzit-db-middleware) | `https://tranzit-db-middleware-qsv32inqpq-uc.a.run.app` | Route Save (server-side); client only for optional live vehicle positions |
| **Route Save** | *not yet deployed* — dev: `http://localhost:8090` (WS `ws://localhost:8090`) | Client |

> When Route Save is deployed to Cloud Run it will be `https://…` / `wss://…`.
> Put all three in client config; never hard-code.

No authentication is required on these services today (Clerk is pending). Treat
them as trusted-network endpoints.

---

## 3. End-to-end flow

### Step 1 — Resolve the destination (Map Service)

Use autocomplete as the user types, then fetch details to get the **place ID** and
coordinates.

```http
GET /autocomplete/json?input=sunalta
Host: tranzit-route-service-qsv32inqpq-uc.a.run.app
```
```http
POST /details
Content-Type: application/json

{ "place_id": "ChIJ…" }
```

Keep the **`place_id`** — you'll pass it to both `/route` and Route Save.

> ⚠️ **Place IDs are session-scoped.** Use them within the trip; do **not** persist
> them to disk / SQLite / your backend.

### Step 2 — Fetch directions (Map Service)

```http
POST /route
Content-Type: application/json

{ "origin": { "lat": 51.0447, "lng": -114.0719 },
  "destination_id": "ChIJ…" }          // the place_id from Step 1
```

Response is the **raw Google Routes** payload with up to two alternatives:

```json
{ "routes": [ { "distanceMeters": 3025, "duration": "1264s",
                "legs": [ { "steps": [ … ] } ],
                "polyline": { "encodedPolyline": "…" } },
              { … } ] }
```

Render the alternatives, let the user choose, and keep that **one route object**
(e.g. `response.routes[0]`).

### Step 3 — Start the trip (Route Save)

POST the **single chosen route object** (not the `{ "routes": […] }` wrapper) plus
the destination place ID.

```http
POST /trips
Host: <route-save>
Content-Type: application/json

{
  "route": { "distanceMeters": 3025, "duration": "1264s",
             "legs": [ … ], "polyline": { … } },   // = routes[0]
  "destination_place_id": "ChIJ…",                  // REQUIRED — same id as /route
  "origin": { "lat": 51.0447, "lng": -114.0719 },   // optional
  "user_id": "…"                                     // optional (until Clerk)
}
```

**Response `201 Created`:**
```json
{ "session_id": "9f3c…", "ws_url": "/trips/9f3c…/ws" }
```

- `destination_place_id` is **required** — Route Save needs it to reroute. It is
  held in memory for the session only and never persisted.
- It **must be the same** place ID you used for `/route`’s `destination_id`.
- Live GPS is **not** sent here — it streams over the WebSocket (Step 4).

Errors: `400` (bad/missing `route` or `destination_place_id`), `422` (route could
not be resolved to GTFS trips).

### Step 4 — Open the WebSocket (Route Save)

```
ws://localhost:8090/trips/9f3c…/ws        (dev)
wss://<route-save>/trips/9f3c…/ws         (deployed)
```

On connect, the server immediately pushes a full `STATE`. Then:
- **Send** `LOCATION` ~every 5 s.
- **Render** every `STATE` (full snapshot).
- **React** to `REROUTE` and `NOTIFY`.

### Step 5 — End the trip

Close the WebSocket, or:
```http
DELETE /trips/9f3c…
```
Either tears the session down. The trip can be closed anytime.

---

## 4. WebSocket protocol

All frames are **JSON text messages** with a `"type"` discriminator. The export is
authoritative and one-directional (server → client for rendering); your only inputs
are `LOCATION`, `UNSURE_RESPONSE`, and `RESUME`.

### 4.1 Client → Server

**`LOCATION`** — live GPS, ~every 5 s. This is the trip's eyes; send it steadily.
```json
{ "type": "LOCATION", "lat": 51.0447, "lng": -114.0719,
  "speed_mps": 1.4, "heading_deg": 271, "ts": 1730000000 }
```

**`UNSURE_RESPONSE`** — answer to a `CONFIRM_BOARDING` notification.
```json
{ "type": "UNSURE_RESPONSE", "stop_id": "8123", "boarded": true }
```

**`RESUME`** — after a reconnect (tunnels, backgrounding). *Currently the server
replies with the latest `STATE`; full snapshot reconciliation is pending.*
```json
{ "type": "RESUME", "session_id": "9f3c…", "state_version": 42,
  "lat": 51.04, "lng": -114.07 }
```

### 4.2 Server → Client

**`STATE`** — the full read-only trip export. Render the whole trip from this one
message; it carries every stop with all renderable fields.
```json
{ "type": "STATE", "session_id": "9f3c…", "version": 43, "overall": "ACTIVE",
  "stops": [
    { "stop_id": "1",   "stop_name": "City Hall",       "route_id": "3",
      "stop_type": "FETCHED",  "status": "COMPLETED",
      "time_remaining_s": -180, "eta": 1729999820, "lat": 51.045, "lng": -114.058 },
    { "stop_id": "11",  "stop_name": "7 Ave & 2 St SW", "route_id": "3",
      "stop_type": "FETCHED",  "status": "ACTIVE",
      "time_remaining_s": 0,    "eta": 1730000000, "lat": 51.047, "lng": -114.071 },
    { "stop_id": "111", "stop_name": "Sunalta Station", "route_id": "3",
      "stop_type": "TRANSFER", "status": "EXPECTED",
      "time_remaining_s": 240,  "eta": 1730000240, "lat": 51.044, "lng": -114.097 }
  ] }
```

**`REROUTE`** — Route Save dynamically switched the trip. A fresh `STATE` follows.
```json
{ "type": "REROUTE", "reason": "MISSED",
  "from": { "lat": 51.05, "lng": -114.08 },
  "legs": [ { "leg_index": 0, "mode": "BUS", "route_id": "2", "trip_id": "…" } ] }
```

**`NOTIFY`** — user-facing message; may require a response.
```json
{ "type": "NOTIFY", "kind": "TRANSFER_AT_RISK", "stop_id": "21",
  "requires_response": false,
  "message": "Your transfer will be missed. Rerouting." }
```
- `kind: "CONFIRM_BOARDING"` with `requires_response: true` → prompt the user and
  reply with `UNSURE_RESPONSE`.
- `kind: "TRANSFER_AT_RISK"` → informational; a `REROUTE` will follow.

### 4.3 Field reference

`STATE.stops[]`:

| Field | Type | Meaning |
|-------|------|---------|
| `stop_id` | string | GTFS stop id (teleride number) |
| `stop_name` | string | Human-readable name |
| `route_id` | string | Bus number (empty on walk context) |
| `stop_type` | `FETCHED` \| `TRANSFER` | FETCHED = a boarding stop |
| `status` | `EXPECTED` \| `ACTIVE` \| `COMPLETED` \| `UNSURE` \| `MISSED` | Per-stop lifecycle |
| `time_remaining_s` | int | Bus ETA minus server now (can be negative) |
| `eta` | int64 | Predicted bus arrival, Unix seconds |
| `lat`, `lng` | float | Stop location |

`overall` uses the same status vocabulary for the whole trip.

---

## 5. Rendering guidance

- **`STATE` is a full snapshot** — replace your trip view on each one; don't try to
  diff. The complete leg/stop list is always present.
- **Use `version` to drop stale frames.** It is monotonic; ignore any `STATE` whose
  `version` is ≤ the last you rendered, and on `RESUME` send your last `version` so
  the server can reconcile.
- **Don't compute ETAs/time client-side.** `time_remaining_s` and `eta` are
  server-authoritative (the server clock matches the GTFS-RT feed). Display them as
  given; the client clock is never the source of truth.
- **Status colors** map cleanly: COMPLETED (done), ACTIVE (you're here / on this
  bus), EXPECTED (upcoming), UNSURE (confirm boarding), MISSED (rerouting).

---

## 6. Reconnection

Mobile transit means dropped sockets (tunnels, app backgrounding).

1. On disconnect, retry the WebSocket with backoff using the **same `session_id`**.
2. On reconnect, send a `RESUME` with your last `state_version` and current GPS.
3. The server replies with a fresh `STATE`. (Snapshot-based reconciliation across
   long gaps is still being finalized server-side; for now treat the returned
   `STATE` as truth.)

If the session no longer exists (server restart, or it was DELETEd), `POST /trips`
again to start fresh.

---

## 7. Minimal Expo / TypeScript example

```ts
const MAP = "https://tranzit-route-service-qsv32inqpq-uc.a.run.app";
const ROUTE_SAVE = process.env.EXPO_PUBLIC_ROUTE_SAVE_URL!;      // http(s)://…
const ROUTE_SAVE_WS = ROUTE_SAVE.replace(/^http/, "ws");

// 1–2: directions
const dirs = await fetch(`${MAP}/route`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ origin: { lat, lng }, destination_id: placeId }),
}).then(r => r.json());
const chosen = dirs.routes[0];            // user-selected alternative

// 3: start the trip
const { session_id, ws_url } = await fetch(`${ROUTE_SAVE}/trips`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    route: chosen,
    destination_place_id: placeId,        // same id as /route
    origin: { lat, lng },
  }),
}).then(r => r.json());

// 4: live channel
const ws = new WebSocket(`${ROUTE_SAVE_WS}${ws_url}`);
let lastVersion = -1;

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  switch (msg.type) {
    case "STATE":
      if (msg.version <= lastVersion) return;   // drop stale
      lastVersion = msg.version;
      renderTrip(msg);                           // full snapshot
      break;
    case "REROUTE":
      showToast(`Rerouting (${msg.reason})`);    // STATE follows
      break;
    case "NOTIFY":
      if (msg.kind === "CONFIRM_BOARDING" && msg.requires_response) {
        promptBoarding(msg.stop_id, (boarded) =>
          ws.send(JSON.stringify({ type: "UNSURE_RESPONSE", stop_id: msg.stop_id, boarded })));
      } else {
        showToast(msg.message);
      }
      break;
  }
};

// stream GPS every ~5s
const timer = setInterval(() => {
  ws.send(JSON.stringify({
    type: "LOCATION", lat: cur.lat, lng: cur.lng,
    speed_mps: cur.speed, heading_deg: cur.heading, ts: Math.floor(Date.now()/1000),
  }));
}, 5000);

// end the trip
function endTrip() {
  clearInterval(timer);
  ws.close();                                    // or DELETE /trips/{session_id}
}
```

---

## 8. Gotchas & invariants

- **Single route object, not the wrapper.** Send `routes[0]` as `route`, never the
  whole `{ "routes": [...] }` response — Route Save expects one route object.
- **`destination_place_id` is required and must match** the `/route` destination.
- **Never persist place IDs** (session-scoped). Don't store them in SQLite, the
  secure store, or your backend.
- **LOCATION only over WS**, ~5 s cadence. No live position in the start POST.
- **Server clock is authoritative** for all timing; render `time_remaining_s`/`eta`
  verbatim.
- **`time_remaining_s` can be negative** (bus already due/past at that stop) — that
  is normal, not an error.
- **One WebSocket per trip.** Open it after `POST /trips`; tear it down on trip end
  or navigation away.

---

## 9. Quick reference

### Map Service (client-direct)
| Method | Path | Body / Query | Returns |
|--------|------|--------------|---------|
| GET | `/autocomplete/json` | `?input=` | Google predictions |
| GET | `/search` | `?q=` | places |
| POST | `/details` | `{ "place_id" }` | place details |
| GET | `/searchnearby` | `?lat=&lng=` | nearby places |
| POST | `/route` | `{ origin:{lat,lng}, destination_id }` | `{ routes:[…] }` |

### Route Save
| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/trips` | `{ route, destination_place_id, origin?, user_id? }` | `201 { session_id, ws_url }` |
| GET (WS) | `/trips/{id}/ws` | — | STATE / REROUTE / NOTIFY stream |
| DELETE | `/trips/{id}` | — | `204` |
| GET | `/health` | — | `{ "status": "ok" }` |

### WebSocket messages
| Direction | Types |
|-----------|-------|
| Client → Server | `LOCATION`, `UNSURE_RESPONSE`, `RESUME` |
| Server → Client | `STATE`, `REROUTE`, `NOTIFY` |
