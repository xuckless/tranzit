# Tranzit — Quick Orientation (CLAUDE.md)

> This is the **slim, always-loaded** entry point. The full architecture reference lives in
> [`DOCS.md`](./DOCS.md) — open it on demand when you need depth on a specific area.
> Don't duplicate detail here; add a redirect instead.

---

## What it is

Tranzit is a Calgary public-transit app in **React Native (Expo, New Arch + React Compiler)**. The frontend talks to three backends:

- **Route Service** — Go microservice wrapping Google Maps Routes/Places (`services/TranzitApiService.ts`).
- **DB Middleware** — REST+SSE over the PostgreSQL transit DB (`lib/middleware.ts`, `lib/vehicleSSE.ts`, `lib/routeSSE.ts`).
- **Route Save** — WebSocket+REST for active trip sessions, tracking, rerouting, boarding (`lib/tripWebSocket.ts`).

**Core flow:** search a destination (Map/Routes) → compute route → start journey → server creates a trip session → Commute screen takes over with live WebSocket tracking, push notifications, iOS Live Activities, and community reporting.

Tabs: **Map · Routes · Commute · Saved**, plus a hidden **Report** tab (`href: null`).

**Theme:** multi-preset system (`classic-light`, `classic-dark`) via `ThemeContext` → `useTheme()` returns a full `AppTheme` struct. Presets live in `styles/themes/`. See [DOCS.md §6](./DOCS.md#6-contexts) and the Theme System note in [§1](./DOCS.md#1-project-overview).

---

## Where to read more (→ DOCS.md)

| Topic | Section |
|-------|---------|
| Full directory map | [§2](./DOCS.md#2-directory-map) |
| Backend endpoints & contracts | [§3](./DOCS.md#3-backend-services--endpoints) |
| PostgreSQL tables + SQLite schema | [§4](./DOCS.md#4-data-layer) |
| `lib/` deep dives (SSE, routeStore, tripWebSocket, liveActivity, db) | [§5](./DOCS.md#5-core-libraries-lib) |
| ThemeContext / adding a theme | [§6](./DOCS.md#6-contexts) |
| Screen internals (map, routes, commute) | [§7](./DOCS.md#7-screen-architecture) |
| Component internals | [§8](./DOCS.md#8-components) |
| Search/saved hooks | [§9](./DOCS.md#9-hooks) |
| Types (places, database, trip) | [§10](./DOCS.md#10-types) |
| **Full gotchas list** | [§11](./DOCS.md#11-critical-constraints--known-gotchas) |
| Build/toolchain detail | [§12](./DOCS.md#12-toolchain--build-setup) |

> **Note:** `lib/routeParser.ts` (the Google/OTP dual-router seam + `parseRoute()` for REROUTE/snapshot frames) and the updated Route Save `/trips` contract are documented only in this file's load-bearing facts below — they are not yet folded into DOCS.md. Migrate them when convenient.

---

## Load-bearing facts (read before touching code)

These are the few things most likely to cause a silent bug. Full explanations in [DOCS.md §11](./DOCS.md#11-critical-constraints--known-gotchas).

- **WKT is `POINT(lng lat)` — longitude first.** GeoJSON/MapLibre coords are `[lng, lat]`. Use `parseWKTPoint`; don't invert.
- **`stop_time_updates.stop_id` (string) ↔ `calgary_transit_stops.teleride_number` (int).** Cast at the join boundary. `-1` = "no data" sentinel.
- **`vehicle_positions.route_id` is imputed** from `trip_updates`, not in the raw GTFS-RT feed — query both for route context.
- **Map markers are GPU GeoJSON layers**, not React components. `PooledBusMarker`/`StopMarker` no longer exist. `layerTappedRef` guards the double-fire of `GeoJSONSource.onPress` + `Map.onPress`. `flyTo` must be declared *above* the layer-press handlers (TDZ).
- **Use route-level polyline only** (`route.polyline.encodedPolyline`). Step-level polylines aren't guaranteed.
- **Place IDs are session-state only** (`routeStore`) — never persist to SQLite/AsyncStorage (Google TOS).
- **Route Save `/trips` POST body:** required fields are `route` + **`destination_place_id`** (verified against live server — *not* `destination`). Optional: `origin {lat,lng}`, `destination`, `device_id`. Returns `{ session_id, ws_url }`.
- **`GET /trips/{id}`** returns the `STATE` shape **plus** a `route` field; `commute.tsx` pulls it on a missed stop and rebuilds via `parseRoute()`. The `REROUTE` frame flows through `parseRoute()` too — both engines (Google/OTP) normalize to one `Route` shape in `lib/routeParser.ts`.
- **Starting a journey is not local-only** — `routes.tsx` must POST to create a session before navigating to Commute, or Commute shows empty state.
- **WebSocket outbox:** `submitUnsureResponse()` is module-level and queues to `_outbox` (flushed on next open). No REST fallback.
- **Theme drives the map:** `mapStyle` and every paint expression read from `theme.mapPaint.*` — the whole map restyles on theme switch.
- **`react-native-maps` was replaced by `@maplibre/maplibre-react-native`.** Old Fabric marker crash rules no longer apply.

---

## Env vars

| Variable | Used by |
|----------|---------|
| `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `lib/supabase.ts` |
| `EXPO_PUBLIC_USE_LOCAL` (`"true"` → localhost:3100; route service only) | `services/TranzitApiService.ts` |
| `EXPO_PUBLIC_MAPTILER_KEY` (blank → blank map) | map / theme `mapPaint` |
| `EXPO_PUBLIC_ROUTE_SAVE_URL` | `routes.tsx`, `lib/tripWebSocket.ts` |

Never commit `.env.local`. Never bundle the Supabase Service Role key. Full table: [DOCS.md Appendix](./DOCS.md#appendix-environment-variables).

---

## Toolchain (bun — not npm/yarn)

```bash
bun install
bun run ios        # → expo run:ios   (local Xcode build)
bun run android    # → expo run:android
bun run start      # → Metro
```

- IDs: bundle/package `com.anonymous.tranzit`, scheme `tranzit`, slug `tranzit`.
- New Arch (`newArchEnabled`) + React Compiler (`reactCompiler`) are **on**.
- After `ios/` native dep changes: `cd ios && pod install && cd .. && bun run ios`. ccache is enabled.
- If a stray `package-lock.json`/`yarn.lock` appears, delete it and re-run `bun install`.

Full build detail: [DOCS.md §12](./DOCS.md#12-toolchain--build-setup).
