// ─── Static GTFS (SODA2) ────────────────────────────────────────────────────

export interface CalgaryTransitStop {
  teleride_number: number | null;
  stop_name: string | null;
  status: string | null;
  create_dt_utc: string | null;
  mod_dt_utc: string | null;
  globalid: string; // PK
  point: string | null; // WKT: POINT(lng lat)
}

export interface CalgaryTransitRoute {
  route_category: string | null;
  route_short_name: string | null;
  route_long_name: string | null;
  create_dt_utc: string | null;
  mod_dt_utc: string | null;
  globalid: string; // PK
  multilinestring: string | null; // WKT vectors
}

export interface CalgaryTrainStation {
  station_name: string; // PK
  leg: string | null;
  dist_nb: number | null;
  dist_sb: number | null;
  dist_eb: number | null;
  dist_wb: number | null;
  route: number | null;
  status: number | null;
  point: string | null; // WKT: POINT(lng lat)
}

// ─── Realtime GTFS ──────────────────────────────────────────────────────────

export interface TripUpdate {
  trip_id: string; // PK
  route_id: string | null; // bus number
  schedule_relationship: string | null;
  timestamp: number | null; // unix epoch
}

export interface StopTimeUpdate {
  trip_id: string; // PK (composite)
  stop_sequence: number; // PK (composite) — sequence within the trip
  stop_id: string | null; // maps to calgary_transit_stops.teleride_number
  arrival_time: number | null; // unix epoch — current predicted arrival
  departure_time: number | null; // unix epoch — current predicted departure
  scheduled_arrival_time: number | null; // unix epoch — frozen on first insert; ≤0 treated as NULL
  scheduled_departure_time: number | null; // unix epoch — frozen on first insert; ≤0 treated as NULL
  arrival_delay: number | null; // seconds; positive = late, negative = early
  departure_delay: number | null;
  schedule_relationship: string | null;
}

export interface VehiclePosition {
  vehicle_id: string; // PK
  trip_id: string | null;
  route_id: string | null; // imputed from trip_updates, not in raw feed
  latitude: number | null;
  longitude: number | null;
  bearing: number | null;
  speed: number | null;
  timestamp: number | null; // unix epoch
  congestion_level: string | null;
  occupancy_status: string | null;
}

export interface Alert {
  alert_id: string; // PK
  active_period_start: number | null; // unix epoch
  active_period_end: number | null; // unix epoch
  informed_agency_id: string | null;
  informed_route_id: string | null;
  informed_stop_id: string | null;
  header_text: string | null;
  description_text: string | null;
  cause: string | null;
  effect: string | null;
  url: string | null;
  severity_level: string | null;
}

// ─── Analytics & Geospatial Engine ──────────────────────────────────────────

export type TransitState = 'APPROACHING' | 'ARRIVED' | 'DEPARTED';

export interface TripStopDelay {
  trip_id: string; // PK (composite)
  stop_sequence: number; // PK (composite)
  stop_id: string | null;
  route_id: string | null;
  delay_seconds: number | null;
  historical_avg_delay: number | null;
  historical_avg_dwell: number | null;
  congestion_score: number | null;
  dwell_seconds: number | null;
  transit_state: TransitState;
  actual_arrival_time: number | null; // unix epoch
  actual_departure_time: number | null; // unix epoch
  min_distance_recorded: number | null;
  observed_delay_seconds: number | null;
}

export interface StopAnalytics {
  stop_id: string; // PK (composite)
  route_id: string; // PK (composite)
  sample_count: number;
  avg_delay_seconds: number;
  avg_dwell_seconds: number;
  congestion_score: number; // 0–100
  last_delay_seconds: number | null;
  last_dwell_seconds: number | null;
  last_updated: number | null; // unix epoch
}

// ─── Supabase Database generic ───────────────────────────────────────────────
// Passed to createClient<Database> so all .from() calls are typed.
// supabase-js v2 requires a Relationships array on every table entry; without
// it the column-string inference engine resolves query return types to `never`.

export interface Database {
  public: {
    Tables: {
      // NOTE: supabase-js v2's column-string type inference requires Views,
      // Functions, Enums, and CompositeTypes to be present on the schema even
      // when empty — their absence causes query result types to resolve to never.

      calgary_transit_stops: {
        Row: CalgaryTransitStop;
        Insert: Partial<CalgaryTransitStop> & Pick<CalgaryTransitStop, 'globalid'>;
        Update: Partial<CalgaryTransitStop>;
        Relationships: [];
      };
      calgary_transit_routes: {
        Row: CalgaryTransitRoute;
        Insert: Partial<CalgaryTransitRoute> & Pick<CalgaryTransitRoute, 'globalid'>;
        Update: Partial<CalgaryTransitRoute>;
        Relationships: [];
      };
      calgary_train_stations: {
        Row: CalgaryTrainStation;
        Insert: Partial<CalgaryTrainStation> & Pick<CalgaryTrainStation, 'station_name'>;
        Update: Partial<CalgaryTrainStation>;
        Relationships: [];
      };
      trip_updates: {
        Row: TripUpdate;
        Insert: Partial<TripUpdate> & Pick<TripUpdate, 'trip_id'>;
        Update: Partial<TripUpdate>;
        Relationships: [];
      };
      stop_time_updates: {
        Row: StopTimeUpdate;
        Insert: Partial<StopTimeUpdate> & Pick<StopTimeUpdate, 'trip_id' | 'stop_sequence'>;
        Update: Partial<StopTimeUpdate>;
        Relationships: [];
      };
      vehicle_positions: {
        Row: VehiclePosition;
        Insert: Partial<VehiclePosition> & Pick<VehiclePosition, 'vehicle_id'>;
        Update: Partial<VehiclePosition>;
        Relationships: [];
      };
      alerts: {
        Row: Alert;
        Insert: Partial<Alert> & Pick<Alert, 'alert_id'>;
        Update: Partial<Alert>;
        Relationships: [];
      };
      trip_stop_delays: {
        Row: TripStopDelay;
        Insert: Partial<TripStopDelay> & Pick<TripStopDelay, 'trip_id' | 'stop_sequence'>;
        Update: Partial<TripStopDelay>;
        Relationships: [];
      };
      stop_analytics: {
        Row: StopAnalytics;
        Insert: Partial<StopAnalytics> & Pick<StopAnalytics, 'stop_id' | 'route_id'>;
        Update: Partial<StopAnalytics>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
