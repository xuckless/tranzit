import { useEffect, useState } from "react";
import EventSource from "react-native-sse";
import { authHeader } from "@/lib/supabase";

const MIDDLEWARE_BASE =
  "https://tranzit-db-middleware.tailnet-example.ts.net";

export interface RouteSSEStop {
  route_id: string;
  trip_id: string;
  stop_id: string;
  stop_lat: number;
  stop_lng: number;
  arrival_time: number | null;
  departure_time: number | null;
  // Feed-authoritative GTFS-RT delay (seconds, nullable). Added to the route
  // stream by the middleware — prefer these over diffing predicted vs. scheduled
  // timestamps client-side.
  arrival_delay: number | null;
  departure_delay: number | null;
}

// Per-instance hook — each TRANSIT step opens its own connection to a unique
// (routeId, timeEpoch) pair. No module-level singleton needed here.
export function useRouteLiveStops(
  routeId: string | undefined,
  timeEpoch: number | undefined,
): Map<string, RouteSSEStop> {
  const [stops, setStops] = useState<Map<string, RouteSSEStop>>(
    () => new Map(),
  );

  useEffect(() => {
    if (!routeId || !timeEpoch) return;

    let es: EventSource<"snapshot" | "update"> | null = null;
    let cancelled = false;

    // Fetch the Supabase token before connecting (the EventSource is built with
    // headers up front). react-native-sse reuses these headers on auto-reconnect,
    // so a token expiring mid-stream would fail to reconnect once the middleware
    // hard-enforces — fine while it is log-first; revisit before the flip.
    void (async () => {
      const headers = await authHeader();
      if (cancelled) return;
      const url = `${MIDDLEWARE_BASE}/api/v1/stream/route?route_id=${encodeURIComponent(routeId)}&time=${timeEpoch}`;
      es = new EventSource<"snapshot" | "update">(url, {
        headers,
        pollingInterval: 3000,
      });

      es.addEventListener("snapshot", (e) => {
        if (!e.data) return;
        const { data } = JSON.parse(e.data) as { data: RouteSSEStop[] };
        const map = new Map<string, RouteSSEStop>();
        for (const stop of data) map.set(stop.stop_id, stop);
        setStops(map);
      });

      es.addEventListener("update", (e) => {
        if (!e.data) return;
        const { added, updated, removed } = JSON.parse(e.data) as {
          added?: RouteSSEStop[];
          updated?: RouteSSEStop[];
          removed?: string[];
        };
        setStops((prev) => {
          const next = new Map(prev);
          for (const id of removed ?? []) next.delete(id);
          for (const s of [...(updated ?? []), ...(added ?? [])]) next.set(s.stop_id, s);
          return next;
        });
      });
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [routeId, timeEpoch]);

  return stops;
}
