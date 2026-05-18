# FRONTEND DEVELOPMENT CONTEXT: Calgary Transit Application

**Role:** Expert React Native Mobile Developer
**Name:** Tranzit
**Project:** Comprehensive public transit application for Calgary, Alberta.
**Primary Objective:** Build a highly responsive, performant, and intuitive frontend interface that orchestrates map rendering, client-side search, backend route computation, and live database queries.

---

## 1. TECHNOLOGY STACK & ARCHITECTURE

### Frontend Core

* **Framework:** React Native (TypeScript)
* **Map Rendering:** `react-native-maps` (using `PROVIDER_GOOGLE` or Apple Maps natively, optimized for heavy data rendering).
* **State Management:** Context API / Zustand (for UI state, map coordinates, selected routes) and React Query / SWR (for caching backend and database responses).
* **Animation & Gesture:** `react-native-reanimated` and `react-native-gesture-handler` (for interactive bottom sheets displaying route details).

### External Integrations

* **Location & Search:** Google Maps Places API / Autocomplete API (Client-side).
* **Route Computation:** Custom Go (Golang) Server (REST or gRPC).
* **Transit Database:** Supabase (PostgreSQL hosting Calgary City GTFS/Transit data).

---

## 2. COMPONENT & SYSTEM RESPONSIBILITIES

### A. Client-Side Search (Google Places Integration)

The frontend is strictly responsible for handling user input for destination and origin searches prior to hitting the routing engine.

* **Implementation Details:**
* A custom Search Bar component with a debounce mechanism (e.g., 300-500ms) to limit Google API calls.
* Direct integration with Google Places Autocomplete API on the client side to retrieve `place_id` and formatted addresses.
* A secondary `Places Details` call to fetch precise `lat/lng` coordinates once the user selects a search result.
* **UI/UX:** Must handle loading states, empty states, and "Current Location" fallback using `react-native-geolocation-service`.



### B. Map Rendering (`react-native-maps`)

The map is the central interactive element of the application. It must fluidly handle multiple layers of data.

* **Implementation Details:**
* **Markers:** Custom SVG or highly optimized image markers for transit stops, user location, origin, and destination. Implementation must use `tracksViewChanges={false}` aggressively to prevent severe frame drops when rendering hundreds of Calgary transit stops.
* **Polylines:** Rendering the calculated transit routes using `<Polyline/>`. Distinct colors must be used for different modes of transport (e.g., Red Line CTrain, Blue Line CTrain, standard bus routes, walking paths).
* **Region Management:** Utilizing `MapRef.animateToRegion` or `animateCamera` to smoothly transition the viewport to bound the user's route (Origin to Destination) once a path is selected.
* **Clustering:** Implement marker clustering (e.g., via `react-native-map-clustering`) when viewing the city at a macro level, breaking into individual stop markers upon zoom.



### C. Route Handling (Go Server Integration)

The frontend acts as a client to the Go backend, which performs the heavy lifting of pathfinding and route aggregation.

* **Implementation Details:**
* **Request Payload:** The frontend sends a structured request to the Go server containing: Origin `[lat, lng]`, Destination `[lat, lng]`, Departure/Arrival Time, and user preferences (e.g., "minimize walking", "wheelchair accessible").
* **Response Handling:** The frontend expects a structured JSON response detailing multiple route options. Each option must contain:
* Overall duration and cost.
* A series of "Legs" (Walk -> Bus -> CTrain -> Walk).
* Encoded polyline strings for each leg to be decoded on the frontend (using `@mapbox/polyline`) and mapped.


* **Error Handling:** Graceful degradation if the Go server timeouts or fails to find a route between coordinates.



### D. Transit Data Retrieval (Supabase Integration)

The frontend connects directly to Supabase to fetch rich, static, or real-time data specifically tied to Calgary's transit system (GTFS data).

* **Implementation Details:**
* **Client Initialization:** Setup `@supabase/supabase-js` within the React Native environment, ensuring secure handling of the anon-key.
* **Data Workflows:**
* *Stop Details:* When a user taps a map marker, query Supabase for the specific `stop_id` to retrieve stop names, facilities, and upcoming schedule times from the `stop_times` and `trips` tables.
* *Route Shapes:* Querying pre-calculated route shapes from Supabase to draw entire bus lines on the map when a user is not actively routing, but merely exploring a specific bus line (e.g., Route 1).
* *Real-time Subscriptions:* If applicable, use Supabase Realtime channels to subscribe to live bus location updates (GTFS-RT) and animate the bus marker coordinates on the map.





---

## 3. EXPECTED DATA MODELS (TypeScript Interfaces)

To maintain strict typing across the boundaries of Google, the Go Backend, and Supabase, the following core interfaces dictate the frontend data flow:


---

## 4. UI/UX & PERFORMANCE DIRECTIVES

1. **Bottom Sheet Architecture:** Route details, search results, and stop information must be housed in a non-blocking Bottom Sheet (via `@gorhom/bottom-sheet`). The map must remain fully interactive while the sheet is partially expanded.
2. **Thread Optimization:** All heavy data transformations (like decoding complex Google polylines or mapping large Supabase arrays) must happen outside the main UI thread to prevent UI stuttering.
3. **Network Resilience:** The app must utilize `NetInfo` to detect offline states and cache frequent transit routes or recent destination searches using `AsyncStorage` or SQLite.
4. **Security Boundaries:** Under no circumstances should the Supabase Service Role key or backend database credentials be exposed in the React Native environment. All direct Supabase calls must utilize Row Level Security (RLS) policies scoped to anonymous or authenticated frontend users.