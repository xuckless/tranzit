### **Calgary Transit Database Documentation**

**Overview**
This database manages Calgary Transit infrastructure and real-time GTFS-RT telemetry, tracking bus locations, schedules, and historical delays.

---

### **1. Static Tables (Infrastructure)**

Sourced from City of Calgary SODA2 APIs.

* **`calgary_transit_stops`**: Physical bus stops. The `teleride_number` serves as the primary operational ID.
* **`calgary_transit_routes`**: Route metadata and WKT multi-line string geometries for map rendering.
* **`calgary_train_stations`**: CTrain station locations and track distances.

### **2. Real-Time Tables (GTFS-RT)**

Dropped and recreated dynamically; updated every 30 seconds.

* **`trip_updates`**: Active bus journeys. `trip_id` is the primary identifier.
* **`stop_time_updates`**: Predicted arrivals and departures. Tracked per `trip_id` and `stop_sequence`.
* **`vehicle_positions`**: Live GPS coordinates, calculated speed/bearing, and congestion status of active vehicles.
* **`alerts`**: System disruptions, detours, and warnings.

### **3. Analytics Tables (Computed)**

State machines and historical aggregation.

* **`trip_stop_delays`**: Live geospatial state machine tracking whether a bus is `APPROACHING`, `ARRIVED`, or `DEPARTED` from a stop, calculating exact ground-truth delays based on a 20-meter radius.
* **`stop_analytics`**: Historical metrics (average delay, average dwell time, congestion scores) permanently aggregated by `stop_id` and `route_id`.

---

### **Object Relations & Joins**

* **The Trip Hub:** `trip_id` is the central relational key.
* `trip_updates.trip_id` (1) ↔ (M) `stop_time_updates.trip_id`
* `trip_updates.trip_id` (1) ↔ (1) `vehicle_positions.trip_id`
* `trip_updates.trip_id` (1) ↔ (M) `trip_stop_delays.trip_id`


* **Stop Mapping:** Operational stop IDs (`stop_id` in `stop_time_updates`, `trip_stop_delays`, and `stop_analytics`) map directly to the static `calgary_transit_stops.teleride_number`.
* **Route Imputation:** `vehicle_positions` does not natively contain route data; `route_id` is imputed dynamically via a join with `trip_updates` using the `trip_id`.
* **Analytics Linking:** `trip_stop_delays` joins with `stop_analytics` on `(stop_id, route_id)` to enrich live bus state data with historical averages for that specific stop and route.


## Additional Notes

**calgary_train_stations:**

* Self-sustaining. Contains CTrain station names, track distances, and `point` coordinates in WKT format.

**vehicle_positions:**

* Live GPS tracking per `vehicle_id`.
* trip_id = maps to the active trip hub.
* route_id = imputed dynamically from `trip_updates` (not in raw feed).
* Contains calculated speed, bearing, and live congestion/occupancy status.

**trip_stop_delays:**

* Geospatial state machine tracking exact ground-truth delays.
* transit_state = tracks if bus is APPROACHING, ARRIVED (within 20m radius), or DEPARTED.
* dwell_seconds = actual time the bus spent physically at the stop.

**stop_analytics:**

* Historical data permanently aggregated by `stop_id` and `route_id`.
* avg_delay_seconds / avg_dwell_seconds = all-time running averages.
* congestion_score = 0-100 score based on historical lateness.
