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

- **Route Service** (`tranzit-route-service`) — Go microservice wrapping Google Maps Routes/Places APIs and OpenTripPlanner (OTP).
- **DB Middleware** (`tranzit-db-middleware`) — REST+SSE service exposing the PostgreSQL transit database to the client.
- **Route Save** (`tranzit-route-save`) — WebSocket+REST service managing active trip sessions, live tracking, rerouting, and boarding confirmation.

The app has five visible tabs: **Map**, **Routes**, **Commute**, **Planner**, and **Saved**, plus a hidden **Report** tab (`href: null`). 

The standard flow is: user searches a destination on Map or Routes → route is computed via OTP (fallback to Google Maps) → user starts a journey → a server-side trip session is created → Commute screen takes over with live WebSocket tracking, push notifications, iOS Live Activities, and community reporting.

The **Planner** flow allows users to map out and sequence their upcoming day's trips on an interactive 24-hour timeline. Planned trips calculate appropriate "leave-by" times and trigger push notifications to start heading to transit stops.

**Theme System:** All themable values (colors, fonts, sizes, weights, letter-spacing, line-height, MapLibre paint colors, semantic status colors) are defined as **preset struct objects** in `styles/themes/`. Two presets ship today: `classic-light` and `classic-dark`. To add a new theme: drop a file in `styles/themes/` that implements `AppTheme` and register it in the `THEMES` map in `styles/themes/index.ts`. The active theme is selected via `ThemeContext` and exposed as a single `useTheme()` hook returning the full `AppTheme` object (no `isDark` boolean — use `theme.isDark` if needed). Map base layer, polyline colors, stop circle paint, bus label halo, and category icon palette are all part of the theme and switch with it.

**Live Architecture:** The Commute screen is a state machine driven by WebSocket messages (`STATE`, `REROUTE`, `NOTIFY`). It integrates GPS tracking, push notifications for boarding confirmation, iOS Live Activities, and Android sticky notifications.

---

## 2. Directory Map

```
app/
  (tabs)/
    map.tsx          — Main map screen with bottom sheet, live markers, search
    routes.tsx       — Route planning: origin/destination inputs + route picker sheet
    commute.tsx      — Active journey screen with WebSocket state machine
    planner.tsx      — Travel planner: interactive 24-hour daily timeline
    saved.tsx        — Saved places management
    report.tsx       — Community reporting (hidden from tab bar)
    _layout.tsx      — Tab bar configuration + custom HeaderBar (Planner tab registered)
  _layout.tsx        — Root layout (ThemeProvider, notification handlers, leave-by channel setup)
  add-trip.tsx       — Add trip screen for the Planner timeline
  index.tsx          — Splash/redirect entry point
  settings.tsx       — Settings screen (theme selector and dark mode toggle)

components/
  stopViews.tsx      — StopDetailsPanel (transit stop bottom-sheet panel)
  busViews.tsx       — BusDetailsPanel (live bus bottom-sheet panel)
  placeViews.tsx     — PlaceDetailsPanel (place card with hours/rating/phone)
  horizontalView.tsx — Horizontal scroll row utility
  SavePlaceModal.tsx — Modal for saving a place to a category
  MarqueeText.tsx    — Automated scrolling marquee for overflowing textboxes
  planner/
    Stepper.tsx         — Stepper utility to adjust minutes/hours in Add Trip
    TripDetailSheet.tsx — Detailed edit/delete drawer for planned trips
    TripEventCard.tsx   — Interactive daily timeline cards supporting drag-to-shift
    trip.ts             — Models, mutations, and formatters for planned trips
  routes/
    RoutePickerSheet.tsx   — Scrollable route card list with dynamic chips & travel times

lib/
  supabase.ts        — Supabase client singleton (typed against Database)
  middleware.ts      — Typed REST client for the DB middleware service
  config.ts          — Hardcoded backend URLs (ROUTE_SAVE_URL)
  vehicleSSE.ts      — Incremental SSE hook for live bus positions with culling & throttling
  routeSSE.ts        — Per-route SSE hook for live stop-level delays
  transitStopsCache.ts — Orchestrates middleware fetch → SQLite write
  routeStore.ts      — In-memory session store for the active journey
  tripWebSocket.ts   — WebSocket client for trip session lifecycle
  liveActivity.ts    — iOS Live Activities + Android sticky notifications
  leaveByNotifications.ts — Local notification scheduler for scheduled departures
  routeRanking.ts    — OTP itinerary sorting and multi-line chip grouping
  routeParser.ts     — Unified routing parser backing Google Maps and OpenTripPlanner (OTP)
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
| `POST` | `/route` | Computes transit routes. Body: `{ origin: {lat, lng}, destination_id: string }`. Returns `204` when no transit route exists. OTP itineraries returned under `otpItineraries`. |
| `GET` | `/searchnearby?lat=&lng=` | Returns the single nearest POI/business to the given coordinates. Returns `404` when nothing is found nearby. Used by the map long-press flow. |

**Important:** OpenTripPlanner (OTP) is the default active engine in the app. Google Maps is wired as a commented standby block in `app/(tabs)/routes.tsx`. When OTP is active, routing uses `/route` and returns `otpItineraries` which are normalized into a unified `Route` shape by `lib/routeParser.ts`.

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
ROUTE_SAVE_URL = https://tranzit-route-save.tailnet-example.ts.net
```

