import { useEffect, useState } from "react";
import EventSource from "react-native-sse";
import type { VehiclePosition } from "@/types/database";

const SSE_URL =
  "https://tranzit-db-middleware-000000000000.us-central1.run.app/api/v1/vehicle_positions";

// ─── Module-level singleton ───────────────────────────────────────────────────
// One SSE connection is shared across all consumers (map.tsx, commute.tsx, etc.)
// so we never open duplicate connections when multiple tabs are mounted.

let _es: EventSource<"snapshot" | "update"> | null = null;
let _snapshot: VehiclePosition[] = [];
let _refCount = 0;
const _subs = new Set<React.Dispatch<React.SetStateAction<VehiclePosition[]>>>();

function broadcast(next: VehiclePosition[]) {
  _snapshot = next;
  _subs.forEach((set) => set([...next]));
}

function openSSE() {
  if (_es) return;
  const es = new EventSource<"snapshot" | "update">(SSE_URL);
  _es = es;

  es.addEventListener("snapshot", (e) => {
    if (!e.data) return;
    const { data } = JSON.parse(e.data) as {
      count: number;
      data: VehiclePosition[];
    };
    broadcast(data);
  });

  es.addEventListener("update", (e) => {
    if (!e.data) return;
    const { added, updated, removed } = JSON.parse(e.data) as {
      added: VehiclePosition[];
      updated: VehiclePosition[];
      removed: string[];
    };
    const removedSet = new Set(removed);
    const updMap = new Map(updated.map((v) => [v.vehicle_id, v]));
    broadcast([
      ..._snapshot
        .filter((v) => !removedSet.has(v.vehicle_id))
        .map((v) => updMap.get(v.vehicle_id) ?? v),
      ...added,
    ]);
  });
}

function closeSSE() {
  _es?.close();
  _es = null;
  _snapshot = [];
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useVehicleSSE(): VehiclePosition[] {
  const [vehicles, setVehicles] = useState<VehiclePosition[]>(_snapshot);

  useEffect(() => {
    _refCount++;
    _subs.add(setVehicles);
    openSSE();
    // Deliver cached snapshot immediately if connection was already open
    if (_snapshot.length > 0) setVehicles([..._snapshot]);

    return () => {
      _subs.delete(setVehicles);
      _refCount--;
      if (_refCount === 0) closeSSE();
    };
  }, []);

  return vehicles;
}
