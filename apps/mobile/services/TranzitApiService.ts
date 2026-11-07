import type {
  PlaceResult,
  PlaceDetails,
  PlacesSearchResponse,
  RouteResponse,
  RouteRequest,
  OTPRouteRequest,
  AutocompletePrediction,
} from "../types/places";
import { parseRouteResponse } from "@/lib/routeParser";
import { authHeader } from "@/lib/supabase";
import { fetchWithTimeout, httpError } from "@/lib/middleware";

import { ROUTE_SERVICE_URL as BASE_URL } from "@/lib/config";

export const TranzitApiService = {
  async searchPlaces(
    query: string,
    userLocation?: { latitude: number; longitude: number } | null,
    signal?: AbortSignal,
  ): Promise<PlaceResult[]> {
    let url = `${BASE_URL}/search?q=${encodeURIComponent(query)}`;
    if (userLocation) {
      url += `&lat=${userLocation.latitude}&lng=${userLocation.longitude}`;
    }
    const res = await fetchWithTimeout(url, { headers: await authHeader(), signal });
    if (res.status === 404) return [];
    if (!res.ok) throw httpError("Search failed", res.status);
    const data: PlacesSearchResponse = await res.json();
    return data.places ?? [];
  },

  async getPlaceDetails(
    placeId: string,
    signal?: AbortSignal,
  ): Promise<PlaceDetails> {
    const res = await fetchWithTimeout(`${BASE_URL}/details`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ place_id: placeId }),
      signal,
    });
    if (!res.ok) throw httpError("Details failed", res.status);
    return res.json() as Promise<PlaceDetails>;
  },

  // Google Routes engine (POST /route). Needs a Place ID in destination_id.
  // This is the active route path; OTP below is wired but not yet switched on.
  async getRoute(
    request: RouteRequest,
    signal?: AbortSignal,
  ): Promise<RouteResponse> {
    const res = await fetchWithTimeout(`${BASE_URL}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify(request),
      signal,
    });
    if (res.status === 204) return { routes: [] }; // no transit route exists
    if (!res.ok) throw httpError("Route failed", res.status);
    const data = await res.json();
    return { routes: parseRouteResponse(data) };
  },

  // OpenTripPlanner engine (POST /route/otp). Plans from lat/lng coordinates —
  // no Place ID required. Returns the same canonical Route[] as getRoute(), so
  // callers can swap engines without touching the UI.
  async getOTPRoute(
    request: OTPRouteRequest,
    signal?: AbortSignal,
  ): Promise<RouteResponse> {
    const res = await fetchWithTimeout(`${BASE_URL}/route/otp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify(request),
      signal,
    });
    if (res.status === 204) return { routes: [] }; // no itinerary found
    if (!res.ok) throw httpError("OTP route failed", res.status);
    const data = await res.json();
    return { routes: parseRouteResponse(data) };
  },

  async getAutocompletePredictions(
    query: string,
    signal?: AbortSignal,
  ): Promise<AutocompletePrediction[]> {
    const res = await fetchWithTimeout(
      `${BASE_URL}/autocomplete/json?input=${encodeURIComponent(query)}`,
      { headers: await authHeader(), signal },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.predictions ?? [];
  },

  async searchNearby(
    lat: number,
    lng: number,
    signal?: AbortSignal,
  ): Promise<PlaceResult[]> {
    const res = await fetchWithTimeout(`${BASE_URL}/searchnearby?lat=${lat}&lng=${lng}`, {
      headers: await authHeader(),
      signal,
    });
    if (res.status === 404) return [];
    if (!res.ok) throw httpError("Nearby search failed", res.status);
    const data = await res.json();
    return data.places ?? [];
  },
};
