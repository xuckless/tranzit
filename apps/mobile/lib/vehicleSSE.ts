import { useEffect, useState } from "react";
import EventSource from "react-native-sse";
import type { VehiclePosition } from "@/types/database";

const SSE_URL =
  "https://tranzit-db-middleware-000000000000.us-central1.run.app/api/v1/vehicle_positions";

// ─── Module-level connection state ────────────────────────────────────────────
// Single shared EventSource across all subscribers. The pool/slot pattern is
// gone — Mapbox/MapLibre ShapeSources are diffed natively against the previous
// FeatureCollection, so there is no native-tree-stability requirement on our
// side. Subscribers receive a fresh VehiclePosition[] reference on every event.

let _es: EventSource<"snapshot" | "update"> | null = null;
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

function sameVehicleArray(a: VehiclePosition[], b: VehiclePosition[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function filterByRoutes(routeIdSet: Set<string>): VehiclePosition[] {
  if (routeIdSet.size === 0) return [];
  return _snapshot.filter(
    (v) => v.route_id != null && routeIdSet.has(v.route_id),
  );
}

function notifySubscribers(): void {
  const published = publishedSnapshot();
  _subs.forEach((set) => set(published));
  for (const sub of _selectorSubs) {
    const filtered = filterByRoutes(sub.routeIdSet);
    // Vehicle objects are replaced (never mutated) on update, so element-wise
    // reference equality is a sound "did my routes change" check. Unchanged →
    // keep the previous array reference so the subscriber's setState bails out.
    if (sameVehicleArray(filtered, sub.last)) continue;
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
  if (_es) return;
  const es = new EventSource<"snapshot" | "update">(SSE_URL, {
    pollingInterval: 3000,
  });
  _es = es;

  es.addEventListener("error", (e) => console.warn("[vehicleSSE] error", e));

  es.addEventListener("snapshot", (e) => {
    if (!e.data) return;
    const { data } = JSON.parse(e.data) as { count: number; data: VehiclePosition[] };
    applySnapshot(data);
    scheduleBroadcast();
  });

  es.addEventListener("update", (e) => {
    if (!e.data) return;
    const { added, updated, removed } = JSON.parse(e.data) as {
      added?: VehiclePosition[];
      updated?: VehiclePosition[];
      removed?: string[];
    };
    applyUpdate(added, updated, removed);
    scheduleBroadcast();
  });
}

function closeSSE(): void {
  _es?.close();
  _es = null;
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
