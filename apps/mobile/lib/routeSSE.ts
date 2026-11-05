import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
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

// ─── Shared, ref-counted multiplexer ──────────────────────────────────────────
// Each (routeId, timeEpoch) pair gets ONE EventSource shared by every chip that
// wants it, rather than one socket per mounted TransitChipLive (the routes sheet
// renders many chips, so the old per-instance model opened ~16-20 sockets and a
// reconnect storm whenever the list re-keyed). Mirrors lib/vehicleSSE.ts: the
// snapshot Map is mutated in place (O(changed) per delta) and a frozen copy is
// published to React subscribers on a 200ms trailing throttle.

type Setter = Dispatch<SetStateAction<Map<string, RouteSSEStop>>>;

// Stable empty reference handed to idle/initial subscribers so an unconnected
// chip doesn't churn. Never mutated — a real snapshot always allocates a fresh Map.
const EMPTY: Map<string, RouteSSEStop> = new Map();

const COALESCE_MS = 200;

interface RouteStream {
  routeId: string;
  timeEpoch: number;
  es: EventSource<"snapshot" | "update"> | null;
  opening: boolean;
  refCount: number;
  // Mutated in place; never handed to React directly.
  stops: Map<string, RouteSSEStop>;
  // Frozen copy refreshed lazily whenever `dirty` is set.
  published: Map<string, RouteSSEStop>;
  dirty: boolean;
  subs: Set<Setter>;
  broadcastTimer: ReturnType<typeof setTimeout> | null;
}

const _streams = new Map<string, RouteStream>();

function keyOf(routeId: string, timeEpoch: number): string {
  return `${routeId}::${timeEpoch}`;
}

function publishedOf(st: RouteStream): Map<string, RouteSSEStop> {
  if (st.dirty) {
    st.published = new Map(st.stops);
    st.dirty = false;
  }
  return st.published;
}

function notify(st: RouteStream): void {
  const pub = publishedOf(st);
  st.subs.forEach((set) => set(pub));
}

// Trailing throttle: bursty deliveries (reconnect snapshot + immediate delta)
// collapse into a single React commit per stream.
function scheduleBroadcast(st: RouteStream): void {
  if (st.broadcastTimer != null) return;
  st.broadcastTimer = setTimeout(() => {
    st.broadcastTimer = null;
    notify(st);
  }, COALESCE_MS);
}

function openStream(st: RouteStream): void {
  if (st.es || st.opening) return;
  st.opening = true;
  // Fetch the Supabase token before building the EventSource (headers are set at
  // construction). The opening flag prevents a double-open across the await; the
  // refCount/es re-checks abort if every subscriber left while we waited.
  // react-native-sse reuses these headers on auto-reconnect — fine while the
  // middleware is log-first; revisit before it hard-enforces.
  void (async () => {
    const headers = await authHeader();
    if (st.refCount === 0 || st.es) {
      st.opening = false;
      return;
    }
    const url = `${MIDDLEWARE_BASE}/api/v1/stream/route?route_id=${encodeURIComponent(st.routeId)}&time=${st.timeEpoch}`;
    const es = new EventSource<"snapshot" | "update">(url, {
      headers,
      pollingInterval: 3000,
    });
    st.es = es;
    st.opening = false;

    es.addEventListener("error", (e) => console.warn("[routeSSE] error", e));

    es.addEventListener("snapshot", (e) => {
      if (!e.data) return;
      const { data } = JSON.parse(e.data) as { data: RouteSSEStop[] };
      st.stops.clear();
      for (const stop of data) st.stops.set(stop.stop_id, stop);
      st.dirty = true;
      scheduleBroadcast(st);
    });

    es.addEventListener("update", (e) => {
      if (!e.data) return;
      const { added, updated, removed } = JSON.parse(e.data) as {
        added?: RouteSSEStop[];
        updated?: RouteSSEStop[];
        removed?: string[];
      };
      for (const id of removed ?? []) st.stops.delete(id);
      for (const s of [...(updated ?? []), ...(added ?? [])]) {
        st.stops.set(s.stop_id, s);
      }
      st.dirty = true;
      scheduleBroadcast(st);
    });
  })();
}

function closeStream(st: RouteStream): void {
  st.es?.close();
  st.es = null;
  st.opening = false;
  if (st.broadcastTimer != null) {
    clearTimeout(st.broadcastTimer);
    st.broadcastTimer = null;
  }
}

function acquire(routeId: string, timeEpoch: number, set: Setter): RouteStream {
  const k = keyOf(routeId, timeEpoch);
  let st = _streams.get(k);
  if (!st) {
    st = {
      routeId,
      timeEpoch,
      es: null,
      opening: false,
      refCount: 0,
      stops: new Map(),
      published: EMPTY,
      dirty: false,
      subs: new Set(),
      broadcastTimer: null,
    };
    _streams.set(k, st);
  }
  st.refCount++;
  st.subs.add(set);
  openStream(st);
  return st;
}

function release(routeId: string, timeEpoch: number, set: Setter): void {
  const k = keyOf(routeId, timeEpoch);
  const st = _streams.get(k);
  if (!st) return;
  st.subs.delete(set);
  st.refCount--;
  if (st.refCount <= 0) {
    closeStream(st);
    _streams.delete(k);
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
// Same signature/return as before — each TRANSIT step subscribes to the shared
// stream for its (routeId, timeEpoch). The returned Map reference is stable
// across events that don't change this route's stops, so chips only re-render
// when their own data actually moves.
export function useRouteLiveStops(
  routeId: string | undefined,
  timeEpoch: number | undefined,
): Map<string, RouteSSEStop> {
  const [stops, setStops] = useState<Map<string, RouteSSEStop>>(EMPTY);

  useEffect(() => {
    if (!routeId || !timeEpoch) {
      setStops(EMPTY);
      return;
    }
    const st = acquire(routeId, timeEpoch, setStops);
    setStops(publishedOf(st));
    return () => release(routeId, timeEpoch, setStops);
  }, [routeId, timeEpoch]);

  return stops;
}
