# Project Context: Tranzit Community App (Working Title) - Mobile App

## 1. Project Overview
I am building a high-performance transit service application inspired by Google Maps and Transit App and Waze. The goal is to cater our app for just transit usage and make it better by using intuitive UI and AI elements (predictive elements) to reduce the load on users during navigation. How we do this is we would add specific UI elements and gamified it so the user does not get overloaded with information and the app become natural to navigate.

---

## 2. Tech Stack & Environment
### **Frontend**: React Native with TypeScript.

  - Focus: Low-latency UI, smooth map rendering, and real-time state management.
  - Map Provider: Google Maps API.
  - Authentication : Clerk SDK.

### **Backend** (Hybrid):

  - Golang: Responsible for the core API, WebSocket management, high-concurrency data ingestion, and performance-critical routing.

  - Python: Reserved for algorithmic enhancements, data science, and "Delay Factor" prediction models.

### **Database**: 
- SQLite: Responsible for local storage on devices (cache, cookies)
- Postgresql: Main storage containing core data (user's information, Calgary transit data)
- MongoDB: Stores uncategorized data (data that doesn't fit existing database schema )

### **Future Plan**:
- Caching/Real-time: Redis for live vehicle coordinate tracking.

---

## 3. Instructions for Claude

- Coding Style: Provide idiomatic TypeScript. Use Protobuf definitions when discussing real-time data.

- Tone: Technical, direct, and architectural.

- Avoid: Generic web development advice.

- Contextual Awareness: When suggesting features, remember the preference for official APIs over scraping and a focus on backend efficiency, also adhere to the JSON format provided by our microservices.

---

# Calgary Transit Places Search API Documentation

```
BASE_URL = "https://tranzit-route-service-000000000000.us-central1.run.app" 
```
## 1. Client GET Request (`/search`)

To support prioritization, the /search endpoint now accepts optional lat and lng parameters.

**Endpoint:** `GET /search`

**Query Parameters:**

* `q` (Required): The text string the user is searching for (e.g., `?q=Calgary Tower`).
* `lat` (Optional): User's current latitude (e.g., 51.0447).
* `lng` (Optional): User's current longitude (e.g., -114.0719).

### **Request Example**

```http
GET https://tranzit-route-service-000000000000.us-central1.run.app/search?q=Calgary+Tower

```

---

## 2. Response JSON Schema

The API returns a `200 OK` with an array of matching places. Because we are using a restricted `FieldMask` to save costs, the response only includes the exact fields required for routing and UI display.

If no locations match the query, it returns `404 Not Found`.

```json
{
  "places": [
    {
      "id": "string (The Google Place ID, required for the /route endpoint)",
      "displayName": {
        "text": "string (The human-readable name of the location)"
      },
      "formattedAddress:": { "text": "string (The human-readable address number and name"},
      "location": {
        "latitude": "float",
        "longitude": "float"
      }
    }
  ]
}

```

---

## 3. What NOT To Do

* **DO NOT pass the `displayName.text` to the `/route` endpoint.** The routing engine strictly requires the `id` (Place ID).
* **DO NOT cache Place IDs indefinitely.** Google's terms of service require Place IDs to be refreshed periodically, and they can occasionally change. Only store them in the user's active session state.
* **DO NOT ignore the coordinates.** While the Route API uses the Place ID, you should use the `location.latitude` and `location.longitude` returned here to immediately drop a "Destination" pin on your React Native map while the Route API is still loading in the background.

## Alerts:
Very self sustaining, no external connections, map it without issues
Calgary transit routes:
Self sustaining, no external connections, just provides the colored line vectors in WKT format
Calgary transit stops:
    •    teleride_number= this is STOP_ID very confusing I know
    •    Status = active/inactive
    •    Point = provides lat and long coordinates in WKT format. POINT(lat, long)
    •    Every thing else is just plain data
stop_time_updates
    •    trip_id = 1 trip of the bus from start to finish
    •    stop_sequence = sequence of the stop relative to the trip id, for example this trip id stop a is 1 away from start of the trip and stop c is 5 away. Etc honestly, a useless metric.
    •    stop_id = should be mapped with teleride_number
    •    Arrival time and departure time = this is time and date in single string format. i.e. 1778695260
    •    Apart from that its just data
trip_updates
This table contains details of schedules of all future trips, for example bus 3 does all these trips in one day And this data gets into stop time updates when the trip is being run.
    •    trip_id = we have a similar primary key to stop_time_updates, can be mapped onto each other
    •    route_id = this is the BUS NUMBER
    •    Timestamp = this is time and date in single string format. Ie 1778695260 - this is general scheduled time
calgary_train_stations:
    •    Self-sustaining. Contains CTrain station names, track distances, and point coordinates in WKT format.
vehicle_positions:
    •    Live GPS tracking per vehicle_id.
    •    trip_id = maps to the active trip hub.
    •    route_id = imputed dynamically from trip_updates (not in raw feed).
    •    Contains calculated speed, bearing, and live congestion/occupancy status.
trip_stop_delays:
    •    Geospatial state machine tracking exact ground-truth delays.
    •    transit_state = tracks if bus is APPROACHING, ARRIVED (within 20m radius), or DEPARTED.
    •    dwell_seconds = actual time the bus spent physically at the stop.
stop_analytics:
    •    Historical data permanently aggregated by stop_id and route_id.
    •    avg_delay_seconds / avg_dwell_seconds = all-time running averages.
    •    congestion_score = 0-100 score based on historical lateness
=======
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
