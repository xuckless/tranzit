import * as SecureStore from "expo-secure-store";
import type { StoredLocation } from "@/lib/routeStore";
import type { TripSession } from "@/types/trip";

// Durable pointer to the in-progress trip so the Commute screen can restore after the JS process is
// killed (background → OS reclaim → cold start), where the in-memory routeStore is empty. We persist
// only the pointer — session + endpoint labels/coords, all small and stable across reroutes — and
// re-fetch the authoritative Route from the backend snapshot (GET /trips/{id}) on restore.
// ponytail: single SecureStore key, blob <2KB so no chunking — reuse expo-secure-store, no new dep.

const KEY = "tranzit.activeTrip";

export interface ActiveTrip {
  session: TripSession;
  destination: StoredLocation;
  origin: StoredLocation;
}

export async function saveActiveTrip(t: ActiveTrip): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(t));
  } catch {
    // Best-effort: a failed persist just means no cross-kill restore for this trip.
  }
}

export async function loadActiveTrip(): Promise<ActiveTrip | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? (JSON.parse(raw) as ActiveTrip) : null;
  } catch {
    return null;
  }
}

export async function clearActiveTrip(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
  } catch {
    // ignore
  }
}
