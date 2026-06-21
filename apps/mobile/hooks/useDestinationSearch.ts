import { useState, useCallback, useRef } from "react";
import type { PlacesSearchResponse, SearchSuggestion } from "../types/places";

const BASE_URL =
  "https://tranzit-route-service.tailnet-example.ts.net";

// /search fires quickly for near-instant business results
const INSTANT_MS = 150;
// /autocomplete/json fires after a longer pause to limit API usage;
// this is also the source that covers street addresses
const AUTOCOMPLETE_MS = 600;

interface UserLocation {
  latitude: number;
  longitude: number;
}

interface AutocompletePrediction {
  place_id: string;
  structured_formatting: {
    main_text: string;
    secondary_text?: string;
  };
}

type Status = "idle" | "loading" | "success" | "empty";

export function useDestinationSearch(userLocation?: UserLocation | null) {
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [status, setStatus] = useState<Status>("idle");

  const instantTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const acTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Prevents stale async responses from a previous query updating state
  const currentQueryRef = useRef("");

  const search = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      currentQueryRef.current = trimmed;

      if (instantTimerRef.current) clearTimeout(instantTimerRef.current);
      if (acTimerRef.current) clearTimeout(acTimerRef.current);
      abortRef.current?.abort();

      if (!trimmed) {
        setSuggestions([]);
        setStatus("idle");
        return;
      }

      setStatus("loading");
      const controller = new AbortController();
      abortRef.current = controller;

      // Queries that start with a digit are street addresses.
      // /search returns businesses on that street, not the specific address —
      // skip it entirely and go straight to /autocomplete/json.
      const isAddressQuery = /^\d/.test(trimmed);

      // Mutable buckets shared by both timer closures for this query
      let instant: SearchSuggestion[] = [];
      let autocomplete: SearchSuggestion[] = [];

      function merge() {
        const seen = new Set<string>();
        const merged: SearchSuggestion[] = [];
        for (const s of [...instant, ...autocomplete]) {
          if (!seen.has(s.placeId)) {
            seen.add(s.placeId);
            merged.push(s);
          }
        }
        setSuggestions(merged);
        setStatus(merged.length > 0 ? "success" : "empty");
      }

      // ── Phase 1: instant /search (POI/business queries only) ─────────────────
      // Skipped for address queries — /search returns businesses on the street,
      // not the specific address number the user typed.
      if (!isAddressQuery) {
        instantTimerRef.current = setTimeout(async () => {
          if (currentQueryRef.current !== trimmed) return;
          try {
            let url = `${BASE_URL}/search?q=${encodeURIComponent(trimmed)}`;
            if (userLocation) {
              url += `&lat=${userLocation.latitude}&lng=${userLocation.longitude}`;
            }
            const res = await fetch(url, { signal: controller.signal });
            if (controller.signal.aborted) return;
            if (res.ok) {
              const data: PlacesSearchResponse = await res.json();
              instant = (data.places ?? []).map((p) => ({
                placeId: p.id,
                mainText: p.displayName.text,
                secondaryText: p.formattedAddress,
                location: p.location,
              }));
            }
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") return;
            console.error("[search] instant search failed:", e);
          }
          if (instant.length > 0) merge();
        }, INSTANT_MS);
      }

      // ── Phase 2: /autocomplete/json ───────────────────────────────────────────
      // Always finalises the result list. Fires faster for address queries since
      // phase 1 is skipped and the user needs a quick response.
      acTimerRef.current = setTimeout(
        async () => {
          if (currentQueryRef.current !== trimmed) return;
          try {
            const res = await fetch(
              `${BASE_URL}/autocomplete/json?input=${encodeURIComponent(trimmed)}`,
              { signal: controller.signal },
            );
            if (controller.signal.aborted) return;
            if (res.ok) {
              const data = await res.json();
              autocomplete = (data.predictions ?? []).map(
                (p: AutocompletePrediction) => ({
                  placeId: p.place_id,
                  mainText: p.structured_formatting.main_text,
                  secondaryText: p.structured_formatting.secondary_text,
                }),
              );
            }
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") return;
            console.error("[search] autocomplete failed:", e);
          }
          merge();
        },
        isAddressQuery ? 300 : AUTOCOMPLETE_MS,
      );
    },
    [userLocation],
  );

  const reset = useCallback(() => {
    if (instantTimerRef.current) clearTimeout(instantTimerRef.current);
    if (acTimerRef.current) clearTimeout(acTimerRef.current);
    abortRef.current?.abort();
    setSuggestions([]);
    setStatus("idle");
  }, []);

  return { suggestions, status, search, reset };
}
