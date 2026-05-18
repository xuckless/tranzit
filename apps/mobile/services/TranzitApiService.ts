import type {
  PlaceResult,
  PlacesSearchResponse,
  RouteResponse,
  RouteRequest,
} from "../types/places";

// Set EXPO_PUBLIC_USE_LOCAL=true in .env.local to target localhost:3100
const BASE_URL =
  process.env.EXPO_PUBLIC_USE_LOCAL === "true"
    ? "http://localhost:3100"
    : "https://tranzit-route-service-000000000000.us-central1.run.app";

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
    const res = await fetch(url, { signal });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    const data: PlacesSearchResponse = await res.json();
    return data.places;
  },

  async getPlaceDetails(
    placeId: string,
    signal?: AbortSignal,
  ): Promise<PlaceResult> {
    const res = await fetch(`${BASE_URL}/details`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ place_id: placeId }),
      signal,
    });
    if (!res.ok) throw new Error(`Details failed: ${res.status}`);
    return res.json() as Promise<PlaceResult>;
  },

  async getRoute(
    request: RouteRequest,
    signal?: AbortSignal,
  ): Promise<RouteResponse> {
    const res = await fetch(`${BASE_URL}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
    if (!res.ok) throw new Error(`Route failed: ${res.status}`);
    return res.json() as Promise<RouteResponse>;
  },
};
