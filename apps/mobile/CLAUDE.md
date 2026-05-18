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
