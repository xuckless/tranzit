import { getCachedTransitStops, cacheTransitStops } from "./db";
import { middlewareQuery } from "./middleware";
import type { CalgaryTransitStop } from "@/types/database";

// Deduplicates concurrent calls so only one network request fires on a cold cache.
let _inflight: Promise<CalgaryTransitStop[]> | null = null;

export async function loadAndCacheStops(): Promise<CalgaryTransitStop[]> {
  const cached = await getCachedTransitStops();
  if (cached) return cached;

  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      const stops = await middlewareQuery<CalgaryTransitStop>(
        "calgary_transit_stops",
        { limit: 10000 },
      );
      await cacheTransitStops(stops);
      return stops;
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}
