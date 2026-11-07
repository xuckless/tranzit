import { useEffect, useState } from "react";
import EventSource from "react-native-sse";
import type { VehiclePosition } from "@/types/database";
import { authHeader } from "@/lib/supabase";

import { VEHICLE_SSE_URL as SSE_URL } from "@/lib/config";

// ─── Module-level connection state ────────────────────────────────────────────
// Single shared EventSource across all subscribers. The pool/slot pattern is
// gone — Mapbox/MapLibre ShapeSources are diffed natively against the previous
// FeatureCollection, so there is no native-tree-stability requirement on our
// side. Subscribers receive a fresh VehiclePosition[] reference on every event.

let _es: EventSource<"snapshot" | "update"> | null = null;
let _opening = false;
let _refCount = 0;

const _vehicleMap = new Map<string, VehiclePosition>();

// _snapshot holds only valid vehicles and is maintained incrementally
// (O(changed) per delta, not O(fleet)). It is mutated in place, so it can
// never be handed to React directly — _published is the frozen copy that
// subscribers receive, refreshed lazily whenever _dirty is set.
let _snapshot: VehiclePosition[] = [];
const _indexById = new Map<string, number>();
let _published: VehiclePosition[] = [];
let _dirty = false;

// ─── Connection status ────────────────────────────────────────────────────────
// connecting   → opening the stream, no data yet
// live         → stream open / data arriving
// reconnecting → stream errored after having been live; react-native-sse retries
// offline      → repeated failures (or never connected); still retrying

export type VehicleStreamStatus = "connecting" | "live" | "reconnecting" | "offline";

const OFFLINE_AFTER_ERRORS = 3;
let _status: VehicleStreamStatus = "connecting";
let _consecutiveErrors = 0;
let _everLive = false;
const _statusSubs = new Set<(s: VehicleStreamStatus) => void>();

function setStatus(next: VehicleStreamStatus): void {
  if (_status === next) return;
  _status = next;
  _statusSubs.forEach((fn) => fn(next));
}

function markLive(): void {
  _consecutiveErrors = 0;
  _everLive = true;
  setStatus("live");
}

function markError(): void {
  _consecutiveErrors++;
  setStatus(
    _consecutiveErrors >= OFFLINE_AFTER_ERRORS || !_everLive ? "offline" : "reconnecting",
  );
}

export function getVehicleStreamStatus(): VehicleStreamStatus {
  return _status;
}

type Setter = React.Dispatch<React.SetStateAction<VehiclePosition[]>>;
const _subs = new Set<Setter>();

interface SelectorSub {
  routeIdSet: Set<string>;
  last: VehiclePosition[];
  set: Setter;
}
const _selectorSubs = new Set<SelectorSub>();

// Only require fields needed to render a marker. Per the middleware spec,
// `route_id` is nullable for vehicles between trips (deadheading, layover, etc.)
// and `trip_id` may also be absent in some states. Tracking these as invalid
// would drop ~90% of the live fleet from the map.
function isValidVehicle(v: VehiclePosition): boolean {
  return !!v.vehicle_id && v.latitude != null && v.longitude != null;
}

function upsertSnapshot(v: VehiclePosition): void {
  const idx = _indexById.get(v.vehicle_id!);
  if (idx != null) {
    _snapshot[idx] = v;
  } else {
    _indexById.set(v.vehicle_id!, _snapshot.length);
    _snapshot.push(v);
  }
  _dirty = true;
}

function removeFromSnapshot(vid: string): void {
  const idx = _indexById.get(vid);
  if (idx == null) return;
  const lastIdx = _snapshot.length - 1;
  if (idx !== lastIdx) {
    const last = _snapshot[lastIdx];
    _snapshot[idx] = last;
    _indexById.set(last.vehicle_id!, idx);
  }
  _snapshot.pop();
  _indexById.delete(vid);
  _dirty = true;
}

function publishedSnapshot(): VehiclePosition[] {
  if (_dirty) {
    _published = _snapshot.slice();
    _dirty = false;
  }
  return _published;
}

function filterByRoutes(routeIdSet: Set<string>): VehiclePosition[] {
  if (routeIdSet.size === 0) return [];
  return _snapshot.filter(
    (v) => v.route_id != null && routeIdSet.has(v.route_id),
  );
}

