import { useState, useCallback, useRef } from "react";
import type { PlacesSearchResponse, SearchSuggestion } from "../types/places";
import { authHeader } from "../lib/supabase";
import { fetchWithTimeout } from "@/lib/middleware";

import { ROUTE_SERVICE_URL as BASE_URL } from "@/lib/config";

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

type Status = "idle" | "loading" | "success" | "empty" | "error";

export function useDestinationSearch(userLocation?: UserLocation | null) {
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [status, setStatus] = useState<Status>("idle");

  const instantTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const acTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Prevents stale async responses from a previous query updating state
  const currentQueryRef = useRef("");
  // Last raw query, so retry() can re-run it after a network failure
  const lastQueryRef = useRef("");

  const search = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      currentQueryRef.current = trimmed;
      lastQueryRef.current = query;

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
      // Phase failures (network error / timeout / 5xx). If every phase that ran
      // failed and nothing came back, report "error" instead of "empty".
      let instantFailed = false;
      let autocompleteFailed = false;

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
        const allFailed =
          autocompleteFailed && (isAddressQuery || instantFailed);
        setStatus(merged.length > 0 ? "success" : allFailed ? "error" : "empty");
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
            const res = await fetchWithTimeout(url, {
              headers: await authHeader(),
              signal: controller.signal,
            });
            if (controller.signal.aborted) return;
            if (res.ok) {
              const data: PlacesSearchResponse = await res.json();
              instant = (data.places ?? []).map((p) => ({
                placeId: p.id,
                mainText: p.displayName.text,
                secondaryText: p.formattedAddress,
                location: p.location,
              }));
            } else if (res.status !== 404) {
              instantFailed = true;
            }
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") return;
            instantFailed = true;
            console.warn("[search] instant search failed:", e);
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
            const res = await fetchWithTimeout(
              `${BASE_URL}/autocomplete/json?input=${encodeURIComponent(trimmed)}`,
              { headers: await authHeader(), signal: controller.signal },
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
            } else if (res.status !== 404) {
              autocompleteFailed = true;
            }
          } catch (e) {
            if (e instanceof Error && e.name === "AbortError") return;
            autocompleteFailed = true;
            console.warn("[search] autocomplete failed:", e);
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

  const retry = useCallback(() => {
    if (lastQueryRef.current.trim()) search(lastQueryRef.current);
  }, [search]);

  return { suggestions, status, search, reset, retry };
}
