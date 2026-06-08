import polyline from "@mapbox/polyline";
import type {
  RawRouteResponse,
  Route,
  RouteStep,
  OTPItinerary,
  OTPLeg,
} from "@/types/places";
import type { RouteSource } from "@/types/places";

// routeParser normalizes the two routing engines exposed by the route service
// into the single canonical `Route` shape that the Routes and Commute screens
// (and RoutePickerSheet) already consume. Callers never branch on `source`:
//
//   • google-maps-api → { source, routes: Route[] }      → returned as-is
//   • opentrip        → { source, itineraries: OTP[] }   → adapted to Route[]
//
// This is the seam for dual-mode routing: flip which endpoint the service hits
// and the UI keeps rendering without any further changes.

// OTP emits a street mode (WALK/BICYCLE) for access/egress and a transit mode
// (BUS/TRAM/RAIL/SUBWAY/…) for vehicle legs. The Google-shaped UI only knows
// "WALK" | "TRANSIT", so everything that isn't a walk collapses to TRANSIT.
function otpModeToTravelMode(mode: string): "WALK" | "TRANSIT" {
  const m = (mode ?? "").toUpperCase();
  return m === "WALK" || m === "BICYCLE" ? "WALK" : "TRANSIT";
}

const secStr = (n: number | undefined): string => `${Math.max(0, Math.round(n ?? 0))}s`;

// Merge the per-leg encoded polylines OTP returns into a single route-level
// polyline, because both screens render from `route.polyline.encodedPolyline`.
function mergeLegPolylines(legs: OTPLeg[]): string {
  const coords: [number, number][] = [];
  for (const leg of legs) {
    if (!leg.polyline) continue;
    try {
      for (const pt of polyline.decode(leg.polyline)) {
        coords.push(pt as [number, number]);
      }
    } catch {
      // Skip a leg with malformed geometry rather than dropping the whole route.
    }
  }
  return coords.length > 0 ? polyline.encode(coords) : "";
}

// Adapt a single OTP itinerary into the canonical Route shape.
export function otpItineraryToRoute(it: OTPItinerary): Route {
  const legs = it.legs ?? [];
  const distanceMeters = Math.round(
    legs.reduce((sum, l) => sum + (l.distance_m ?? 0), 0),
  );

  const steps: RouteStep[] = legs.map((leg) => {
    const travelMode = otpModeToTravelMode(leg.mode);
    const step: RouteStep = {
      travelMode,
      distanceMeters: Math.round(leg.distance_m ?? 0),
      duration: secStr(leg.duration_seconds),
      polyline: leg.polyline ? { encodedPolyline: leg.polyline } : undefined,
    };
    if (travelMode === "TRANSIT") {
      step.transitDetails = {
        headsign: leg.headsign,
        // OTP does not return a line color, so transitLine.color is left
        // undefined; normalizeColor() falls back to the primary theme color.
        transitLine: {
          name: leg.route_long_name,
          nameShort: leg.route_short_name,
        },
        stopDetails: {
          departureStop: { name: leg.from },
          arrivalStop: { name: leg.to },
          departureTime: leg.start_time,
          arrivalTime: leg.end_time,
        },
      };
    }
    return step;
  });

  const duration = secStr(it.duration_seconds);
  return {
    distanceMeters,
    duration,
    // OTP itineraries have no leg/step split that maps cleanly onto Google's;
    // the UI flattens legs→steps anyway, so one synthetic leg is sufficient.
    legs: [{ distanceMeters, duration, steps }],
    polyline: { encodedPolyline: mergeLegPolylines(legs) },
  };
}

// Normalize either engine's raw response envelope into Route[].
export function parseRouteResponse(raw: RawRouteResponse | null | undefined): Route[] {
  if (!raw) return [];
  if (raw.source === "opentrip") {
    return (raw.itineraries ?? []).map(otpItineraryToRoute);
  }
  // Default / google-maps-api: the routes are already in canonical shape.
  return raw.routes ?? [];
}

// Normalize a single route object into the canonical Route shape. Route Save
// hands the client raw route objects in two places — the REROUTE WebSocket frame
// and the GET /trips/{id} snapshot — both of which flow through here so the
// commute screen never has to know which engine produced them. Accepts:
//   • a bare canonical Google route (legs + polyline)  → returned as-is
//   • a bare OTP itinerary (duration_seconds + legs)   → adapted
//   • a `{ source, … }` envelope                       → first route extracted
// Returns null for anything unrecognizable so callers can no-op safely.
export function parseRoute(raw: unknown): Route | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const source = obj.source as RouteSource | undefined;
  if (source === "opentrip" || source === "google-maps-api") {
    return parseRouteResponse(obj as unknown as RawRouteResponse)[0] ?? null;
  }

  // OTP itineraries are keyed by duration_seconds; Google routes use a "1194s"
  // duration string, so this discriminates the two bare shapes cleanly.
  if (typeof obj.duration_seconds === "number") {
    return otpItineraryToRoute(obj as unknown as OTPItinerary);
  }

  // Canonical Google route: has a route-level polyline and/or legs.
  if (obj.polyline != null || Array.isArray(obj.legs)) {
    return obj as unknown as Route;
  }

  return null;
}
