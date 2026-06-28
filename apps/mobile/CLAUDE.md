# Tranzit — Quick Orientation (CLAUDE.md)

> This is the **slim, always-loaded** entry point. The full architecture reference lives in
> [`DOCS.md`](./DOCS.md) — open it on demand when you need depth on a specific area.
> Don't duplicate detail here; add a redirect or link instead.

---

## What it is

Tranzit is a Calgary public-transit app built in **React Native (Expo, New Arch + React Compiler)**. The frontend talks to three backends:

- **Route Service** — Go microservice wrapping Google Maps Routes/Places and OpenTripPlanner (OTP) (`services/TranzitApiService.ts`, `lib/routeParser.ts`).
- **DB Middleware** — REST+SSE over the PostgreSQL transit DB (`lib/middleware.ts`, `lib/vehicleSSE.ts`, `lib/routeSSE.ts`).
- **Route Save** — WebSocket+REST for active trip sessions, tracking, rerouting, boarding confirmation, and countdown timings (`lib/tripWebSocket.ts`, `lib/config.ts`).

> **Backend auth:** all three verify the Supabase JWT. The app attaches it as
> `Authorization: Bearer` on every REST/SSE call (via `authHeader()` in `lib/supabase.ts`;
> Route Save's WS uses `?token=`). Route Save hard-enforces; Middleware + Route Service are
> rolling out **log-first** (`AUTH_ENFORCE`), so a missing token is tolerated for now but
> will become a 401 — keep the header on any new backend call. Service-to-service calls use
> mTLS, not the JWT. Backend details: each Go repo's `AUTH.md`.

**Core flows:**
1. **Journey Flow:** Search a destination (Map/Routes) → compute route via OTP (Google Maps fallback) → start journey → server creates a trip session → Commute screen takes over with live WebSocket tracking, push notifications, iOS Live Activities, and community reporting.
2. **Planner Flow:** Map out trips on a 24-hour visual schedule → calculate leave-by warnings and schedule local push notifications (`lib/leaveByNotifications.ts`).

**Tabs:** **Map · Routes · Commute · Planner · Saved**, plus a hidden **Report** tab (`href: null`).

**Theme:** Multi-preset system (`classic-light`, `classic-dark`) via `ThemeContext` → `useTheme()`. Theme drives base map styling (`theme.mapPaint.baseStyle`).

---

## Codebase Architecture & Outline (→ DOCS.md)

The full, load-bearing codebase reference can be navigated below:

* **[§1. Project Overview](./DOCS.md#1-project-overview)** — High-level flow, multi-system theme configurations, and active state-machine tracking.
* **[§2. Directory Map](./DOCS.md#2-directory-map)** — Flat file-tree breakdown of app screens, planner utilities, libraries, and types.
* **[§3. Backend Services & Endpoints](./DOCS.md#3-backend-services--endpoints)** — OTP route contracts, PostgreSQL middleware query parameters, and hardcoded Tailscale trip WebSocket URL.
* **[§4. Data Layer](./DOCS.md#4-data-layer)** — PostgreSQL layout, local SQLite cache schemas (`uq_one_default_per_category`), and minutes-from-midnight timeline representations.
* **[§5. Core Libraries](./DOCS.md#5-core-libraries-lib)** — High-performance vehicle positions incremental snapshots, leave-by schedules, and multi-router polyline parser.
* **[§6. Theme Context](./DOCS.md#6-contexts)** — SECURE_STORE themes, dynamic MapTiler style swaps, and layout color mapping.
* **[§7. Screen Architecture](./DOCS.md#7-screen-architecture)** — 
  - *[Map Screen](./DOCS.md#apptabsmaptsx--map-screen)*: Viewport culling bounding-box filtering onRegionDidChange, and gorhom bottom-sheets.
  - *[Routes Screen](./DOCS.md#apptabsroutestsx--route-planning-screen)*: Sticky current location pins, dynamic multi-bus chips, and leg polyline dotted overlays.
  - *[Commute Screen](./DOCS.md#apptabscommutetsx--active-journey-screen)*: Pre-boarding HUD calculations, countdown badges, and marquee overflows.
  - *[Planner Screen](./DOCS.md#apptabsplannertsx--travel-planner-screen)*: Interactive 24-hour schedules, offset render trees, and detail cards.
* **[§8. Component Internals](./DOCS.md#8-components)** — Details on `<MarqueeText>`, draggable `TripEventCard` components, custom plus/minus `Stepper` controls, and bottom-drawer sheets.
* **[§9. Hooks](./DOCS.md#9-hooks)** — Search suggestion debouncers, double-timer address overrides, and stable vehicle route selectors (`useVehiclesForRoutes`).
* **[§10. Types](./DOCS.md#10-types)** — Dual routing schemas, PostgreSQL Supabase column-string definitions, and trip WebSockets contracts.
* **[§11. Critical Constraints & Gotchas](./DOCS.md#11-critical-constraints--known-gotchas)** — MapLibre double-taps, shadowing constructor namespaces, and Gorhom layout requirements.
* **[§12. Toolchain & Build Setup](./DOCS.md#12-toolchain--build-setup)** — Bun execution pipelines, native iOS Pod dependencies, and fast ccache integrations.

---

## Load-bearing facts (read before touching code)

These are the few things most likely to cause a silent bug. Full explanations in **[DOCS.md §11](./DOCS.md#11-critical-constraints--known-gotchas)**.

- **WKT is `POINT(lng lat)` — longitude first.** GeoJSON/MapLibre coords are `[lng, lat]`. Use `parseWKTPoint`; don't invert.
- **`stop_time_updates.stop_id` (string) ↔ `calgary_transit_stops.teleride_number` (int).** Cast at the join boundary. `-1` = "no data" sentinel.
- **`vehicle_positions.route_id` is imputed** from `trip_updates`, not in the raw GTFS-RT feed.
- **Map markers are GPU GeoJSON layers.** `layerTappedRef` guards double-firing of `GeoJSONSource.onPress` + `Map.onPress`. `flyTo` must be declared *above* layer-press handlers to avoid Temporal Dead Zone (TDZ) errors.
- **OpenTripPlanner (OTP) is the active engine** by default. Leg polylines are split per transit leg and walking leg (walking legs are styled as thick dotted lines). Falls back to Google Maps (commented out) using route-level polylines.
- **Gorhom Bottom Sheets gesture gotcha:** All scrollable elements nested inside bottom-sheets *must* use `BottomSheetScrollView` instead of the React Native `ScrollView`. Otherwise, pan/drag gestures will lock up.
- **Shadowed namespaces:** The MapLibre map import shadows the standard JS `Map` constructor in some files (e.g. `routes.tsx`). Define grouping Maps or reference global namespaces to avoid errors.
- **Hardcoded endpoint:** `ROUTE_SAVE_URL` is hardcoded to the Tailscale node `"https://tranzit-route-save.tailnet-example.ts.net"` inside `lib/config.ts`. Do not use `.env.local` for this property.
- **Incremental SSE Snapshots:** `lib/vehicleSSE.ts` utilizes incremental delta patching ($O(\text{changed})$ operations) rather than rebuilding the entire fleet snapshot on every event. Delta broadcasts to React subscribers are throttled to `200ms` trailing-edge.

---

## Env vars

| Variable | Used by | Description |
|----------|---------|-------------|
| `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `lib/supabase.ts` | Supabase endpoint and client keys |
| `EXPO_PUBLIC_USE_LOCAL` (`"true"` → localhost:3100) | `services/TranzitApiService.ts` | Local route service redirect |
| `EXPO_PUBLIC_MAPTILER_KEY` | map / theme `mapPaint` | Tile style keys (if blank, map renders empty) |

Never commit `.env.local`. Reference: **[DOCS.md Appendix](./DOCS.md#appendix-environment-variables)**.

---

## Toolchain (bun — not npm/yarn)

```bash
bun install
bun run start      # → Starts Metro
bun run ios        # → Builds local Xcode debug app
bun run android    # → Builds local Android debug apk
```

- ID configurations: Bundle `com.anonymous.tranzit`, scheme `tranzit`, slug `tranzit`.
- Native rebuilds: `cd ios && pod install && cd .. && bun run ios`. Requires Xcode ccache (`brew install ccache`).
- New Arch (`newArchEnabled: true`) and React Compiler (`reactCompiler: true`) are enabled in `app.json`.
- If a lockfile like `package-lock.json` or `yarn.lock` is introduced, delete it and re-run `bun install`.
