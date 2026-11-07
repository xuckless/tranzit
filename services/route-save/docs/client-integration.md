# Route Save — Client Integration Guide

How a Tranzit client (React Native / Expo) wires into **Route Save** for live trip
tracking, and into **Map Service** (tranzit-route-service) for the directions it
hands off.

---

## 1. The big picture

```
        ┌────────────────────────── Tranzit Client (Expo) ──────────────────────────┐
        │                                                                           │
        │  1. autocomplete / details / search   ──► Map Service  (direct)           │
        │  2. fetch directions  POST /route     ──► Map Service  (direct)           │
        │  3. pick ONE route, POST /trips       ──► Route Save                      │
        │  4. open WebSocket  /trips/{id}/ws     ◄─► Route Save  (live STATE stream)│
        │  5. stream LOCATION up, render STATE down, react to REROUTE / NOTIFY      │
        │  6. close socket (or DELETE) to end the trip                              │
        └───────────────────────────────────────────────────────────────────────────┘

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
| **Map Service** (tranzit-route-service) | `https://tranzit-route-service-000000000000.us-central1.run.app` | Client (direct) |
| **DB Middleware** (tranzit-db-middleware) | `https://tranzit-db-middleware-000000000000.us-central1.run.app` | Route Save (server-side); client only for optional live vehicle positions |
| **Route Save** | `https://tranzit-route-save-000000000000.us-central1.run.app` (WS `wss://…`) — dev: `http://localhost:8090` (WS `ws://localhost:8090`) | Client |

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
Host: tranzit-route-service-000000000000.us-central1.run.app
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

### Step 3 (OTP variant) — Start an OpenTripPlanner trip

Map Service exposes a second routing engine, **OpenTripPlanner**, at `POST /route/otp`.
It plans on the GTFS graph from **coordinates** (no Place ID) and returns concrete
`trip_id` + entry/exit `stop_id` per leg. Its response is keyed `itineraries` (not
`routes`) and tagged `"source": "opentrip"`:

```json
{ "source": "opentrip",
  "itineraries": [ { "duration_seconds": 1349, "legs": [ … ] }, … ] }
```

To start a trip from an OTP route, **`POST /trips` with the engine tag and coordinates**
— *not* the Google `destination_place_id` body:

```http
POST /trips
Content-Type: application/json

{
  "source": "opentrip",                              // REQUIRED — selects the OTP path
  "route": { /* the chosen raw OTP itinerary, OR the
                whole {source,itineraries:[…]} envelope */ },
  "destination": { "lat": 51.0379, "lng": -114.0908 }, // REQUIRED — coords, NOT a place_id
  "origin": { "lat": 51.0447, "lng": -114.0719 },      // optional
  "user_id": "…"                                       // optional
}
```

Response is the same `201 { session_id, ws_url }`; everything downstream (WebSocket,
`STATE`, `REROUTE`, `DELETE`) is identical. Reroutes re-fetch via `/route/otp` from the
`destination` coordinates, which is why coords are required and a Place ID is not used.

> **Send the *raw* route, never a UI-normalized one.** If your client normalizes the
> OTP `itineraries` into a Google-shaped object for rendering, that adapter typically
> drops `trip_id`, `from_stop_id`/`to_stop_id`, and stop **coordinates** — exactly what
> Route Save's OTP path needs. Posting the normalized object (or omitting `source`)
> sends it down the Google path with no stop coords → `422 no candidate serves
> entry→exit in order`. Keep the raw itinerary alongside your rendered route and POST
> that.

**Server-owned alternative — `POST /tranzit-route`.** If the client doesn't pre-pick an
itinerary, send only coordinates and let Route Save fetch + pick (shortest) itself:

```http
POST /tranzit-route
Content-Type: application/json

{ "origin": { "lat": …, "lng": … },
  "destination": { "lat": …, "lng": … },
  "num_itineraries": 5 }            // optional; "mode" optional (default walk_transit)
```

