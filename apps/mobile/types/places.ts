export interface PlaceResult {
  id: string;
  displayName: { text: string };
  formattedAddress: string; // New field for street/number info
  location: { latitude: number; longitude: number };
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
}

export interface RouteStep {
  travelMode: "WALK" | "TRANSIT";
  distanceMeters?: number;
  duration?: string;
  staticDuration?: string;
  polyline?: { encodedPolyline: string }; // step-level; use for per-segment styling
  navigationInstruction?: { instructions: string };
  transitDetails?: {
    stopDetails?: {
      arrivalStop?: { name: string };
      departureStop?: { name: string };
    };
    headsign?: string;
    transitLine?: RouteTransitLine;
    estimatedArrivalTime?: string;
    localizedValues?: {
      departureTime?: { time?: { text: string } };
      arrivalTime?: { time?: { text: string } };
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
  duration: string; // e.g. "397s"
  legs: RouteLeg[];
  polyline: { encodedPolyline: string };
}

export interface RouteResponse {
  routes: Route[];
}
