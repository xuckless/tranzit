# Tranzit — Internal Codebase Documentation

> For new contributors. Explains the data flow, key architectural decisions, and gotchas that are not obvious from reading the code alone.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Directory Map](#2-directory-map)
3. [Backend Services & Endpoints](#3-backend-services--endpoints)
4. [Data Layer](#4-data-layer)
5. [Core Libraries (`lib/`)](#5-core-libraries-lib)
6. [Screen Architecture](#6-screen-architecture)
7. [Components](#7-components)
8. [Hooks](#8-hooks)
9. [Types](#9-types)
10. [Critical Constraints & Known Gotchas](#10-critical-constraints--known-gotchas)

---

## 1. Project Overview

Tranzit is a Calgary-specific public transit app built in React Native (Expo). The frontend talks to two backend services:

- **Route Service** (`tranzit-route-service`) — Go microservice wrapping the Google Maps Routes/Places APIs.
- **DB Middleware** (`tranzit-db-middleware`) — REST+SSE service exposing the PostgreSQL transit database to the client.

The app has four main tabs: **Map**, **Routes**, **Commute**, and **Saved**. The flow is: user searches a destination on Map or Routes → route is computed → user starts a journey → Commute screen takes over with live tracking.

---

## 2. Directory Map

```
app/
  (tabs)/
    map.tsx          — Main map screen with bottom sheet, live markers, search
    routes.tsx       — Route planning: origin/destination inputs + route picker
    commute.tsx      — Active journey screen with live vehicle tracking
    saved.tsx        — Saved places management
    _layout.tsx      — Tab bar configuration
  _layout.tsx        — Root layout (Clerk auth, navigation container)
  index.tsx          — Splash/redirect entry point
  settings/index.tsx — Settings screen

components/
  stopViews.tsx      — StopMarker, StopDetailsPanel (transit stop callouts)
  busViews.tsx       — PooledBusMarker, BusDetailsPanel (live bus callouts)
  horizontalView.tsx — Horizontal scroll row utility
  SavePlaceModal.tsx — Modal for saving a place to a category
  routes/
    RoutePickerSheet.tsx   — Scrollable route card list
  search/
    SearchBar.tsx          — Basic search input
    SearchSheet.tsx        — Full search overlay on the map screen
    SearchResultsList.tsx  — POI results list
    DestinationSuggestionsList.tsx — Merged suggestions (search + autocomplete)

lib/
  supabase.ts        — Supabase client singleton (typed against Database)
  middleware.ts      — Typed REST client for the DB middleware service
  vehicleSSE.ts      — Singleton SSE hook for live bus positions
  transitStopsCache.ts — Orchestrates middleware fetch → SQLite write
  routeStore.ts      — In-memory session store for the active journey
  db.ts              — SQLite schema, saved places CRUD, stops cache CRUD

hooks/
  usePlacesSearch.ts       — Single-source search hook (route service /search)
  useDestinationSearch.ts  — Dual-source search hook (/search + /autocomplete/json)
  useSavedPlaces.ts        — SQLite-backed saved places hooks
  useMapPressHandler.ts    — Map long-press → reverse geocode handler

services/
  TranzitApiService.ts     — All calls to the route service (search, details, route)

types/
  places.ts    — SearchSuggestion, PlaceResult, Route, RouteStep, etc.
  database.ts  — All PostgreSQL table interfaces + Supabase Database generic

utils/
  decodePolyline.ts — Thin wrapper around @mapbox/polyline

styles/
  theme.ts     — Colors, font sizes, spacing constants
```

---

## 3. Backend Services & Endpoints

### Route Service

```
BASE_URL = https://tranzit-route-service-000000000000.us-central1.run.app
# Set EXPO_PUBLIC_USE_LOCAL=true in .env.local to point at localhost:3100
```

All calls go through `services/TranzitApiService.ts`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/search?q=&lat=&lng=` | POI/business search. `lat`/`lng` are optional; passing them biases results toward the user's location. Returns `404` when nothing matches. |
| `POST` | `/details` | Full place details (address, rating, opening hours) for a given `place_id`. |
| `GET` | `/autocomplete/json?input=` | Google Places Autocomplete predictions. Covers street addresses that `/search` misses. |
| `POST` | `/route` | Computes the top 2 transit routes. Body: `{ origin: {lat, lng}, destination_id: string }`. Returns `204` when no transit route exists. |

**Important:** `/route` takes a Google Place ID in `destination_id`, never a text address. The Place ID comes from `/search` or `/autocomplete` → `/details`. Do not persist Place IDs — they are session-state only (Google TOS).

### DB Middleware

```
BASE_URL = https://tranzit-db-middleware-000000000000.us-central1.run.app
```

Generic REST interface to the PostgreSQL tables. All calls go through `lib/middleware.ts`.

```
GET /api/v1/{table}?{field}={operator}.{value}&limit=N&offset=N
```

Response envelope:
```json
{ "table": "...", "count": N, "limit": N, "offset": N, "data": [...] }
```

`middlewareQuery<T>(table, params)` unwraps `data` and returns `T[]`.

The middleware also exposes a **Server-Sent Events** stream at `/api/v1/vehicle_positions`. This is consumed exclusively by `lib/vehicleSSE.ts`.

---

## 4. Data Layer

### PostgreSQL (via Supabase + DB Middleware)

All table types live in `types/database.ts`. Key tables:

| Table | Description |
|-------|-------------|
| `calgary_transit_stops` | Static stops. PK: `globalid`. `teleride_number` is the stop ID used everywhere else (confusingly named). Coordinates in WKT: `POINT(lng lat)` — **longitude first**. |
| `calgary_transit_routes` | Static bus/CTrain route shapes in WKT multilinestring format. |
| `calgary_train_stations` | CTrain station names and track distances. |
| `trip_updates` | Scheduled future trips. `route_id` = bus number. `timestamp` = unix epoch. |
| `stop_time_updates` | Per-stop arrival/departure times for a trip. `stop_id` maps to `calgary_transit_stops.teleride_number`. Times are unix epoch strings. |
| `vehicle_positions` | Live GPS per bus. `route_id` is imputed from `trip_updates` — it is not in the raw GTFS-RT feed. |
| `alerts` | Service alerts with active period, affected route/stop, and severity. |
| `trip_stop_delays` | Geospatial state machine tracking ground-truth delays. `transit_state` is `APPROACHING | ARRIVED | DEPARTED`. |
| `stop_analytics` | Historical delay/dwell averages and a 0–100 `congestion_score` per stop/route. |

### SQLite (local device cache)

Managed by `lib/db.ts` using `expo-sqlite`. Database file: `tranzit.db`. WAL mode is enabled.

**Schema:**

```
Category          (Id PK, catName)
Places            (GooglePlaceId PK, Address, Latitude, Longitude)
category_places   (categoryID FK, PlaceID FK, categoryName, label, is_default)
transit_stops_cache  (globalid PK, teleride_number, stop_name, status, point, cached_at)
```

`category_places` has a partial unique index (`uq_one_default_per_category`) enforcing at most one `is_default=1` row per category.

`transit_stops_cache` has a 24-hour TTL enforced in code by `getCachedTransitStops()`.

---

## 5. Core Libraries (`lib/`)

### `lib/supabase.ts`

Singleton Supabase client typed against `Database` from `types/database.ts`. Auth tokens are stored in `expo-secure-store` (not `AsyncStorage`) for security. `detectSessionInUrl: false` is required for React Native.

```typescript
import { supabase } from '@/lib/supabase';
const { data } = await supabase
  .from('vehicle_positions')
  .select('vehicle_id, latitude, longitude')
  .eq('route_id', '3');
// data is fully typed
```

**Gotcha:** `expo-secure-store` has a 2 KB per-key limit on iOS. If auth errors appear on iOS, the session token needs to be split across keys in the `SecureStoreAdapter`.

---

### `lib/middleware.ts`

Thin wrapper around the DB middleware REST API.

```typescript
const stops = await middlewareQuery<CalgaryTransitStop>(
  'calgary_transit_stops',
  { limit: 10000 }
);
```

Filter syntax mirrors PostgREST: `{ field: 'operator.value' }`, e.g. `{ status: 'ilike.active' }`, `{ arrival_time: 'gte.1234567' }`, `{ or: '(a.gte.X,b.eq.-1)' }`.

---

### `lib/vehicleSSE.ts`

Singleton SSE connection to the vehicle positions stream. Designed to be shared across `map.tsx` and `commute.tsx` without opening two connections.

**Architecture:**
- Module-level `_es` holds the single `EventSource`.
- `_refCount` tracks how many React components are subscribed. The connection opens on first subscribe and closes when `_refCount` drops to zero.
- Vehicles are stored in a **fixed-size pool** (`BUS_POOL_SIZE = 400`). Each `vehicle_id` is permanently assigned a slot index that never changes. SSE delta updates (`added`, `updated`, `removed`) patch only affected slots.
- All subscribing components call `setPool` with the same pre-built array — React only diffs props, no native tree insertion/removal.

**Events:**
- `snapshot` — full vehicle list on connect. Resets the pool.
- `update` — delta with `added`, `updated`, `removed` arrays.

**Usage:**
```typescript
const pool = useVehicleSSE(); // (VehiclePosition | null)[]
```

Do not call `useVehicleSSE()` conditionally — the ref count management requires symmetric mount/unmount.

---

### `lib/transitStopsCache.ts`

Orchestrates the stops cold-start path: SQLite cache hit → return immediately; cache miss → fetch from middleware → write to SQLite → return.

Deduplicates concurrent callers with a module-level in-flight promise (`_inflight`). If `map.tsx` and `commute.tsx` both mount simultaneously, only one network request fires.

---

### `lib/routeStore.ts`

In-memory session store (plain module-level variables, not Zustand/Context). Survives tab navigation but is lost on app reload.

| Method | Purpose |
|--------|---------|
| `setRoutes` / `getRoutes` | The fetched route array. Lets the Routes screen restore results after navigating to Commute and back. |
| `setSelectedRoute` / `getSelectedRoute` | The user's chosen route. |
| `setOrigin` / `getDestination` (and their getters) | Endpoint labels + coordinates + optional `placeId`. |
| `clearJourney()` | Nulls `_selectedRoute` only. Routes/origin/destination stay intact for restoration. Call this when ending a journey. |
| `clear()` | Full reset. Use on logout or hard reset. |

**Why not Context/Zustand?** This data is shared across three tabs that aren't in a parent-child relationship. A module singleton is simpler and avoids prop drilling through the navigator.

---

### `lib/db.ts`

All SQLite operations. Opens the database once (`getDb()` singleton). Runs `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON` on first open.

Key functions:

| Function | Description |
|----------|-------------|
| `getSavedPlacesGrouped()` | Returns all categories with their places nested. Left join so empty categories appear. |
| `getDefaultPlaces()` | Only `is_default=1` places — used for the Quick Access chips on the map. |
| `upsertPlace()` | Insert or update a `Places` row on conflict. |
| `linkPlaceToCategory()` | Atomic: clear old default if `isDefault=true`, then upsert `category_places`. |
| `getCachedTransitStops()` | Returns `null` if cache is empty or older than 24 hours. |
| `cacheTransitStops()` | Full replace inside a transaction (DELETE + INSERT). |
| `getStopNamesByTelerideNumbers()` | Map lookup from teleride numbers to stop names. Used in bus callout to resolve stop names. |

---

## 6. Screen Architecture

### `app/(tabs)/map.tsx` — Map Screen

The most complex screen. Responsibilities:
- Renders the Google Maps base layer with a custom style (`assets/map-style.json`).
- Renders transit stop markers (`StopMarker`) and live bus markers (`PooledBusMarker`).
- Handles user location + heading with a `DirectionMarker` SVG (dot + radial arc).
- Bottom sheet (two snap points: collapsed = 28% height, expanded = 62%) with a `PanResponder`.
- `SearchSheet` overlay for destination search.
- Quick Access chips from SQLite (user's saved default places).
- Pressed-pin flow (long press → search nearby business → show place card or raw coordinate pin).
- POI tap flow (native Google Maps markers → optimistic card → fetch `/details`).

**Marker stagger pattern (critical for stability):**
Stops and buses are enabled in separate `useEffect` passes after `mapReady` is true: stops immediately, buses 200 ms later. This prevents the Fabric interop crash (`AIRMap insertReactSubview:atIndex:` with nil).

**Stop filtering:**
Only stops with a scheduled arrival in the last 5 minutes or `arrival_time = -1` (no data) are shown. This caps the active marker count to ~500-800 from the full ~3000 active stops.

**Bus pool:**
`useVehicleSSE()` returns a fixed-size `(VehiclePosition | null)[]`. `busPool` maps this to `<PooledBusMarker key="bus-slot-{i}">` — key is the slot index, not the vehicle ID, so React never inserts or removes native children.

---

### `app/(tabs)/routes.tsx` — Route Planning Screen

Takes optional navigation params: `destinationId`, `destinationLat`, `destinationLng`, `destinationName`. Passed from the map screen when the user taps "Directions" or "Go".

**Search:**
Both origin and destination fields use `useDestinationSearch`. This hook fires two requests per keystroke: `/search` at 150 ms (for POIs) and `/autocomplete/json` at 600 ms (for addresses). Results are merged, deduplicating by `placeId`.

Queries that start with a digit are treated as address queries — `/search` is skipped since it returns businesses on that street, not the specific address number.

**Route fetch:**
`handleFindRoutes` calls `TranzitApiService.getRoute`. Requires `destination.placeId` — the button is disabled until the user selects a suggestion that has a Place ID. After fetching, results are written to `routeStore` for restoration.

**Filter chips:**
"All" / "Bus" / "CTrain" filter the route list. CTrain detection checks `transitLine.name` for "ctrain" or "lrt".

**Start Journey:**
`handleStart` writes the selected route and endpoints to `routeStore` then navigates to `/(tabs)/commute`.

---

### `app/(tabs)/commute.tsx` — Active Journey Screen

Reads from `routeStore` via `useFocusEffect` — called unconditionally so that `clearJourney()` correctly resets the screen when returning from a completed journey.

Features:
- Route polyline rendered on a small map using the route-level encoded polyline.
- Live bus markers via `useVehicleSSE()` (shared connection with map).
- `CommuteStop` list built from `route.legs[].steps[]` — walk steps and transit steps are mapped to a timeline with `departed | current | upcoming | destination` status.
- `haversineMeters()` is used for proximity detection (determine "current" stop).
- Crowd report UI (`packed | clearing | null`) — UI only, not yet wired to a backend.
- "End Journey" button calls `routeStore.clearJourney()` then navigates back to Routes.

---

### `app/(tabs)/saved.tsx` — Saved Places

Renders saved places grouped by category, sourced from SQLite via `useSavedPlaces()`. Allows marking a place as the default for its category (Quick Access chip source).

---

## 7. Components

### `components/stopViews.tsx`

**`parseWKTPoint(wkt: string)`** — Exported. Parses `POINT(lng lat)` and returns `{ latitude, longitude }` or `null`. Longitude is the first token (PostGIS standard). Call this in `map.tsx` to pre-validate stops before creating markers — returning `null` from a MapView child crashes under Fabric interop.

**`StopMarker`** — 10 px blue dot. `tracksViewChanges={false}` (stops never move). Lazy-fetches schedule on first tap, polls every 30 s while callout is open. Closes polling when callout closes.

**`StopDetailsPanel`** — Bottom sheet panel (not a Callout). Shows upcoming arrivals for a stop, queried by `teleride_number` from `stop_time_updates` joined to `trip_updates` for route names.

---

### `components/busViews.tsx`

**`PooledBusMarker`** — Accepts `vehicle: VehiclePosition | null`. When `null`, renders `opacity={0}` at a dummy coordinate. This keeps the native child count constant. `tracksViewChanges` is `true` for 500 ms after mount, then frozen.

The marker is a 30×30 SVG circle with a north-pointing chevron. `rotation={bearing}` on the `<Marker>` rotates the whole SVG natively — no JS re-render on bearing change.

**`BusDetailsPanel`** — Fetches full trip stop sequence and route name. Shows passed stops as dimmed rows with a "Passed" pill. Bearing updates are guarded by `calloutOpenRef` so the panel stays stable during live refreshes.

---

### `components/routes/RoutePickerSheet.tsx`

Displays a scrollable list of route cards. The selected route gets a blue border and light-blue background (`cardSelected` style). The first route gets a "Fastest" badge regardless of selection. Accepts `selectedRoute` prop for reference-equality comparison.

**`normalizeColor(color: string)`** — Exported. Prepends `#` if the transit line color from the API is missing it (the Google Routes API sometimes omits the `#`).

---

### `components/search/SearchSheet.tsx`

The map screen's search overlay. Uses `useDestinationSearch` internally. Calls `onSearchActiveChange(true)` when the user focuses the field (map screen snaps the bottom sheet to expanded). Calls `onDestinationSelected` when a result is chosen.

---

## 8. Hooks

### `useDestinationSearch(userLocation?)`

Dual-source destination search for the Routes screen. Two timers per keystroke:
1. **Instant** (150 ms): `GET /search` — fast, covers POIs and businesses. Skipped if query starts with a digit.
2. **Autocomplete** (600 ms, or 300 ms for address queries): `GET /autocomplete/json` — covers street addresses.

Results are merged in a `Set` deduplicating by `placeId`. Instant results appear first, autocomplete results fill in after.

`SearchSuggestion` shape: `{ placeId, mainText, secondaryText, location? }`. Location is only populated for `/search` results. Autocomplete results need a `POST /details` call to get coordinates.

---

### `usePlacesSearch(userLocation?)`

Simpler single-source search for the map's `SearchSheet`. One debounce timer (350 ms), one abort controller. State machine: `idle | loading | success | empty | error`.

---

### `useSavedPlaces()`

Reads all saved places from SQLite via `getSavedPlacesGrouped()`. Exposes `markDefault(categoryId, placeId)` which updates SQLite and re-fetches.

### `useQuickAccess()`

Reads only `is_default=1` places via `getDefaultPlaces()`. Used by the map screen for Quick Access chips. Exposes `refresh()` (increments a tick to re-run the effect).

---

## 9. Types

### `types/places.ts`

Core contract types for search and routing:

| Type | Purpose |
|------|---------|
| `SearchSuggestion` | Unified shape from both `/search` and `/autocomplete/json`. |
| `PlaceResult` | Single result from `GET /search`. |
| `PlaceDetails` | Extends `PlaceResult` with optional rating, hours, phone, etc. from `POST /details`. |
| `SelectedDestination` | What gets passed to the map after a search selection: `placeId`, `displayText`, `coordinate`. |
| `Route` | Top-level route object from `POST /route`. Always has `polyline.encodedPolyline`. |
| `RouteStep` | Single step with `travelMode: "WALK" | "TRANSIT"`. Walk steps have no `transitDetails`. |

**Do not use step-level polylines for map rendering.** They are not always present in the API response. Use `route.polyline.encodedPolyline` (route-level) instead.

### `types/database.ts`

TypeScript interfaces for all 9 PostgreSQL tables plus the `Database` generic passed to `createClient<Database>`. All `.from()` calls are fully type-inferred.

The `Relationships: []` field is required on every table entry — without it, supabase-js v2's column-string inference resolves query result types to `never`.

---

## 10. Critical Constraints & Known Gotchas

### WKT coordinate order

PostGIS stores `POINT(lng lat)` — longitude first. `parseWKTPoint` in `stopViews.tsx` is correct. Do not invert the tokens.

### Fabric interop crash (`AIRMap insertReactSubview:atIndex:`)

`react-native-maps` runs in Fabric legacy interop mode. Three rules that must never be broken:

1. **Never return `null` from a direct child of `MapView`.** Pre-validate WKT in the parent before creating a `<StopMarker>`.
2. **Never bulk-insert two large marker arrays in the same commit frame.** Use the stagger pattern: enable stops, wait 200 ms, enable buses.
3. **Keep the native child count constant.** Use `opacity={0}` and dummy coordinates for invisible markers rather than conditional rendering.

### `vehicle_positions.route_id`

Not in the raw GTFS-RT feed. It is imputed by the backend from `trip_updates`. Always query both tables when you need route context for a vehicle.

### `stop_time_updates.stop_id` vs `calgary_transit_stops.teleride_number`

`stop_id` in `stop_time_updates` is a string that maps to `teleride_number` (an integer) in `calgary_transit_stops`. Cast with `parseInt()` or `String()` at the join boundary.

### Place ID lifecycle

Place IDs from `/search` must live in session state only — never in SQLite or `AsyncStorage`. `routeStore` is the correct home. Google's TOS requires periodic refresh; IDs can change.

### `EXPO_PUBLIC_USE_LOCAL`

Set to `"true"` in `.env.local` to route `TranzitApiService` to `localhost:3100` instead of the production Cloud Run URL. The middleware URL in `lib/middleware.ts` and `lib/vehicleSSE.ts` is hardcoded and does not respect this flag — those always hit production.

### `expo-secure-store` 2 KB limit

iOS enforces a 2 KB value size limit per key. Supabase session tokens can approach this. If iOS auth errors appear, split the session across multiple `SecureStore` keys in the `SecureStoreAdapter` in `lib/supabase.ts`.

### Route-level vs step-level polyline

`POST /route` does not guarantee step-level polylines. Only `route.polyline.encodedPolyline` is always present. Both `routes.tsx` and `commute.tsx` use the route-level polyline for all map rendering.

---

## Appendix: Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `EXPO_PUBLIC_SUPABASE_URL` | `lib/supabase.ts` | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `lib/supabase.ts` | Supabase anon key (safe to bundle; RLS enforces access) |
| `EXPO_PUBLIC_USE_LOCAL` | `services/TranzitApiService.ts` | Set to `"true"` to target `localhost:3100` |

Never commit `.env.local`. Never expose the Supabase Service Role key in the RN bundle.
