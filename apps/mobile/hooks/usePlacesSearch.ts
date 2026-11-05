import { useState, useCallback, useRef } from "react";
import type { PlaceResult, PlacesSearchResponse } from "../types/places";

import { ROUTE_SERVICE_URL as BASE_URL } from "@/lib/config";
const DEBOUNCE_MS = 350;

interface UserLocation {
  latitude: number;
  longitude: number;
}
type SearchState =
  | { status: "idle" }
  | { status: "loading"; query: string }
  | { status: "success"; results: PlaceResult[]; query: string }
  | { status: "empty"; query: string }
  | { status: "error"; message: string; query: string };

export function usePlacesSearch(userLocation?: UserLocation | null) {
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const search = useCallback(
    (query: string) => {
      const trimmed = query.trim();

      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();

      if (!trimmed) {
        setState({ status: "idle" });
        return;
      }

      setState({ status: "loading", query: trimmed });

      debounceRef.current = setTimeout(async () => {
        const controller = new AbortController();
        abortRef.current = controller;

        try {
          let url = `${BASE_URL}/search?q=${encodeURIComponent(trimmed)}`;

          if (userLocation) {
            url += `&lat=${userLocation.latitude}&lng=${userLocation.longitude}`;
          }

          const res = await fetch(url, { signal: controller.signal });

          if (res.status === 404) {
            setState({ status: "empty", query: trimmed });
            return;
          }
          if (!res.ok) throw new Error(`Search failed: ${res.status}`);

          const data: PlacesSearchResponse = await res.json();
          const places = data.places ?? [];

          setState(
            places.length > 0
              ? { status: "success", results: places, query: trimmed }
              : { status: "empty", query: trimmed },
          );
        } catch (err: unknown) {
          if (err instanceof Error && err.name === "AbortError") return;
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Unknown error",
            query: trimmed,
          });
        }
      }, DEBOUNCE_MS);
    },
    [userLocation],
  );

  const reset = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
    setState({ status: "idle" });
  }, []);

  return { state, search, reset };
}
