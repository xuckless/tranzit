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
}

export interface RouteResponse {
  routes: Route[];
}
