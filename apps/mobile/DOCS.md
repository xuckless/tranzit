# Tranzit — Internal Codebase Documentation

> For new contributors. Explains the data flow, key architectural decisions, and gotchas that are not obvious from reading the code alone.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Directory Map](#2-directory-map)
3. [Backend Services & Endpoints](#3-backend-services--endpoints)
4. [Data Layer](#4-data-layer)
5. [Core Libraries (`lib/`)](#5-core-libraries-lib)
6. [Contexts](#6-contexts)
7. [Screen Architecture](#7-screen-architecture)
8. [Components](#8-components)
9. [Hooks](#9-hooks)
10. [Types](#10-types)
11. [Critical Constraints & Known Gotchas](#11-critical-constraints--known-gotchas)
12. [Toolchain & Build Setup](#12-toolchain--build-setup)

---

## 1. Project Overview

Tranzit is a Calgary-specific public transit app built in React Native (Expo). The frontend talks to three backend services:

- **Route Service** (`tranzit-route-service`) — Go microservice wrapping the Google Maps Routes/Places APIs.
- **DB Middleware** (`tranzit-db-middleware`) — REST+SSE service exposing the PostgreSQL transit database to the client.
- **Route Save** (`tranzit-route-save`) — WebSocket+REST service managing active trip sessions, live tracking, rerouting, and boarding confirmation.

The app has four visible tabs: **Map**, **Routes**, **Commute**, and **Saved**, plus a hidden **Report** tab (`href: null`). The flow is: user searches a destination on Map or Routes → route is computed → user starts a journey → a server-side trip session is created → Commute screen takes over with live WebSocket tracking, push notifications, iOS Live Activities, and community reporting.

**Theme System:** All themable values (colors, fonts, sizes, weights, letter-spacing, line-height, MapLibre paint colors, semantic status colors) are defined as **preset struct objects** in `styles/themes/`. Two presets ship today: `classic-light` and `classic-dark`. To add a new theme: drop a file in `styles/themes/` that implements `AppTheme` and register it in the `THEMES` map in `styles/themes/index.ts`. The active theme is selected via `ThemeContext` and exposed as a single `useTheme()` hook returning the full `AppTheme` object (no `isDark` boolean — use `theme.isDark` if needed). Map base layer, polyline colors, stop circle paint, bus label halo, and category icon palette are all part of the theme and switch with it.

**Live Architecture:** The Commute screen is a state machine driven by WebSocket messages (`STATE`, `REROUTE`, `NOTIFY`). It integrates GPS tracking, push notifications for boarding confirmation, iOS Live Activities, and Android sticky notifications.

---

## 2. Directory Map

```
app/
  (tabs)/
    map.tsx          — Main map screen with bottom sheet, live markers, search
    routes.tsx       — Route planning: origin/destination inputs + route picker
    commute.tsx      — Active journey screen with WebSocket state machine
    saved.tsx        — Saved places management
    report.tsx       — Community reporting (hidden from tab bar)
    _layout.tsx      — Tab bar configuration + custom HeaderBar
  _layout.tsx        — Root layout (ThemeProvider, notification handlers)
  index.tsx          — Splash/redirect entry point
  settings.tsx       — Settings screen (dark mode toggle)

components/
  stopViews.tsx      — StopDetailsPanel (transit stop bottom-sheet panel)
  busViews.tsx       — BusDetailsPanel (live bus bottom-sheet panel)
  placeViews.tsx     — PlaceDetailsPanel (place card with hours/rating/phone)
  horizontalView.tsx — Horizontal scroll row utility
  SavePlaceModal.tsx — Modal for saving a place to a category
  routes/
    RoutePickerSheet.tsx   — Scrollable route card list with live delay badges
  search/
    SearchBar.tsx          — Basic search input
    SearchSheet.tsx        — Full search overlay on the map screen
    SearchResultsList.tsx  — POI results list
    DestinationSuggestionsList.tsx — Merged suggestions (search + autocomplete)

lib/
  supabase.ts        — Supabase client singleton (typed against Database)
  middleware.ts      — Typed REST client for the DB middleware service
  vehicleSSE.ts      — Singleton SSE hook for live bus positions + GeoJSON helpers
  routeSSE.ts        — Per-route SSE hook for live stop-level delays
  transitStopsCache.ts — Orchestrates middleware fetch → SQLite write
  routeStore.ts      — In-memory session store for the active journey
  tripWebSocket.ts   — WebSocket client for trip session lifecycle
  liveActivity.ts    — iOS Live Activities + Android sticky notifications
  boardingNotifications.ts — Push notifications for boarding confirmation
  db.ts              — SQLite schema, saved places CRUD, stops cache CRUD

hooks/
  usePlacesSearch.ts       — Single-source search hook (route service /search)
  useDestinationSearch.ts  — Dual-source search hook (/search + /autocomplete/json)
  useSavedPlaces.ts        — SQLite-backed saved places hooks
  useMapPressHandler.ts    — Map long-press → reverse geocode handler

contexts/
  ThemeContext.tsx     — Dark/light mode context with SecureStore persistence

services/
  TranzitApiService.ts     — All calls to the route service (search, details, route, nearby)

types/
  places.ts    — SearchSuggestion, PlaceResult, Route, RouteStep, AutocompletePrediction, etc.
  database.ts  — All PostgreSQL table interfaces + Supabase Database generic
  trip.ts      — WebSocket trip session message types

utils/
  decodePolyline.ts — Thin wrapper around @mapbox/polyline

styles/
  theme.ts             — Back-compat re-export of ClassicLight (deprecated; use `useTheme()`)
  themes/
    types.ts           — AppTheme, AppColors, AppTypography, AppSemantic, AppMapPaint, AppSpacing, AppRadius, AppShadow
    base.ts            — Shared palette + typography skeletons, per-mode variants (light/dark)
    classic-light.ts   — `ClassicLight` preset
    classic-dark.ts    — `ClassicDark` preset
    index.ts           — `THEMES` registry, `getTheme(id)`, default export
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
| `GET` | `/searchnearby?lat=&lng=` | Returns the single nearest POI/business to the given coordinates. Returns `404` when nothing is found nearby. Used by the map long-press flow. |

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

The middleware exposes two SSE streams:
- `/api/v1/vehicle_positions` — consumed by `lib/vehicleSSE.ts` (singleton).
- `/api/v1/stream/route?route_id=&time=` — consumed by `lib/routeSSE.ts` (per-instance).

### Route Save

```
BASE_URL = https://tranzit-route-save-000000000000.us-central1.run.app
# Set via EXPO_PUBLIC_ROUTE_SAVE_URL in .env.local
```

Manages active trip sessions. Used by `routes.tsx` and `commute.tsx`.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/trips` | Creates a trip session. Body: `{ route, origin, destination, device_id }`. Returns `{ session_id, ws_url }`. |
| `DELETE` | `/trips/{session_id}` | Ends a trip session. Called when the user taps "End Journey". |
| `WS` | `/trips/{session_id}/ws` | WebSocket connection. Receives `STATE`, `REROUTE`, `NOTIFY` messages. Sends `LOCATION`, `UNSURE_RESPONSE`, `RESUME`. |

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
| `stop_time_updates` | Per-stop arrival/departure times for a trip. `stop_id` maps to `calgary_transit_stops.teleride_number`. Times are unix epoch strings. `arrival_delay` / `departure_delay` in seconds (positive = late, negative = early). |
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

Singleton SSE connection to the vehicle positions stream. Shared across `map.tsx` and `commute.tsx` without opening two connections.

**Architecture:**
- Module-level `_es` holds the single `EventSource`.
- `_refCount` tracks how many React components are subscribed. The connection opens on first subscribe and closes when `_refCount` drops to zero.
- Vehicles are stored in a `Map<string, VehiclePosition>` keyed by `vehicle_id`. SSE delta events patch only affected entries. A `_snapshot` array is rebuilt on every event and broadcast to all subscribers as a fresh reference.
- `_vehicleMap` is **not** cleared on `closeSSE()` because React Strict Mode can briefly drop ref-count to 0 during development remounts.
- `isValidVehicle()` only requires `vehicle_id`, `latitude`, and `longitude` — `route_id` and `trip_id` may be absent for vehicles between trips (deadheading, layover). Filtering on those would drop ~90% of the live fleet.

**Events:**
- `snapshot` — full vehicle list on connect. Resets the map.
- `update` — delta with `added`, `updated`, `removed` arrays.

**Exported API:**
```typescript
// Subscribe to live vehicle positions. Returns a fresh VehiclePosition[] on every SSE event.
const vehicles = useVehicles();

// Convert the vehicle array to a GeoJSON FeatureCollection for a MapLibre GeoJSONSource.
const geoJSON = vehiclesToGeoJSON(vehicles);
```

`vehiclesToGeoJSON` produces features with properties `{ vehicle_id, trip_id, route_id, bearing }` and `Point` geometry. The map's symbol layer reads `bearing` for icon rotation and `route_id` for the text label. Missing `trip_id`/`route_id` are emitted as empty strings so MapLibre never reads `undefined`.

Do not call `useVehicles()` conditionally — the ref count management requires symmetric mount/unmount.

---

### `lib/routeSSE.ts`

Per-instance SSE hook for live stop-level GTFS-RT updates on a specific transit line.

**Exported API:**
```typescript
const stops = useRouteLiveStops(routeId, timeEpoch);
// Returns Map<string, RouteSSEStop> keyed by stop_id
```

Each call site creates its own `EventSource`. The SSE endpoint is `/api/v1/stream/route?route_id={routeId}&time={timeEpoch}`. Events are `snapshot` and `update`.

`RouteSSEStop` includes server-computed `arrival_delay` and `departure_delay` (seconds). Consumers should prefer these over client-side diffing.

**Nuance:** This is intentionally **not** a singleton because each transit leg in a journey needs its own route-specific stream. `RoutePickerSheet.tsx` uses this to render live delay badges on transit chips.

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
| `setTripSession` / `getTripSession` | The active WebSocket session (`{ sessionId, wsUrl }`). |
| `clearJourney()` | Nulls `_selectedRoute` and `_tripSession` only. Routes/origin/destination stay intact for restoration. Call this when ending a journey. |
| `clear()` | Full reset. Use on logout or hard reset. |

**Why not Context/Zustand?** This data is shared across three tabs that aren't in a parent-child relationship. A module singleton is simpler and avoids prop drilling through the navigator.

---

### `lib/tripWebSocket.ts`

WebSocket client for the Route Save backend. Manages connection, reconnection with exponential backoff, `RESUME` logic, and an out-of-component message outbox.

**Architecture:**
- Module-level `_activeWs` and `_outbox` array. The outbox lets code outside the hook (e.g., push-notification action handlers in `app/_layout.tsx`) queue an `UNSURE_RESPONSE` even when the commute screen is not mounted.
- `submitUnsureResponse(stopId, boarded)` is exported at module level and pushes to `_outbox`. The outbox is flushed on the next socket open.
- Reconnection uses exponential backoff: `[1000, 2000, 4000, 8000, 16000, 30000]` ms.
- On reconnect, sends `RESUME` with `lastSessionId`, `lastVersion`, and `lastLocation` so the server can catch up.
- Clock skew correction: on every `STATE` message, if a reference stop with positive `time_remaining_s` is found, `clockOffsetRef` is updated so `sendLocation` timestamps can be adjusted.
- Version deduplication: incoming `STATE` messages with `version <= prev` per-session are ignored.
- Multi-session merge: the server may send state for multiple sessions. `mergeSessionStates` flattens them into one view using `STATUS_PRIORITY` (`ACTIVE: 4 > UNSURE: 3 > EXPECTED: 2 > MISSED: 1 > COMPLETED: 0`).

**Exported API:**
```typescript
const { tripState, lastReroute, lastNotify, isConnected, sendLocation, sendUnsureResponse, disconnect } = useTripWebSocket(wsPath);

// Imperative out-of-component sender (used by notification handlers)
submitUnsureResponse(stopId, boarded);
```

---

### `lib/liveActivity.ts`

Cross-platform "live trip" UI: iOS Live Activities via `expo-live-activity`, and a persistent sticky notification on Android via `expo-notifications`.

**Exported API:**
```typescript
await setupTripProgressChannel();   // Android channel setup
await startTripActivity(input);       // Start live UI
await updateTripActivity(input);      // Update in-flight UI
await endTripActivity();              // Tear down
```

`TripActivityInput` includes `routeName`, `destination`, `currentStopName`, `nextStopName`, `etaMinutes`, `progressDots`, and `journeyFraction`.

**Nuance:**
- Every public function is wrapped in `try/catch` with an empty catch. A Live Activity crash must never kill the journey.
- Android uses `sticky: true` so the notification cannot be swiped away while the trip is active.
- Deep link on iOS: `tranzit://commute`.
- `progressDots` are rendered as Unicode circles: departed = `⬤`, current = `◉`, upcoming = `○`.

---

### `lib/boardingNotifications.ts`

Local push notifications that ask the user "Did you board the bus?" at critical stops.

**Exported API:**
```typescript
await setupBoardingChannel();         // Android channel
await registerBoardingCategory();     // iOS action category with Yes/No buttons
await scheduleBoarding(stopId, stopName, sessionId);  // Schedules immediate + 60s follow-up
await cancelBoarding(stopId);         // Cancels and dismisses both
```

**Nuance:**
- Two notifications are scheduled per stop: slot `0` (immediate) and slot `60` (delayed). Both share the same `stopId` and `sessionId` in their payload data.
- `cancelBoarding` calls both `cancelScheduledNotificationAsync` and `dismissNotificationAsync` for both IDs, ensuring the notification disappears even if it has already fired.
- Permissions are requested inside `scheduleBoarding`; if denied, the function silently returns.
- The root layout (`app/_layout.tsx`) listens for notification responses and calls `submitUnsureResponse()` via the trip WebSocket outbox.

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
| `getStopNamesByTelerideNumbers()` | Map lookup from teleride numbers to stop names. |
| `getStopsByTelerideNumbers()` | Full row lookup by teleride number. |

**Nuance:**
- `CREATE INDEX` must be a separate `execAsync` from `CREATE TABLE` because SQLite does not allow index creation inside a multi-statement string that also contains table creation.
- `transit_stops_cache` strips `create_dt_utc` and `mod_dt_utc` on read because they aren't needed client-side.
- `getStopNamesByTelerideNumbers` builds a dynamic `IN (...)` clause with `?` placeholders. It returns a `Map<string, string>` where the key is `String(teleride_number)`.

---

## 6. Contexts

### `contexts/ThemeContext.tsx`

Provides `{ theme, themeId, setThemeId }` to the entire app.

- `themeId` is persisted in `expo-secure-store` under key `tranzit_theme_id` (default `"classic-light"`).
- `theme` is the resolved `AppTheme` struct — contains `colors`, `typography`, `semantic`, `spacing`, `radii`, `shadow`, and `mapPaint`. Components destructure what they need.
- `setThemeId(id)` is a pure setter; persistence happens in a separate `useEffect`.
- Almost every screen and component consumes this via `useTheme()`.

**Adding a new theme:** Create a new file in `styles/themes/` (e.g. `high-contrast.ts`) that exports an `AppTheme` object, then register it in `THEMES` in `styles/themes/index.ts`. Surface it as a chip in `app/settings.tsx` (currently shows `classic-light` and `classic-dark`).

**Map style implication:** Every MapLibre `mapStyle` prop reads from `theme.mapPaint.baseStyle`. Every paint expression (stop circle, bus label, polyline split, timeline match) reads from `theme.mapPaint.*` — so the entire map restyles when the theme switches.

---

## 7. Screen Architecture

### `app/(tabs)/map.tsx` — Map Screen

The most complex screen. Built on **`@maplibre/maplibre-react-native`** (MapLibre). All map rendering — tiles, stops, buses — goes through MapLibre's GPU pipeline, not through React Native's view tree.

**Responsibilities:**
- Renders the MapTiler base layer: Positron (light) or Dataviz-Dark (dark) depending on `isDark` from `ThemeContext`.
- Renders transit stop markers as a GPU-rendered `<GeoJSONSource>` + `<Layer type="circle">`.
- Renders live bus positions as a `<GeoJSONSource>` + `<Layer type="symbol">` with a custom `tranzitBus` PNG icon + route-number text label.
- Native blue-dot + heading indicator via `<UserLocation heading={true} animated={true} />`.
- Bottom sheet with **three** snap points: collapsed (28% height), expanded (62%), full (79%). Driven by a `PanResponder` on `sheetAnim` (an `Animated.Value`).
- `SearchSheet` overlay for destination search.
- Quick Access chips from SQLite (user's saved default places).
- Long-press flow → `/searchnearby` → show `PlaceDetailsPanel` or "No places found nearby".
- Nearby Stops section (visible in expanded/full sheet) — tile-filtered list of up to 20 stops near the user's current location.
- Cross-panel navigation: stop panel → tap arrival row → fly to bus; bus panel → tap stop row → fly to stop.
- Place details panel when a nearby place or quick-access chip is selected.

**Map bounds / zoom:**

```typescript
const CALGARY_MAX_BOUNDS: [number, number, number, number] = [-115.5, 50.147, -112.645, 51.943];
const MIN_MARKER_ZOOM = 12; // stops and buses hidden below this zoom (GPU minzoom)
```

**Stop rendering (GeoJSON):**
`stopsGeoJSON` is a `useMemo` that converts `transitStops` to a `FeatureCollection`. WKT validation happens here — bad rows return `null` and are filtered out before the GeoJSON is handed to the `GeoJSONSource`. The `Layer` has `minzoom={MIN_MARKER_ZOOM}` so the GPU discards circles below zoom 12 at zero JS cost.

**Stop filtering:**
Only stops with a scheduled arrival in the last 5 minutes or `arrival_time = -1` (no data) are shown. This caps the active stop count to ~500–800 from the full ~3000 active stops.

**Bus rendering (GeoJSON + symbol layer):**
`vehiclesGeoJSON` is built from `useVehicles()` via `vehiclesToGeoJSON()` inside a `useMemo`. The symbol layer reads `bearing` for icon rotation (`"icon-rotation-alignment": "map"`) and `route_id` for the overlaid text label. MapLibre diffs the `FeatureCollection` natively on the C++ side — no React unmount/remount on vehicle updates.

**Layer-press handlers:**
`handleStopLayerPress` and `handleBusLayerPress` receive MapLibre feature events from `GeoJSONSource.onPress`. They pull properties from `event.nativeEvent.features[0]` and call the existing state setters. A `layerTappedRef` flag prevents the subsequent `onMapPress` event (same touch) from immediately deselecting the item that was just selected.

**Nearby Stops (tile math):**
`nearbyTransitStops` is a `useMemo` that computes the user's slippy-map tile at zoom 15, builds a 3×3 tile grid, and filters `transitStops` to those whose WKT coordinate falls in that grid (up to 20). Pure math — no network call. Displayed in the expanded/full bottom sheet under "Nearby Stops".

**Cross-panel navigation:**
- `handleBusTapFromStop(tripId)` — called from `StopDetailsPanel` when the user taps an arrival row. Finds the live vehicle in the `vehicles` array by `trip_id` and flies the camera to it.
- `handleStopTapFromBus(telerideNumber, stopName)` — called from `BusDetailsPanel` when the user taps a stop row. Looks up the stop coordinate first in the filtered active set, then falls back to the full SQLite cache, and flies the camera.

**Map gestures:**
- `onMapPress` — deselects active panels on empty-space taps. Skipped if `layerTappedRef` is set.
- `onMapLongPress` — fires the `/searchnearby` lookup and drops a pin at the tapped coordinate.

**Camera:**
Uses `CameraRef` + `cameraRef.current?.flyTo({ center, zoom, duration })`. The `flyTo` callback is defined before the layer-press handlers to avoid a temporal dead zone error (TDZ — `const flyTo` would not be hoisted).

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
`handleStart` does the following:
1. POSTs to `EXPO_PUBLIC_ROUTE_SAVE_URL` (`/trips`) to create a server-side trip session.
2. Receives `{ session_id, ws_url }`.
3. Stores them in `routeStore.setTripSession()`.
4. Writes the selected route and endpoints to `routeStore`.
5. Navigates to `/(tabs)/commute`.

An `AbortController` (`routeAbortRef`) cancels in-flight route requests. `isStarting` state disables the UI during session creation.

---

### `app/(tabs)/commute.tsx` — Active Journey Screen

The most complex screen. Reads from `routeStore` via `useFocusEffect` — called unconditionally so that `clearJourney()` correctly resets the screen when returning from a completed journey.

**Features:**
- **WebSocket state machine:** `useTripWebSocket(wsPath)` drives the entire UI. Handles `STATE` (stop list + ETA), `REROUTE` (route replacement + banner), `NOTIFY` (boarding confirmation prompt).
- **Map:** Small MapLibre map with a split-polyline GeoJSON layer: "completed" portion in primary color, "remaining" portion in the transit line color. Updates based on `currentStopIndex`.
- **Hero section:** Route name, destination, CO₂ badge, speed badge, ETA, and a journey progress bar.
- **Timeline:** `CommuteStop` list built from `tripState.stops` (server-driven). Statuses: `departed | current | unsure | upcoming | missed | destination`. The server determines status, not client-side proximity.
- **Boarding confirmation:** When `lastNotify` requires a response, shows a full-screen overlay with "Did you board?" Yes/No buttons. Also triggers a push notification via `boardingNotifications.ts`.
- **Rerouting:** When `lastReroute` arrives, shows a banner "Route changed — new trip computed" and replaces the route polyline.
- **Live Activities:** `startTripActivity` / `updateTripActivity` / `endTripActivity` are fully wired.
- **Community reports:** 2×3 grid of report categories (Crowded, Delay, Safety, Vandalism, Construction, Other). After selecting a category and severity (1–5), the user taps "Send" and sees a thank-you state.
- **Thank a Driver:** A dedicated button in the UI.
- **GPS tracking:** Watches position with `Location.watchPositionAsync` and throttles sends to the WebSocket (~5s interval).
- **End Journey:** DELETEs the trip session from the server, calls `routeStore.clearJourney()`, tears down Live Activity, and navigates to `/(tabs)/routes`.

**Cross-effect refs:** `boardingConfirmStopRef`, `tripStateRef`, `activityStartedRef` prevent stale closures across `useEffect`s.

**Nuance:** The timeline is built from `tripState.stops` (server) rather than from the static Google route. The server may inject `TRANSFER` stops that don't exist in the original route.

---

### `app/(tabs)/report.tsx` — Report Screen

A standalone community-reporting screen. Registered in the tab layout with `href: null`, so it is **not visible in the tab bar** but can be deep-linked or pushed onto the stack.

Presents a 2-column grid of report categories (Crowded, Delay, Safety, Vandalism, Construction, Other). After selecting a category and severity (1–5), the user taps "Send" and sees a thank-you state.

Pure local state (`selected`, `severity`, `sent`). No backend wiring yet.

---

### `app/(tabs)/saved.tsx` — Saved Places

Renders saved places grouped by category, sourced from SQLite via `useSavedPlaces()`. Allows marking a place as the default for its category (Quick Access chip source).

`categoryStyle()` maps category names to pastel colors and FontAwesome5 icons from `styles/theme.ts` `PASTELS`.

---

## 8. Components

### `components/stopViews.tsx`

**`parseWKTPoint(wkt: string)`** — Exported. Parses `POINT(lng lat)` and returns `{ latitude, longitude }` or `null`. Longitude is the first token (PostGIS standard). Called in `map.tsx` when building `stopsGeoJSON` to filter out malformed WKT rows before they reach the GPU layer.

**`StopDetailsPanel`** — Rendered as a plain React `View` inside `map.tsx`'s bottom sheet (not a map Callout). Shows upcoming and past arrivals for a stop, queried by `teleride_number`. Polls every 30 s while open. Accepts an `onBusTap(tripId)` callback — tapping an arrival row triggers cross-panel navigation to that bus.

`fetchStopSchedule` queries `stop_time_updates` with `stop_id = String(teleride_number)` and `schedule_relationship neq NO_DATA`. Deduplicates `trip_id`s, fetches matching `trip_updates` for `route_id`, splits into `upcoming` and `past`, and caps past entries to 5. `-1` is a sentinel value for "no data" in GTFS-RT. `isValidEpoch` requires `> 0`.

There is no longer a `StopMarker` component. Stop dots are rendered as a MapLibre GPU circle layer.

---

### `components/busViews.tsx`

**`BusDetailsPanel`** — Rendered as a plain React `View` inside `map.tsx`'s bottom sheet. Accepts `vehicleId`, `routeId`, `tripId` props (sourced from the MapLibre feature properties when the user taps the bus symbol layer). Fetches the full trip stop sequence and the route long name. Shows passed stops as dimmed rows with a "Passed" pill. Accepts an `onStopTap(telerideNumber, stopName)` callback for cross-panel navigation to a stop.

Fetches `stop_time_updates` by `trip_id` (ordered by `stop_sequence ASC`) and `calgary_transit_routes` by `route_short_name` in parallel. Resolves stop names via `getStopNamesByTelerideNumbers(numericIds)` from SQLite. Converts `stop_id` strings to integers via `parseInt` (join boundary). Delay formatting: `< 60s` = "On Time", `> 0` = red `+N min`, `< 0` = blue `N min early`.

There is no longer a `PooledBusMarker` component. Bus icons are rendered as a MapLibre GPU symbol layer.

---

### `components/placeViews.tsx`

**`PlaceDetailsPanel`** — Not in the original docs. Displays rich place details inside the map screen's bottom sheet. Shows open/closed status, rating, phone number, website, and full weekday opening hours. Includes a "Directions" footer button.

- Computes today's weekday index manually: Google API returns `weekdayDescriptions` with index 0=Monday, while JS `Date.getDay()` has 0=Sunday.
- Phone link strips spaces/parentheses and uses `Linking.openURL('tel:…')`.
- Website is stripped of `https://` and trailing slash for display.
- Uses `ScrollView` from `react-native-gesture-handler` (not plain RN) nested inside a fixed-height `View` (200px) so it scrolls correctly inside the bottom sheet.
- `onBack` prop supports a two-level panel stack (e.g. nearby results → place details).

---

### `components/SavePlaceModal.tsx`

Two-phase bottom-sheet modal for saving a place to a category.

**Phase 1 — Search:** Uses `TranzitApiService.getAutocompletePredictions()` (debounced 400 ms) to populate a `FlatList` of `AutocompletePrediction` results. Displays `structured_formatting.main_text` / `secondary_text`. Tapping a result fetches `/details` with a loading spinner (`isResolvingSelection`). Selection errors are shown inline below the list.

**Phase 2 — Details:** Shows a place card, an optional label input, a category chip picker (with a "+ New" chip to create a new category inline), a default toggle ("Set as default for this category"), and a Save button.

If `preselectedPlace` is passed (e.g., when saving from a place card already shown on the map), the modal opens directly in Phase 2.

Save flow: `upsertPlace()` → `linkPlaceToCategory()` (atomic default-clear + upsert).

---

### `components/routes/RoutePickerSheet.tsx`

Displays a scrollable list of route cards. The selected route gets a blue border and light-blue background (`cardSelected` style). The first route gets a "Fastest" badge regardless of selection. Accepts `selectedRoute` prop for reference-equality comparison.

**`normalizeColor(color: string)`** — Exported. Prepends `#` if the transit line color from the API is missing it (the Google Routes API sometimes omits the `#`).

**`formatDuration(dur: string)`** — Converts `"1860s"` to `"31 min"` or `"1h 5m"`.

**`formatDistance(meters: number)`** — Converts meters to `m` or `km`.

**`condense(steps: RouteStep[])`** — Collapses consecutive `WALK` steps into a single walk icon so the chip row stays compact.

**`TransitChipLive`** — Renders a transit line chip with a **live delay** pulled from `useRouteLiveStops(nameShort, deptEpoch)`. Matches the SSE stop to the step's departure stop by minimizing `abs(lat diff) + abs(lng diff)`. Delay priority: `departure_delay` > `arrival_delay` > computed diff. Guards against `-1` sentinel. **Must be a real component** (not a function inside render) because it calls a hook.

**`StepChips`** — Horizontal row of walk icons + transit chips with live delays.

---

### `components/search/SearchSheet.tsx`

The map screen's search overlay. Uses `useDestinationSearch` internally. Calls `onSearchActiveChange(true)` when the user focuses the field (map screen snaps the bottom sheet to expanded). Calls `onDestinationSelected` when a result is chosen.

If `suggestion.location` exists (from `/search`), uses it immediately; otherwise fetches `/details` for autocomplete results. If the details fetch fails, it logs and returns early without selecting anything.

---

## 9. Hooks

### `useDestinationSearch(userLocation?)`

Dual-source destination search for the Routes screen. Two timers per keystroke:
1. **Instant** (150 ms): `GET /search` — fast, covers POIs and businesses. Skipped if query starts with a digit.
2. **Autocomplete** (600 ms, or 300 ms for address queries): `GET /autocomplete/json` — covers street addresses.

Results are merged in a `Set` deduplicating by `placeId`. Instant results appear first, autocomplete results fill in after.

`SearchSuggestion` shape: `{ placeId, mainText, secondaryText, location? }`. Location is only populated for `/search` results. Autocomplete results need a `POST /details` call to get coordinates.

The `userLocation` is appended to `/search` as `lat`/`lng` bias params. It is **not** sent to `/autocomplete/json`.

---

### `usePlacesSearch(userLocation?)`

Simpler single-source search for the map's `SearchSheet`. One debounce timer (350 ms), one abort controller. State machine: `idle | loading | success | empty | error`.

Unlike `useDestinationSearch`, this does NOT call `/autocomplete/json`. It is the simpler "map search" path.

---

### `useSavedPlaces()`

Reads all saved places from SQLite via `getSavedPlacesGrouped()`. Exposes `markDefault(categoryId, placeId)` which updates SQLite and re-fetches.

### `useQuickAccess()`

Reads only `is_default=1` places via `getDefaultPlaces()`. Used by the map screen for Quick Access chips. Exposes `refresh()` (increments a tick to re-run the effect). Errors are silently ignored (`catch(() => {})`).

---

## 10. Types

### `types/places.ts`

Core contract types for search and routing:

| Type | Purpose |
|------|---------|
| `AutocompletePrediction` | Shape from `GET /autocomplete/json`. Has `place_id`, `description`, and `structured_formatting.{ main_text, secondary_text }`. Used directly by `SavePlaceModal`. |
| `SearchSuggestion` | Unified shape from both `/search` and `/autocomplete/json`. |
| `PlaceResult` | Single result from `GET /search`. |
| `PlaceDetails` | Extends `PlaceResult` with optional rating, hours, phone, etc. from `POST /details`. |
| `SelectedDestination` | What gets passed to the map after a search selection: `placeId`, `displayText`, `coordinate`. |
| `Route` | Top-level route object from `POST /route`. Always has `polyline.encodedPolyline`. |
| `RouteLeg` | One leg of a route. Contains `steps: RouteStep[]`. |
| `RouteStep` | Single step with `travelMode: "WALK" | "TRANSIT"`. Walk steps have no `transitDetails`. |
| `RouteTransitLine` | Transit line metadata: `name`, `nameShort`, `color`, `textColor`, `vehicle`, `agencies`. |
| `RouteStop` | Named stop with optional `location.latLng`. |

**Do not use step-level polylines for map rendering.** They are not always present in the API response. Use `route.polyline.encodedPolyline` (route-level) instead.

### `types/database.ts`

TypeScript interfaces for all 9 PostgreSQL tables plus the `Database` generic passed to `createClient<Database>`. All `.from()` calls are fully type-inferred.

The `Relationships: []` field is required on every table entry — without it, supabase-js v2's column-string inference resolves query result types to `never`.

Also requires empty `Views`, `Functions`, `Enums`, and `CompositeTypes` fields on the schema to satisfy supabase-js v2 inference.

### `types/trip.ts`

WebSocket trip session message types (not in original docs):

| Type | Purpose |
|------|---------|
| `ServerStopStatus` | Union: `"EXPECTED" | "ACTIVE" | "COMPLETED" | "UNSURE" | "MISSED"`. |
| `TripStop` | Stop in a trip session. `stop_id`, `stop_name`, `route_id`, `stop_type` (`FETCHED` or `TRANSFER`), `status`, `time_remaining_s`, `eta` (unix seconds), `lat`, `lng`. |
| `TripStateMsg` | WebSocket state message. `type: "STATE"`, `session_id`, `version`, `overall`, `stops: TripStop[]`. |
| `TripRerouteMsg` | WebSocket reroute message. `type: "REROUTE"`, `reason`, `from` coordinate, `route` (from `places.ts`), `legs` array. |
| `TripNotifyMsg` | WebSocket notification. `type: "NOTIFY"`, `kind`, `stop_id`, `requires_response`, `message`. |
| `TripSession` | Session metadata. `sessionId`, `wsUrl` (WebSocket path, e.g. `/trips/…/ws`). |

---

## 11. Critical Constraints & Known Gotchas

### MapLibre vs. react-native-maps

The map layer was migrated from `react-native-maps` to `@maplibre/maplibre-react-native`. The old Fabric interop crash rules (nil child insertion, stagger pattern, constant native child count) **no longer apply** to stop and bus markers — those are now GPU-rendered GeoJSON layers. The `PooledBusMarker` and `StopMarker` React components no longer exist. However, `<Marker>` is still used for the single destination pin (one instance is cheap).

### WKT coordinate order

PostGIS stores `POINT(lng lat)` — longitude first. `parseWKTPoint` in `stopViews.tsx` is correct. Do not invert the tokens. When converting to GeoJSON geometry, coordinates must be `[longitude, latitude]` (GeoJSON spec, same as MapLibre).

### `layerTappedRef` double-fire guard

MapLibre fires both a `GeoJSONSource.onPress` and a `Map.onPress` for the same touch. Without the `layerTappedRef` flag, pressing a stop or bus would select it and immediately deselect it (via `onMapPress`). `handleStopLayerPress` / `handleBusLayerPress` set `layerTappedRef.current = true`; `onMapPress` checks it and skips deselection, then resets the flag.

### `flyTo` must be declared before layer-press handlers

`flyTo` is a `useCallback` with an empty dependency array. Both `handleStopLayerPress` and `handleBusLayerPress` close over `flyTo`. Because `const` declarations are not hoisted, `flyTo` must appear in the source file *above* any callback that references it. Moving `flyTo` below its dependents causes a TypeScript TS2448/TS2454 temporal dead zone error.

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

### `SavePlaceModal` search uses autocomplete, not `/search`

`SavePlaceModal` calls `getAutocompletePredictions()` (not `searchPlaces()`). This intentionally covers street addresses, which `/search` misses. The raw prediction has no coordinates — a `/details` fetch is required on selection before advancing to Phase 2. The `isResolvingSelection` spinner covers this latency.

### WebSocket outbox pattern

`submitUnsureResponse` in `lib/tripWebSocket.ts` is exported at module level and can be called from anywhere (e.g., a push-notification action in the root layout). The message is queued in `_outbox` and flushed on the next socket open. There is **no REST fallback** for this action.

### Live Activity failures are swallowed

Every public function in `lib/liveActivity.ts` is wrapped in `try/catch` with an empty catch. A Live Activity crash must never kill the journey.

### Dark mode map styles

Map style URL is not static — it switches between Positron (light) and Dataviz-Dark (dark) based on the active theme. `STYLE_URL` is now `theme.mapPaint.baseStyle`, defined in `styles/themes/base.ts` as `LIGHT_MAP_PAINT.baseStyle` / `DARK_MAP_PAINT.baseStyle` (built from `EXPO_PUBLIC_MAPTILER_KEY`).

### Notification category setup

`app/_layout.tsx` registers `BOARDING_CATEGORY` with action buttons "Yes, I boarded" and "I missed it". On response, it calls `submitUnsureResponse()` and cancels the notification. This must happen before any trip starts because categories cannot be registered after the first notification is received.

### TransitChipLive must be a real component

`TransitChipLive` inside `RoutePickerSheet` calls `useRouteLiveStops`, which is a hook. It must be a real React component (not a function called inside render), otherwise React will throw a hooks violation.

### Route Save session creation

Starting a journey is not just a local state change. `routes.tsx` must POST to `EXPO_PUBLIC_ROUTE_SAVE_URL` to create a session before navigating to Commute. The Commute screen then reads `routeStore.getTripSession()` to open the WebSocket. If the session is missing, the Commute screen shows an empty state.

### `report.tsx` is hidden

`app/(tabs)/report.tsx` is registered in the tab layout with `href: null`. It does not appear in the tab bar but can be navigated to via `router.push('/(tabs)/report')` or deep link.

### `settings.tsx` is a top-level screen

The settings screen is at `app/settings.tsx` (flat file), not `app/settings/index.tsx`.

### `useQuickAccess` silently ignores errors

The catch block in `useQuickAccess` is empty (`catch(() => {})`). If SQLite fails, the Quick Access chips simply won't appear — no error UI is shown.

### Google weekday index mismatch

`PlaceDetailsPanel` computes today's weekday index manually because Google Places API returns `weekdayDescriptions` with index 0=Monday, while JavaScript `Date.getDay()` has 0=Sunday.

### SQLite index creation

`CREATE INDEX` must be a separate `execAsync` from `CREATE TABLE` because SQLite does not allow index creation inside a multi-statement string that also contains table creation.

---

## Appendix: Environment Variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `EXPO_PUBLIC_SUPABASE_URL` | `lib/supabase.ts` | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `lib/supabase.ts` | Supabase anon key (safe to bundle; RLS enforces access) |
| `EXPO_PUBLIC_USE_LOCAL` | `services/TranzitApiService.ts` | Set to `"true"` to target `localhost:3100` |
| `EXPO_PUBLIC_MAPTILER_KEY` | `app/(tabs)/map.tsx` | MapTiler API key for the Positron/Dataviz-Dark tile styles. Without this, `STYLE_URL` is undefined and the map renders blank. |
| `EXPO_PUBLIC_ROUTE_SAVE_URL` | `app/(tabs)/routes.tsx`, `lib/tripWebSocket.ts` | Route Save service URL. Used for trip session creation and WebSocket connections. |

Never commit `.env.local`. Never expose the Supabase Service Role key in the RN bundle.

---

## 12. Toolchain & Build Setup

### Package manager — bun

The project uses **bun** (not npm or yarn). The lockfile is `bun.lock` (text format).

```bash
bun install          # install dependencies
bun run ios          # → expo run:ios  (local Xcode build + install to simulator/device)
bun run android      # → expo run:android
bun run start        # → expo start (Metro bundler)
bunx expo run:ios    # equivalent one-liner without the npm script
```

Do not commit `package-lock.json` or `yarn.lock`. If either appears after an accidental `npm install`, delete it and re-run `bun install`.

### iOS native builds

**Bundle identifier:** `com.anonymous.tranzit`  
**Deep-link scheme:** `tranzit`  
**Display name (CFBundleDisplayName):** `Tranzit`  
**Live Activities:** Enabled (`NSSupportsLiveActivities` and `NSSupportsLiveActivitiesFrequentUpdates` in `Info.plist`).

After any change to `ios/` dependencies (adding a native module, updating Pods):

```bash
cd ios && pod install && cd ..
bun run ios
```

**ccache** is enabled (`apple.ccacheEnabled: true` in `ios/Podfile.properties.json`). Install it once to activate the cache:

```bash
brew install ccache
```

Subsequent native recompiles will be significantly faster once the cache is warm.

### Android native builds

**Application ID / namespace:** `com.anonymous.tranzit`  
**App label:** `Tranzit` (from `android/app/src/main/res/values/strings.xml`)  
**Edge-to-edge:** Enabled (`edgeToEdgeEnabled: true`).  
**Permissions:** `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `POST_NOTIFICATIONS`.

```bash
bun run android      # builds and installs debug APK on connected device/emulator
```

### App identifiers at a glance

| Field | Value |
|---|---|
| Expo slug | `tranzit` |
| iOS bundle ID | `com.anonymous.tranzit` |
| Android package | `com.anonymous.tranzit` |
| Deep-link scheme | `tranzit` |
| Display name | `Tranzit` |

### New Architecture

`newArchEnabled: true` in `app.json`. The app runs on React Native's New Architecture (Fabric + TurboModules). MapLibre is Fabric-compatible.

### React Compiler

`reactCompiler: true` in `app.json` experiments. The React Compiler is enabled for automatic memoization.

### Key native plugins

| Plugin | Purpose |
|--------|---------|
| `expo-router` | File-based routing |
| `expo-splash-screen` | Splash screen |
| `expo-location` | GPS permissions |
| `expo-secure-store` | Secure storage for auth tokens and dark mode preference |
| `expo-sqlite` | Local SQLite database |
| `@maplibre/maplibre-react-native` | Map rendering |
| `expo-live-activity` | iOS Live Activities |
| `expo-notifications` | Push notifications |