→ `201 { session_id, ws_url, route }` — `route` is the chosen OTP envelope so you can
render immediately. Use this only when server-side itinerary choice is acceptable (it
won't necessarily match a specific route the user tapped).

> **Engines at a glance.** Google `/route` → `{routes:[…]}`, needs `destination_place_id`.
> OTP `/route/otp` → `{source:"opentrip", itineraries:[…]}`, needs `destination` coords.
> `source` on the `/trips` body discriminates the two; omit it for the Google default.

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

```http
DELETE /trips/9f3c…
```
ends the trip at any time. Closing the WebSocket does **not**: a dropped socket
(network blip, app backgrounded or killed) leaves the session running for 15
minutes (`SessionReattachGraceS`) so the client can reconnect to the same
`ws_url` and send `RESUME`. After that window the session tears itself down.

### Step 6 — Let it drive (automatic rerouting)

After Step 4 you do **nothing** to re-plan a trip. Route Save runs the whole loop:
it ticks every second, refreshes GTFS-RT ETAs every 30 s, watches the rider's
location, and when a bus is missed (or a boarding isn't confirmed in 120 s) it calls
Map Service itself, splices a new route, and pushes you `REROUTE` + a fresh `STATE`.
You only ever **stream `LOCATION` up, render what comes down, and answer
`CONFIRM_BOARDING`.** You never call `/route` again for the same trip.

---

## 3b. Full automatic route configuration — the contract

End to end, "automatic route configuration" means: you supply a destination and a
chosen first route once; from then on Route Save keeps the trip correct (re-resolving
and rerouting) and streams it to you to render. Here's exactly who does what.

### What **you** provide
| When | What | Notes |
|------|------|-------|
| Step 1 | A **destination `place_id`** (+ coords) from Map Service | Session-scoped; never persist. |
| Step 2 | A `/route` call to Map Service: `{ origin:{lat,lng}, destination_id }` | The client fetches directions directly. |
| Step 3 | `POST /trips` with the **one chosen route object**, the **same `destination_place_id`**, and optional `origin`/`user_id` | The route object is `routes[i]` from Step 2 — *not* the wrapper. |
| Step 4→on | **`LOCATION`** over the WebSocket, ~every 5 s | The trip's only live input. With no fix the server can't confirm boarding and will ask (UNSURE). |
| On prompt | **`UNSURE_RESPONSE { stop_id, boarded }`** when you get `CONFIRM_BOARDING` | Optional but recommended; otherwise the server decides after 120 s. |
| On reconnect | **`RESUME`** with last `session_id`, `state_version`, current GPS | After tunnels/backgrounding. |

### What **we** (Route Save) provide
| What | How |
|------|-----|
| **Trip resolution** | Maps your route's bus legs to concrete GTFS `trip_id`s (direction- and time-aware) and loads every stop entry→exit. |
| **Live tracking** | Per-stop `status`, live `time_remaining_s`/`eta` for **all** stops, refreshed from GTFS-RT — pushed as full `STATE` snapshots (coalesced, ~2 s, on change). |
| **Missed / unsure detection** | Timer-driven: at a boarding stop's predicted arrival we confirm via GPS, or ask you (`CONFIRM_BOARDING`) when GPS can't, with a 120 s answer timeout. |
| **Automatic reroute** | On MISSED we call Map Service ourselves from the rider's location (or the planned stop if GPS is silent), splice the remaining journey, and push **`REROUTE` (with the raw `route`)** + a fresh `STATE`. |
| **Resolved identifiers** | GTFS `stop_id`, `stop_name`, `route_id`, `trip_id` on every stop in `STATE` (you don't resolve these). |

### What **you** parse / render
| Message | Parse | Render |
|---------|-------|--------|
| `POST /trips` response | `session_id`, `ws_url` | open the WS at `ws_url`. |
| **`STATE`** | full stop list (`stops[]`) + `overall` | replace the whole trip view; map each stop's **`status`** string (see §5); show `time_remaining_s`/`eta` verbatim; drop frames with stale `version`. |
| **`REROUTE`** | **`route`** (raw Google route, remaining journey) + `from` + `reason` | re-render the remaining itinerary/map from `route` exactly as at trip start; keep completed history; the next `STATE` is the live view. |
| **`NOTIFY`** | `kind`, `requires_response`, `message`, `stop_id` | `CONFIRM_BOARDING` → prompt + reply `UNSURE_RESPONSE`; others → toast. |

> **No numeric status flag.** The whole contract rides on the `status` *string* per
> stop (and `overall`). `UNSURE` means "ask the rider"; `MISSED` means "consume the
> new directions". Don't look for a separate `0/1/2` field — map the strings.

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

**`REROUTE`** — Route Save dynamically switched the trip (the rider missed a bus,
or didn't confirm boarding in time). A fresh `STATE` follows immediately.
```json
{ "type": "REROUTE", "reason": "MISSED",
  "from": { "lat": 51.05, "lng": -114.08 },
  "route": { "distanceMeters": 4210, "duration": "1530s",
             "legs": [ { "steps": [ … ] } ],
             "polyline": { "encodedPolyline": "…" } },
  "legs": [ { "leg_index": 0, "mode": "BUS", "route_id": "2", "trip_id": "…" } ] }
```
- **`route`** is the **raw Google route object** for the *remaining* journey
  (`from` → original destination) — the **same shape** you got back from Map
  Service `/route` and handed to `POST /trips`. Re-render your map/itinerary from
  this exactly as you did at trip start (decode `polyline`, walk `legs[].steps`).
  Route Save has already resolved it to GTFS trips and the next `STATE` reflects it.
- **`from`** is the point the new route departs from: the rider's live GPS fix, or —
  when GPS is silent — the planned stop they were meant to board.
- **`legs`** is Route Save's parsed summary of the spliced trip (mode/route/trip per
  leg); informational. Render from `route` + the following `STATE`, not from `legs`.

**`NOTIFY`** — user-facing message; may require a response.
```json
{ "type": "NOTIFY", "kind": "CONFIRM_BOARDING", "stop_id": "8123",
  "requires_response": true,
  "message": "Did you board the bus?" }
```
- `kind: "CONFIRM_BOARDING"` with `requires_response: true` → the server is
  **UNSURE** whether the rider boarded (the bus was due but GPS couldn't confirm —
  no recent fix, or the rider is hovering 20–50 m from the stop). **Prompt the user**
  and reply with `UNSURE_RESPONSE { boarded }`. `boarded:true` → the trip continues;
  `boarded:false` → an immediate `REROUTE`.
  - **You are not on a deadline to answer, but the server is.** If neither your
    answer nor a clarifying GPS fix arrives within **120 s**, Route Save assumes the
    bus was missed and reroutes on its own — so always be ready to handle a
    `REROUTE` even if the prompt is still on screen, and dismiss the prompt when the
    matching stop leaves `UNSURE`.
- `kind: "TRANSFER_AT_RISK"` with `requires_response: false` → informational; a
  `REROUTE` will follow.

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
- **`status` is the single source of truth for what to do** — there is no separate
  numeric flag; you map the string yourself:
  - `COMPLETED` — done (passed/alighted).
  - `ACTIVE` — you're here / on this bus.
  - `EXPECTED` — upcoming; not yet evaluated.
  - `UNSURE` — the server is awaiting confirmation; **prompt the rider** (you'll also
    get a `CONFIRM_BOARDING` `NOTIFY`). Reply with `UNSURE_RESPONSE`.
  - `MISSED` — the bus was missed; a `REROUTE` is coming (or has come). **Consume the
    `REROUTE.route` and re-render.**
- **On `REROUTE`, re-render from `route`.** Treat `REROUTE.route` exactly like the
  route object you started the trip with: it replaces the *remaining* journey. The
  `STATE` that immediately follows is the authoritative live view for it; keep the
  already-completed portion you've shown as history.

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
const MAP = "https://tranzit-route-service-000000000000.us-central1.run.app";
const ROUTE_SAVE = process.env.EXPO_PUBLIC_ROUTE_SAVE_URL!;      // http(s)://…
const ROUTE_SAVE_WS = ROUTE_SAVE.replace(/^http/, "ws");

// 1–2: directions (Google engine)
const dirs = await fetch(`${MAP}/route`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ origin: { lat, lng }, destination_id: placeId }),
}).then(r => r.json());
const chosen = dirs.routes[0];            // user-selected alternative