Manages active trip sessions. Used by `routes.tsx` and `commute.tsx`. It is **hardcoded** in `lib/config.ts` (bypassing `.env.local` constraints for production Tailscale accessibility).

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/trips` | Creates a trip session. Body for OTP: `{ source: "opentrip", route: rawItinerary, destination: {lat, lng} }`. Google fallback body: `{ route, origin, destination, device_id }`. Returns `{ session_id, ws_url }`. |
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

### Travel Planner Storage (Future Integration)

Planned trips are currently mock-modeled in `SAMPLE_TRIPS` within `components/planner/trip.ts`. The schema uses minutes-from-midnight boundaries (`departMin`, `arriveMin`, `eventEndMin`). 
- **Future Integration:** Plans are in place to back this with a user-specific trips store — a Supabase table keyed by `user_id` mirrored into `expo-sqlite` for offline caching, and calculating real transit timing via `TranzitApiService.getRoute`.

---

## 5. Core Libraries (`lib/`)

### `lib/config.ts`

Central configuration file holding hardcoded backend URLs. Avoids environment file mismatch on production.
```typescript
export const ROUTE_SAVE_URL = "https://tranzit-route-save.tailnet-example.ts.net";
```

---

### `lib/supabase.ts`

Singleton Supabase client typed against `Database` from `types/database.ts`. Auth tokens are stored in `expo-secure-store` (not `AsyncStorage`) for security. `detectSessionInUrl: false` is required for React Native.

```typescript
import { supabase } from '@/lib/supabase';
const { data } = await supabase
  .from('vehicle_positions')
  .select('vehicle_id, latitude, longitude')
  .eq('route_id', '3');
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

Singleton SSE connection to the vehicle positions stream. Shared across `map.tsx` and `commute.tsx` without opening multiple connections.

**Performance Overhaul:**
- **Incremental Snapshots:** Vehicles are stored in a `Map<string, VehiclePosition>` keyed by `vehicle_id`. Incoming SSE delta events patch entries directly. The active `_snapshot` array is maintained incrementally (swap-remove + in-place update, $O(\text{changed})$ operations) instead of rebuilding/revalidating all ~3k vehicles on every frame.
- **Throttling:** Broadcasts to React subscribers are coalesced through a `200ms` trailing-edge throttle, preventing React commit thrashing during reconnection burst periods.
- **Route-specific Subscriptions:** Added `useVehiclesForRoutes(routeIds)` hook. It filters active vehicles in-store and returns a stable reference if selected buses haven't moved, preventing the 2,500-line Commute screen from re-rendering on off-route vehicle ticks.
- Stale updates that null out coordinates are discarded, ensuring dead-headed or out-of-service buses are cleanly purged from the viewport list.

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

---

### `lib/leaveByNotifications.ts`

Schedules regional "Start heading to {stop} now" notifications on local devices matching planned travel timelines.
- **Rescheduling Logic:** Local alerts are only re-queued if transit ETA drifts by more than `60 seconds`.
- **Cancellation Logic:** Automatically clears scheduled alerts once boarding is confirmed or the active journey is terminated.
- Channels are registered globally at the root layout `app/_layout.tsx`.