// Single O(n) scan over _snapshot that returns true only when the filtered
// result would differ from prev — avoids allocating a new array on every tick
// when no tracked bus moved.
function routesChanged(routeIdSet: Set<string>, prev: VehiclePosition[]): boolean {
  if (routeIdSet.size === 0) return prev.length !== 0;
  let i = 0;
  for (const v of _snapshot) {
    if (v.route_id != null && routeIdSet.has(v.route_id)) {
      if (i >= prev.length || v !== prev[i]) return true;
      i++;
    }
  }
  return i !== prev.length;
}

function notifySubscribers(): void {
  const published = publishedSnapshot();
  _subs.forEach((set) => set(published));
  for (const sub of _selectorSubs) {
    // Check first without allocating; only build the new array when something changed.
    if (!routesChanged(sub.routeIdSet, sub.last)) continue;
    const filtered = filterByRoutes(sub.routeIdSet);
    sub.last = filtered;
    sub.set(filtered);
  }
}

// Trailing throttle: bursty SSE deliveries (e.g. reconnect snapshot followed
// by an immediate delta) collapse into a single React commit. At the normal
// 3s server cadence this adds at most COALESCE_MS of latency per tick.
const COALESCE_MS = 200;
let _broadcastTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleBroadcast(): void {
  if (_broadcastTimer != null) return;
  _broadcastTimer = setTimeout(() => {
    _broadcastTimer = null;
    notifySubscribers();
  }, COALESCE_MS);
}

function applySnapshot(vehicles: VehiclePosition[]): void {
  _vehicleMap.clear();
  _snapshot.length = 0;
  _indexById.clear();
  _dirty = true;
  for (const v of vehicles) {
    if (!isValidVehicle(v)) continue;
    _vehicleMap.set(v.vehicle_id!, v);
    _indexById.set(v.vehicle_id!, _snapshot.length);
    _snapshot.push(v);
  }
}

function applyUpdate(
  added?: VehiclePosition[],
  updated?: VehiclePosition[],
  removed?: string[],
): void {
  for (const vid of removed ?? []) {
    _vehicleMap.delete(vid);
    removeFromSnapshot(vid);
  }
  for (const v of updated ?? []) {
    if (!v.vehicle_id || !_vehicleMap.has(v.vehicle_id)) continue;
    _vehicleMap.set(v.vehicle_id, v);
    // An update can null out coordinates; keep it in the map (so later
    // updates still apply) but drop it from the rendered snapshot.
    if (isValidVehicle(v)) upsertSnapshot(v);
    else removeFromSnapshot(v.vehicle_id);
  }
  for (const v of added ?? []) {
    if (!isValidVehicle(v)) continue;
    _vehicleMap.set(v.vehicle_id!, v);
    upsertSnapshot(v);
  }
}

function openSSE(): void {
  if (_es || _opening) return;
  _opening = true;
  // Fetch the Supabase token before building the EventSource (headers are set at
  // construction). The _opening flag prevents a double-open across the await; the
  // _refCount/_es re-checks abort if every subscriber left while we waited.
  // react-native-sse reuses these headers on auto-reconnect, so a token expiring
  // on this long-lived stream would fail to reconnect once the middleware hard-
  // enforces — acceptable while it is log-first; revisit before the flip.
  if (_status !== "live") setStatus(_everLive ? "reconnecting" : "connecting");
  void (async () => {
    let headers: Record<string, string> = {};
    try {
      headers = await authHeader();
    } catch (e) {
      console.warn("[vehicleSSE] auth header failed", e);
    }
    if (_refCount === 0 || _es) {
      _opening = false;
      return;
    }
    const es = new EventSource<"snapshot" | "update">(SSE_URL, {
      headers,
      pollingInterval: 3000,
    });
    _es = es;
    _opening = false;

    es.addEventListener("open", () => markLive());

    es.addEventListener("error", (e) => {
      console.warn("[vehicleSSE] error", e);
      markError();
    });

    es.addEventListener("snapshot", (e) => {
      if (!e.data) return;
      try {
        const { data } = JSON.parse(e.data) as { count: number; data: VehiclePosition[] };
        applySnapshot(data ?? []);
        markLive();
        scheduleBroadcast();
      } catch (err) {
        console.warn("[vehicleSSE] bad snapshot", err);
      }
    });

    es.addEventListener("update", (e) => {
      if (!e.data) return;
      try {
        const { added, updated, removed } = JSON.parse(e.data) as {
          added?: VehiclePosition[];
          updated?: VehiclePosition[];
          removed?: string[];
        };
        applyUpdate(added, updated, removed);
        markLive();
        scheduleBroadcast();
      } catch (err) {
        console.warn("[vehicleSSE] bad update", err);
      }
    });
  })();
}