// 3: start the trip (Google)
const { session_id, ws_url } = await fetch(`${ROUTE_SAVE}/trips`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    route: chosen,
    destination_place_id: placeId,        // same id as /route
    origin: { lat, lng },
  }),
}).then(r => r.json());

// 1–3 (OTP variant): fetch /route/otp, keep the RAW chosen itinerary, then POST
// /trips with source + destination coords (no place_id). Everything after is the same.
//
//   const otp = await fetch(`${MAP}/route/otp`, {
//     method: "POST", headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({ origin: { lat, lng }, destination: { lat: dLat, lng: dLng } }),
//   }).then(r => r.json());                       // { source:"opentrip", itineraries:[…] }
//   const itinerary = otp.itineraries[0];         // user-selected, RAW (keeps trip_id/stop ids)
//   const { session_id, ws_url } = await fetch(`${ROUTE_SAVE}/trips`, {
//     method: "POST", headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({
//       source: "opentrip",
//       route: itinerary,                          // raw itinerary OR the whole envelope
//       destination: { lat: dLat, lng: dLng },     // coords, NOT a place_id
//       origin: { lat, lng },
//     }),
//   }).then(r => r.json());

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
      // msg.route is the raw Google route for the remaining journey — render it the
      // same way you rendered the route you started with. A STATE follows.
      renderRoute(msg.route);                    // decode polyline, walk legs[].steps
      showToast(`Rerouting (${msg.reason})`);
      break;
    case "NOTIFY":
      if (msg.kind === "CONFIRM_BOARDING" && msg.requires_response) {
        // Server is UNSURE; it will auto-reroute in 120s if you don't answer, so
        // also dismiss this prompt once the stop leaves UNSURE in a later STATE.
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
- **Reroutes are automatic — never re-call `/route` for a live trip.** Render the
  `route` object Route Save sends on `REROUTE`; the server already re-planned it.
- **A `CONFIRM_BOARDING` prompt self-resolves after 120 s.** If the rider ignores it
  and GPS stays ambiguous, the server reroutes anyway. Always handle a `REROUTE`
  arriving while the prompt is still up, and dismiss the prompt when the stop leaves
  `UNSURE` in a later `STATE`.
- **Map by `status` string, not a flag.** There is no numeric status field; `UNSURE`
  → prompt, `MISSED` → consume `REROUTE.route`.

---

## 9. Quick reference

### Map Service (client-direct)
| Method | Path | Body / Query | Returns |
|--------|------|--------------|---------|
| GET | `/autocomplete/json` | `?input=` | Google predictions |
| GET | `/search` | `?q=` | places |
| POST | `/details` | `{ "place_id" }` | place details |
| GET | `/searchnearby` | `?lat=&lng=` | nearby places |
| POST | `/route` | `{ origin:{lat,lng}, destination_id }` | `{ routes:[…] }` (Google) |
| POST | `/route/otp` | `{ origin:{lat,lng}, destination:{lat,lng}, mode?, num_itineraries? }` | `{ source:"opentrip", itineraries:[…] }` (OTP) |

### Route Save
| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/trips` (Google) | `{ route, destination_place_id, origin?, user_id? }` | `201 { session_id, ws_url }` |
| POST | `/trips` (OTP) | `{ source:"opentrip", route, destination:{lat,lng}, origin?, user_id? }` | `201 { session_id, ws_url }` |
| POST | `/tranzit-route` (OTP, server-fetched) | `{ origin:{lat,lng}, destination:{lat,lng}, num_itineraries?, mode? }` | `201 { session_id, ws_url, route }` |
| GET (WS) | `/trips/{id}/ws` | — | STATE / REROUTE / NOTIFY stream |
| DELETE | `/trips/{id}` | — | `204` |
| GET | `/health` | — | `{ "status": "ok" }` |

### WebSocket messages
| Direction | Types |
|-----------|-------|
| Client → Server | `LOCATION`, `UNSURE_RESPONSE`, `RESUME` |
| Server → Client | `STATE`, `REROUTE`, `NOTIFY` |