---

### `lib/routeRanking.ts`

Custom OpenTripPlanner utility library.
- Sorter: sorts itineraries ascending by arrival time (earliest first).
- Grouper: parses transit steps into grouped multi-bus line categories (e.g. combined labels like `"201+30"`).
- Fastest Badge: Identifies the quickest transit itinerary by computing earliest arrival relative to departures, rather than picking index `0`.

---

### `lib/routeParser.ts`

The dual-router parser. Merges Google Maps Route and OpenTripPlanner (OTP) layouts into a single, standardized `Route` shape:
- Google Maps paths are flagged as `source: "google-maps-api"`.
- OTP itineraries are parsed via `otpItineraryToRoute()`, flagged as `source: "opentrip"`, and retain raw OTP structures on the `.otpItinerary` property.

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

---

### `lib/liveActivity.ts`

Cross-platform "live trip" UI: iOS Live Activities via `expo-live-activity`, and a persistent sticky notification on Android via `expo-notifications`.

---

### `lib/boardingNotifications.ts`

Local push notifications that ask the user "Did you board the bus?" at critical stops.

---

### `lib/db.ts`

All SQLite operations. Opens the database once (`getDb()` singleton). Runs `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON` on first open.

---

## 6. Contexts

### `contexts/ThemeContext.tsx`

Provides `{ theme, themeId, setThemeId }` to the entire app.
- Almost every screen and component consumes this via `useTheme()`.
- Theme presets are defined in `styles/themes/` and registered in `styles/themes/index.ts`.
- Map base layers restyle entirely on theme switch via `theme.mapPaint.baseStyle`.

---

## 7. Screen Architecture

### `app/(tabs)/map.tsx` — Map Screen

Renders the primary visual map built on **`@maplibre/maplibre-react-native`**. All stop and vehicle representations are compiled directly inside GPU-rendered WebGL layers, completely decoupled from React Native's standard view-tree layout.

**Layout Updates:**
- Replaced custom PanResponder sheet with `@gorhom/bottom-sheet` exposing three snap points: collapsed (28%), expanded (62%), and full (79%). Uses `BottomSheetScrollView` for smooth gesture handover.
- **Viewport-Culling Optimization:** Tracks screen camera bounds dynamically inside `onRegionDidChange` (bounds: `[w,s,e,n]`). Culls the 3,000+ active fleet vehicles down to a 50%-padded viewport bounding box before creating GeoJSON properties. This reduces rendering allocation to only on-screen buses, while keeping the full fleet accessible for tapping and camera-fly actions.

---

### `app/(tabs)/routes.tsx` — Route Planning Screen

Origin and destination planners with autocomplete routing engine.

**Layout & Engine Updates:**
- Replaced Custom PanResponder bottom sheet with `@gorhom/bottom-sheet` using snap points `['14%', '50%', '90%']`. The "Start Journey" selector is pinned inside `BottomSheetFooter` to remain visible at all sheet positions.
- **OTP Routing Engine:** Routes are requested via OTP by default (fetching up to 10 itineraries with tighter cards).
- **Per-Leg Polyline Splitting:** Polylines are drawn per-leg (tagged transit vs walk): active transit is rendered in its native line color, unselected legs are faded, and walk legs are drawn as a thick dotted line via `mapPaint.polyline.walk` (dimmed when unselected).
- **Boarding Markers:** Derived route-boarding and exit coordinates are drawn on the map as dynamic circular markers via `stopsGeoJSON`.
- **Typing Reset:** Typing in input fields clears stale routes and clears `routeStore.setRoutes([])` to prevent focus-restore bugs.
- **Sticky GPS Location:** Displays a persistent "Current Location" row above origin suggestions whenever GPS coordinates are acquired.

---

### `app/(tabs)/commute.tsx` — Active Journey Screen

The trip progress tracking and telemetry HUD.

