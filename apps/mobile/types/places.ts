// ─── Autocomplete API ─────────────────────────────────────────────────────────

export interface AutocompletePrediction {
  place_id: string;
  description: string;
  structured_formatting: {
    main_text: string;
    secondary_text?: string;
  };
}

// ─── Unified destination search result ───────────────────────────────────────
// Normalized shape from both /search (instant) and /autocomplete/json (delayed).
// location is populated only for /search results; autocomplete results require
// a subsequent POST /details call to resolve coordinates.

export interface SearchSuggestion {
  placeId: string;
  mainText: string;
  secondaryText?: string;
  location?: { latitude: number; longitude: number };
}

// ─── Place / Search API ───────────────────────────────────────────────────────

export interface PlaceResult {
  id: string;
  displayName: { text: string };
  formattedAddress: string;
  location: { latitude: number; longitude: number };
}

// Extended shape returned by POST /details — all extra fields are optional
// so a plain PlaceResult object is always a valid PlaceDetails.
export interface PlaceDetails extends PlaceResult {
  types?: string[];
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  regularOpeningHours?: {
    openNow?: boolean;
    weekdayDescriptions?: string[];
  };
}

export interface PlacesSearchResponse {
  places: PlaceResult[];
}

// Downstream contract — what gets passed to the route engine
export interface SelectedDestination {
  placeId: string; // strictly the id field — never displayName.text
  displayText: string; // for UI label only, never sent to /route
  coordinate: {
    latitude: number;
    longitude: number;
  };
}

// ─── Route API ────────────────────────────────────────────────────────────────

export interface RouteRequest {
  origin: { lat: number; lng: number };
  destination_id: string; // Google Place ID — never displayName
}

export interface RouteTransitLine {
  name?: string;
  nameShort?: string;
  color?: string;
  textColor?: string;
  agencies?: Array<{ name: string; phoneNumber?: string; uri?: string }>;
  vehicle?: {
    name?: { text: string };
    type?: string;
    iconUri?: string;
  };
}

export interface RouteStop {
  name: string;
  location?: {
    latLng?: { latitude: number; longitude: number };
  };
}

export interface RouteStep {
  travelMode: "WALK" | "TRANSIT";
  distanceMeters?: number;
  duration?: string;
  staticDuration?: string;
  // Step-level polyline is NOT always present in the API response.
  // The route-level polyline is always present and should be used for map rendering.
  polyline?: { encodedPolyline: string };
  navigationInstruction?: { instructions: string; maneuver?: string };
  transitDetails?: {
    stopDetails?: {
      arrivalStop?: RouteStop;
      departureStop?: RouteStop;
      // ISO 8601 timestamps at the stopDetails level
      arrivalTime?: string;
      departureTime?: string;
    };
    stopCount?: number;
    headsign?: string;
    transitLine?: RouteTransitLine;
    estimatedArrivalTime?: string;
    localizedValues?: {
      departureTime?: { time?: { text: string }; timeZone?: string };
      arrivalTime?: { time?: { text: string }; timeZone?: string };
    };
  };
}

export interface RouteLeg {
  distanceMeters?: number;
  duration?: string;
  steps: RouteStep[];
}

export interface Route {
  distanceMeters: number;
  duration: string; // e.g. "1194s"
  legs: RouteLeg[];
  polyline: { encodedPolyline: string }; // always present — use this for map rendering
  // ─── Trip-start carriers (not rendered) ──────────────────────────────────────
  // Which engine produced this route. `handleStart()` branches on it to POST the
  // correct Route Save /trips contract (Google Place ID vs OTP coordinates). Set
  // by parseRouteResponse(); an undefined source is treated as the Google path.
  source?: RouteSource;
  // The raw OTP itinerary this route was adapted from (OTP only). The normalized
  // Route drops trip_id / stop ids / stop coordinates that Route Save's OTP path
  // needs, so the raw itinerary is preserved here and POSTed verbatim to start.
  otpItinerary?: OTPItinerary;
}

export interface RouteResponse {
  routes: Route[];
}

// ─── Dual-router support ────────────────────────────────────────────────────────
// The route service exposes two routing engines, distinguished by the `source`
// field on the response envelope:
//   • POST /route      → { source: "google-maps-api", routes: Route[] }  — needs a Place ID
//   • POST /route/otp  → { source: "opentrip", itineraries: OTPItinerary[] } — needs lat/lng
// `lib/routeParser.ts` normalizes either envelope into the canonical Route[] above,
// so the rest of the app never branches on source.

export type RouteSource = "google-maps-api" | "opentrip";

// Body for POST /route/otp. Unlike the Google /route endpoint (which needs a
// Place ID), OTP plans purely from coordinates.
export interface OTPRouteRequest {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  // Travel profile. Defaults server-side to walk_transit.
  mode?: "walk" | "bike" | "transit" | "walk_transit" | "bike_transit";
  num_itineraries?: number;
  // Desired depart-at instant (ISO 8601). Omit (or "now") to leave now; the server then plans
  // forward to the next available trip. No UI surface yet — wired for a future "leave at…" picker.
  departure_time?: string;
}

// One leg of an OTP itinerary (mirrors the Go CleanLeg struct, snake_case JSON).
export interface OTPLeg {
  mode: string; // WALK | BUS | TRAM | RAIL | SUBWAY | BICYCLE | …
  duration_seconds: number;
  distance_m: number;
  start_time: string; // ISO 8601
  end_time: string; // ISO 8601
  from: string;
  to: string;
  from_stop_id?: string;
  to_stop_id?: string;
  route_short_name?: string;
  route_long_name?: string;
  headsign?: string;
  trip_id?: string;
  vehicle_id?: string;
  realtime: boolean;
  arrival_delay_seconds?: number;
  departure_delay_seconds?: number;
  polyline: string; // per-leg encoded polyline
}

// One ranked itinerary (mirrors the Go CleanItinerary struct).
export interface OTPItinerary {
  duration_seconds: number;
  walk_distance_m: number;
  start_time: string;
  end_time: string;
  legs: OTPLeg[];
}

export interface OTPRouteResponse {
  source: "opentrip";
  itineraries: OTPItinerary[];
}

// The raw envelope returned by either engine, before normalization.
export type RawRouteResponse =
  | ({ source?: "google-maps-api" } & RouteResponse)
  | OTPRouteResponse;
