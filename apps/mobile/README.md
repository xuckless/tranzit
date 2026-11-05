# Tranzit

**Calgary public transit, live.**

Tranzit is a Calgary-specific public transit app built with React Native (Expo). It provides live bus tracking, route planning, and real-time arrival information powered by Calgary Transit GTFS-RT data.

## Features

- **Live Map** — Interactive MapLibre map showing real-time bus positions and transit stops, with GPU-rendered GeoJSON layers for smooth performance
- **Route Planning** — Search destinations by POI or street address; choose from top transit routes filtered by Bus or CTrain
- **Live Journey Tracking** — Active commute screen with route polyline, step-by-step stop timeline, and proximity-based current-stop detection
- **Saved Places** — Organize favourite places into categories; set defaults for one-tap quick access from the map
- **Service Alerts & Delays** — View active alerts and historical delay/congestion analytics per stop and route
- **Boarding Notifications** — iOS notifications and Live Activities for boarding reminders
- **Offline Cache** — Transit stops cached locally in SQLite with 24-hour TTL for fast startup

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐
│   Tranzit App        │     │  Route Service (Go)   │
│  (React Native/Expo) │────▶│  Google Routes/Places │
│                      │     │  /search, /route,     │
│  MapLibre Map        │     │  /details, /autocomplete
│  SQLite Cache        │     └──────────────────────┘
│  SSE Bus Positions   │
│                      │     ┌──────────────────────┐
│                      │────▶│  DB Middleware (REST) │
│                      │     │  Calgary Transit DB   │
│                      │     │  /vehicle_positions   │
│                      │     │  (SSE stream)         │
└─────────────────────┘     └──────────────────────┘
```

The app communicates with two backend services:
- **[Route Service](https://github.com/anomalyco/tranzit-route-service)** — Go microservice wrapping Google Maps Routes, Places, and Places Autocomplete APIs
- **DB Middleware** — REST + SSE service exposing a PostgreSQL database of Calgary Transit GTFS-RT data (stops, routes, trip updates, vehicle positions, alerts, delays)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Native 0.81 + Expo 54 |
| Language | TypeScript (strict) |
| Map | `@maplibre/maplibre-react-native` (MapLibre GL) |
| Tiles | MapTiler Positron |
| Backend DB | Supabase (PostgreSQL) |
| Local Storage | `expo-sqlite` (WAL mode) |
| Auth Tokens | `expo-secure-store` |
| Live Data | Server-Sent Events (`react-native-sse`) |
| Notifications | `expo-notifications`, `expo-live-activity` |
| Location | `expo-location` |
| Routing | Expo Router (file-based) |
| Package Manager | bun |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [bun](https://bun.sh) (`npm i -g bun`)
- [Xcode](https://developer.apple.com/xcode/) (for iOS)
- [Android Studio](https://developer.android.com/studio) (for Android)
- A [MapTiler](https://cloud.maptiler.com/) API key (free tier)

### Environment Variables

Copy the example env file and fill in your keys:

```bash
cp .env.local.example .env.local
```

| Variable | Required | Description |
|----------|----------|-------------|
| `EXPO_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous key |
| `EXPO_PUBLIC_MAPTILER_KEY` | Yes | MapTiler API key for base tiles |
| `EXPO_PUBLIC_USE_LOCAL` | No | Set to `true` to route requests to `localhost:3100` |

Never commit `.env.local`. The Supabase Service Role key must never be bundled in the app.

### Install & Run

```bash
bun install
bun run start
```

This starts the Metro bundler. Press `i` to open the iOS simulator or `a` for Android.

> Expo Go has limited support for custom native modules. For full functionality (MapLibre, SQLite, live activities), use a **development build**.

### Native Builds

```bash
bun run ios       # Build + install on iOS simulator
bun run android   # Build + install debug APK on connected device/emulator
```

iOS builds require `ccache` for faster recompiles:

```bash
brew install ccache
```

## Project Structure

```
app/
  (tabs)/
    map.tsx          — Main map with bottom sheet, live buses, stops, search
    routes.tsx       — Route planning with origin/destination & route picker
    commute.tsx      — Active journey with live tracking and stop timeline
    saved.tsx        — Saved places grouped by category
  _layout.tsx        — Root layout (theme, notifications, gestures)
  index.tsx          — Entry point / splash redirect
components/
  stopViews.tsx      — Stop details panel (arrivals, past trips)
  busViews.tsx       — Bus details panel (trip stop sequence)
  SavePlaceModal.tsx — Two-phase modal for saving a place
  routes/            — RoutePickerSheet, route cards
  search/            — SearchSheet, SearchBar, results lists
lib/
  db.ts              — SQLite schema and CRUD operations
  middleware.ts      — Typed REST client for DB middleware
  vehicleSSE.ts      — Shared SSE connection for live bus positions
  routeStore.ts      — In-memory session store (survives tab nav)
  transitStopsCache.ts — Middleware → SQLite cache orchestrator
  supabase.ts        — Supabase client singleton
hooks/
  usePlacesSearch.ts       — Single-source search (POIs)
  useDestinationSearch.ts  — Dual-source search (POIs + autocomplete)
  useSavedPlaces.ts        — SQLite-backed saved places
  useQuickAccess.ts        — Default saved places for map chips
services/
  TranzitApiService.ts     — All route service API calls
types/
  places.ts   — SearchSuggestion, Route, RouteStep, etc.
  database.ts — PostgreSQL table interfaces
styles/
  theme.ts    — Colors, spacing, typography constants
```

## Development Notes

- **Package manager:** This project uses **bun**. Do not commit `package-lock.json` or `yarn.lock`. Delete them if they appear and re-run `bun install`.
- **Map rendering:** Stops and buses are GPU-rendered via MapLibre GeoJSON layers, not React Native views. The destination pin is the only `<Marker>` component.
- **WKT format:** PostGIS stores `POINT(lng lat)` — longitude first. GeoJSON coordinates must be `[longitude, latitude]`.
- **Place IDs:** Google Place IDs are session-state only (never persisted). They are held in `routeStore` and reset on app reload.
- **Step-level polylines** are not guaranteed by the Routes API. Use `route.polyline.encodedPolyline` (route-level) for all map rendering.

## Internal Documentation

For contributors: comprehensive codebase documentation covering data flow, architecture decisions, gotchas, and detailed screen breakdowns is available in [`CLAUDE.md`](./CLAUDE.md).

## License

Private — All rights reserved.