**UI & Countdown Updates:**
- **Pre-Boarding HUD:** Hero panel displays "Boarding {bus} / from {stop} / arrives in {X} min", linked to the boarding stop's live ETA.
- **Leave-by Countdowns:** Generates a "Leave by HH:MM" countdown chip (computed as departure ETA - walk duration - 3 min buffer). Disappears once boarding is confirmed.
- **Timeline Interleaving:** Walk steps and transfers (labeled "Transfer · walk to...") are interleaved directly into the timeline with duration and distance metrics.
- **Marquee Text Scrolling:** Replaced overflowing text lines in destination lists and stop cards with the `<MarqueeText>` component, allowing long stop names to scroll horizontally without layout clipping.

---

### `app/(tabs)/planner.tsx` — Travel Planner Screen

A 24-hour visual daily timeline (Gantt-chart-style timeline layout).
- Displays sequenced planned trips (`PlannedTrip`) calculated in minutes from midnight.
- **Visual Scale:** Layout scales using shared constants: `HOUR_HEIGHT = 60px` (y-axis scale), `GUTTER_WIDTH = 56px`.
- Interactivity: Trips are rendered inside `TripEventCard` components.
- Opens by default scrolled near the morning commute (Y offset: `8 * HOUR_HEIGHT - 20`).
- Selecting cards opens `TripDetailSheet` to modify or delete planning data.

---

### `app/add-trip.tsx` — Add Planned Trip Screen

Transactional modal form pushed from the Planner FAB.
- Let's users configure Destination, Origin, Timing Mode (`leave` or `arrive` target times), and Planned stay durations.
- Integrates custom `Stepper` components to slide minutes/hours easily.
- Calculates derived departures/arrivals based on configured travel estimates (currently `30m` placeholders).

---

## 8. Components

### `components/MarqueeText.tsx`

Self-contained scrolling text container.
- Measures text width dynamically vs container parent width.
- Triggers a smooth loop animation using `Animated` if text size exceeds layout boundaries.

---

### `components/planner/TripEventCard.tsx`

The interactive timeline layout card.
- Translates `departMin`, `arriveMin`, and `eventEndMin` into absolute pixel offsets (`top`, `height`).
- Uses custom gesture handlers or steppers to support dragging cards up and down the grid, translating delta movements into minutes and invoking `shiftTrip` to slide the schedule.

---

### `components/planner/TripDetailSheet.tsx`

Details overlay for planned items, supporting timing tweaks, mode toggles, and deletion.

---

### `components/planner/Stepper.tsx`

Reusable visual selector for time increments, utilizing plus/minus icons and snapping values to `SNAP_MIN = 5` increments.

---

## 9. Hooks

### `useVehiclesForRoutes(routeIds: string[])`

Custom selector wrapper around the live vehicle positions store.
- Returns a stable array reference if vehicle positions within specified route IDs have not changed.
- Eliminates redundant renders for off-route coordinate updates.

---

## 10. Types

### `types/places.ts`

Extended `Route` interfaces to support dual routing:
```typescript
export interface Route {
  polyline: { encodedPolyline: string };
  source?: "opentrip" | "google-maps-api";
  otpItinerary?: any; // Raw OpenTripPlanner itinerary structure
  legs?: RouteLeg[];
  // ... other existing fields
}
```

---

## 11. Critical Constraints & Known Gotchas

### Shadowed `Map` constructor
In files importing MapLibre maps (`import Map from ...`), the standard JavaScript `Map` constructor (e.g. `new Map()`) is shadowed. When creating map maps, either declare them in files without map imports (e.g. `lib/routeRanking.ts`) or refer to global namespaces.

### Gorhom Bottom Sheet gestures
When using `@gorhom/bottom-sheet`, child scroll lists **must** use `BottomSheetScrollView` (imported from `@gorhom/bottom-sheet`) instead of standard React Native ScrollViews. Standard ScrollViews break sheet pan gestures and freeze vertical scrolling.

### Viewport Culling Coordinate Order
When culling vehicles inside `map.tsx`, coordinate boundaries returned by MapLibre are ordered `[longitudeWest, latitudeSouth, longitudeEast, latitudeNorth]`. Ensure bounding box checks map correctly to avoid culling the entire list.

---

## 12. Toolchain & Build Setup

The project uses **bun** for package management, targeting React Native New Architecture (`newArchEnabled`) and React Compiler (`reactCompiler`) flags. 

Ensure dependencies are installed with `bun install`. Run Metro using `bun run start`.

(End of file - total 794 lines)
