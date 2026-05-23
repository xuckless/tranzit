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
let _snapshot: VehiclePosition[] = [];

type Setter = React.Dispatch<React.SetStateAction<VehiclePosition[]>>;
const _subs = new Set<Setter>();

function isValidVehicle(v: VehiclePosition): boolean {
  return (
    !!v.vehicle_id &&
    v.latitude != null &&
    v.longitude != null &&
    v.trip_id != null &&
    v.route_id != null &&
    v.route_id !== ""
  );
}

function rebuildSnapshot(): void {
  const next: VehiclePosition[] = [];
  for (const v of _vehicleMap.values()) {
    if (isValidVehicle(v)) next.push(v);
  }
  _snapshot = next;
}

function broadcast(): void {
  rebuildSnapshot();
  _subs.forEach((set) => set(_snapshot));
}

function applySnapshot(vehicles: VehiclePosition[]): void {
  _vehicleMap.clear();
  for (const v of vehicles) {
    if (!isValidVehicle(v)) continue;
    _vehicleMap.set(v.vehicle_id!, v);
  }
}

function applyUpdate(
  added?: VehiclePosition[],
  updated?: VehiclePosition[],
  removed?: string[],
): void {
  for (const vid of removed ?? []) _vehicleMap.delete(vid);
  for (const v of updated ?? []) {
    if (v.vehicle_id && _vehicleMap.has(v.vehicle_id)) {
      _vehicleMap.set(v.vehicle_id, v);
    }
  }
  for (const v of added ?? []) {
    if (!isValidVehicle(v)) continue;
    _vehicleMap.set(v.vehicle_id!, v);
  }
}

function openSSE(): void {
  if (_es) return;
  const es = new EventSource<"snapshot" | "update">(SSE_URL, {
    pollingInterval: 3000,
  });
  _es = es;

  es.addEventListener("open", () => console.log("[vehicleSSE] connected"));
  es.addEventListener("error", (e) => console.warn("[vehicleSSE] error", e));

  es.addEventListener("snapshot", (e) => {
    if (!e.data) return;
    const { data } = JSON.parse(e.data) as { count: number; data: VehiclePosition[] };
    applySnapshot(data);
    broadcast();
  });

  es.addEventListener("update", (e) => {
    if (!e.data) return;
    const { added, updated, removed } = JSON.parse(e.data) as {
      added?: VehiclePosition[];
      updated?: VehiclePosition[];
      removed?: string[];
    };
    applyUpdate(added, updated, removed);
    broadcast();
  });
}

function closeSSE(): void {
  _es?.close();
  _es = null;
  // Intentionally NOT clearing _vehicleMap — React Strict Mode briefly drops
  // _refCount to 0 during dev remounts. State is only reset by applySnapshot().
}

// ─── Hook ────────────────────────────────────────────────────────────────────

/**
 * Subscribe to the live vehicle stream. Returns the current vehicle snapshot
 * as a fresh array reference on every SSE event. Convert to GeoJSON in the
 * consumer via useMemo.
 */
export function useVehicles(): VehiclePosition[] {
  const [vehicles, setVehicles] = useState<VehiclePosition[]>(() => _snapshot);

  useEffect(() => {
    _refCount++;
    _subs.add(setVehicles);
    openSSE();
    setVehicles(_snapshot);

    return () => {
      _subs.delete(setVehicles);
      _refCount--;
      if (_refCount === 0) closeSSE();
    };
  }, []);

  return vehicles;
}

// ─── GeoJSON conversion helper ────────────────────────────────────────────────

export interface VehicleFeatureProps {
  vehicle_id: string;
  trip_id: string;
  route_id: string;
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
        trip_id: v.trip_id!,
        route_id: v.route_id!,
        bearing: v.bearing ?? 0,
      },
      geometry: {
        type: "Point",
        coordinates: [v.longitude!, v.latitude!],
      },
    })),
  };
}