function closeSSE(): void {
  _es?.close();
  _es = null;
  _opening = false;
  if (_broadcastTimer != null) {
    clearTimeout(_broadcastTimer);
    _broadcastTimer = null;
  }
  // Intentionally NOT clearing _vehicleMap — React Strict Mode briefly drops
  // _refCount to 0 during dev remounts. State is only reset by applySnapshot().
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

/**
 * Subscribe to the live vehicle stream. Returns the current vehicle snapshot
 * as a fresh array reference on every SSE event. Convert to GeoJSON in the
 * consumer via useMemo.
 */
export function useVehicles(): VehiclePosition[] {
  const [vehicles, setVehicles] = useState<VehiclePosition[]>(() =>
    publishedSnapshot(),
  );

  useEffect(() => {
    _refCount++;
    _subs.add(setVehicles);
    openSSE();
    setVehicles(publishedSnapshot());

    return () => {
      _subs.delete(setVehicles);
      _refCount--;
      if (_refCount === 0) closeSSE();
    };
  }, []);

  return vehicles;
}

/**
 * Subscribe to the live vehicle stream filtered to the given route IDs.
 * Unlike useVehicles, the returned array reference is stable across SSE
 * events that don't touch any of the selected routes, so a screen showing
 * a handful of buses doesn't re-render on every fleet-wide tick. Filtering
 * and change detection happen inside the store, not in render.
 */
export function useVehiclesForRoutes(routeIds: string[]): VehiclePosition[] {
  // Route IDs are GTFS identifiers (no commas), so a sorted join is a stable
  // identity key regardless of the caller's array ordering/reference churn.
  const key = [...routeIds].sort().join(",");
  const [vehicles, setVehicles] = useState<VehiclePosition[]>([]);

  useEffect(() => {
    const sub: SelectorSub = {
      routeIdSet: new Set(key ? key.split(",") : []),
      last: [],
      set: setVehicles,
    };
    _refCount++;
    _selectorSubs.add(sub);
    openSSE();
    sub.last = filterByRoutes(sub.routeIdSet);
    setVehicles(sub.last);

    return () => {
      _selectorSubs.delete(sub);
      _refCount--;
      if (_refCount === 0) closeSSE();
    };
  }, [key]);

  return vehicles;
}

/**
 * Connection status of the shared vehicle stream. Does not itself open the
 * stream — pair it with useVehicles()/useVehiclesForRoutes().
 */
export function useVehicleStreamStatus(): VehicleStreamStatus {
  const [status, set] = useState<VehicleStreamStatus>(() => _status);
  useEffect(() => {
    _statusSubs.add(set);
    set(_status);
    return () => {
      _statusSubs.delete(set);
    };
  }, []);
  return status;
}

// ─── GeoJSON conversion helper ────────────────────────────────────────────────

export interface VehicleFeatureProps {
  vehicle_id: string;
  trip_id: string;       // empty string for vehicles between trips
  route_id: string;      // empty string for vehicles not currently on a route
  bearing: number;
}

export interface VehicleFeatureCollection {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: VehicleFeatureProps;
    geometry: { type: "Point"; coordinates: [number, number] };
  }>;
}

export function vehiclesToGeoJSON(
  vehicles: VehiclePosition[],
): VehicleFeatureCollection {
  return {
    type: "FeatureCollection",
    features: vehicles.map((v) => ({
      type: "Feature",
      properties: {
        vehicle_id: v.vehicle_id!,
        trip_id: v.trip_id ?? "",
        route_id: v.route_id ?? "",
        bearing: v.bearing ?? 0,
      },
      geometry: {
        type: "Point",
        coordinates: [v.longitude!, v.latitude!],
      },
    })),
  };
}
