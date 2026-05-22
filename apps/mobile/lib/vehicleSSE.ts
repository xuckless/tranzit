import { useEffect, useState } from "react";
import EventSource from "react-native-sse";
import type { VehiclePosition } from "@/types/database";

const SSE_URL =
  "https://tranzit-db-middleware-000000000000.us-central1.run.app/api/v1/vehicle_positions";

export const BUS_POOL_SIZE = 400;

// ─── Stable in-memory state ───────────────────────────────────────────────────
// Each vehicle_id is permanently assigned a pool slot index that never changes.
// SSE delta updates patch only the affected vehicles — no array reshuffling,
// no slot reassignment, no index-driven flicker.
// Freed slots are recycled via _freeSlots to prevent unbounded growth.

let _es: EventSource<"snapshot" | "update"> | null = null;
let _refCount = 0;

const _vehicleMap = new Map<string, VehiclePosition>();
const _slotMap    = new Map<string, number>();
const _freeSlots: number[] = [];
let   _nextSlot = 0;

type PoolSetter = React.Dispatch<React.SetStateAction<(VehiclePosition | null)[]>>;
const _subs = new Set<PoolSetter>();

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

function assignSlot(vehicleId: string): void {
  if (_slotMap.has(vehicleId)) return;
  const slot = _freeSlots.length > 0 ? _freeSlots.pop()! : _nextSlot++;
  if (slot < BUS_POOL_SIZE) _slotMap.set(vehicleId, slot);
}

function releaseSlot(vehicleId: string): void {
  const slot = _slotMap.get(vehicleId);
  if (slot !== undefined) _freeSlots.push(slot);
  _slotMap.delete(vehicleId);
  _vehicleMap.delete(vehicleId);
}

function getPool(): (VehiclePosition | null)[] {
  const pool = new Array<VehiclePosition | null>(BUS_POOL_SIZE).fill(null);
  for (const [vid, v] of _vehicleMap) {
    const slot = _slotMap.get(vid);
    if (slot !== undefined) pool[slot] = v;
  }
  return pool;
}

function broadcast(): void {
  const pool = getPool();
  _subs.forEach((set) => set(pool));
}

function applySnapshot(vehicles: VehiclePosition[]): void {
  _vehicleMap.clear();
  _slotMap.clear();
  _freeSlots.length = 0;
  _nextSlot = 0;
  for (const v of vehicles) {
    if (!isValidVehicle(v)) continue;
    assignSlot(v.vehicle_id!);
    _vehicleMap.set(v.vehicle_id!, v);
  }
}

function applyUpdate(
  added?: VehiclePosition[],
  updated?: VehiclePosition[],
  removed?: string[],
): void {
  for (const vid of removed ?? []) releaseSlot(vid);
  for (const v of updated ?? []) {
    if (v.vehicle_id && _vehicleMap.has(v.vehicle_id)) _vehicleMap.set(v.vehicle_id, v);
  }
  for (const v of added ?? []) {
    if (!isValidVehicle(v)) continue;
    assignSlot(v.vehicle_id!);
    _vehicleMap.set(v.vehicle_id!, v);
  }
}

function openSSE(): void {
  if (_es) return;
  const es = new EventSource<"snapshot" | "update">(SSE_URL, {
    pollingInterval: 3000, // wait 3 s before reconnecting after a drop
  });
  _es = es;

  es.addEventListener("open",  () => console.log("[vehicleSSE] connected"));
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
  // Intentionally NOT clearing _vehicleMap/_slotMap here.
  // React Strict Mode temporarily drops _refCount to 0 during dev remounts.
  // Clearing would wipe all vehicle state; buses would vanish until the next
  // SSE snapshot (~30 s). State is only reset inside applySnapshot().
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useVehicleSSE(): (VehiclePosition | null)[] {
  const [pool, setPool] = useState<(VehiclePosition | null)[]>(() => getPool());

  useEffect(() => {
    _refCount++;
    _subs.add(setPool);
    openSSE();
    setPool(getPool()); // deliver current state immediately if already connected

    return () => {
      _subs.delete(setPool);
      _refCount--;
      if (_refCount === 0) closeSSE();
    };
  }, []);

  return pool;
}
