// Saved places live in the user DB (one address per category) with SQLite as an
// offline mirror. This module is the single API the UI uses; it hides the remote
// write order, the mirror write-through, and the pending-outbox retry.
//
// Backend constraints that shape this file:
//  • saved_addresses PK is (user_id, category_code) → one address per category.
//  • saved_addresses has a composite FK to user_defined_default_categories, which
//    FKs user_info. So writes MUST go user_info → category → address.
//  • category_code is a GLOBAL primary key, so it must be globally unique →
//    "${user_id}:${slug(name)}".
//  • Deletes are tombstoned locally (lib/db.ts) and replayed by pushPending, so an
//    offline delete survives the next fetch instead of resurrecting the place.

import type { User } from "@supabase/supabase-js";
import {
  middlewareUpsert,
  middlewareUserDelete,
  middlewareUserQuery,
} from "@/lib/middleware";
import { syncUserInfo } from "@/lib/userSync";
import { categoryIconFor } from "@/styles/categoryStyle";
import {
  isPermanentFailure,
  mirrorClearPending,
  mirrorReadPending,
  mirrorReadSavedPlaces,
  mirrorReplaceAll,
  mirrorUpsertSavedPlace,
  outboxHttpStatus,
  tombstoneDelete,
  tombstoneDrop,
  tombstoneRead,
  type SavedPlaceMirrorRow,
} from "@/lib/db";

// ─── Types ──────────────────────────────────────────────────────────────────

/** The UI shape for a saved place (a category and its single address). */
export interface SavedPlace {
  categoryCode: string;
  categoryName: string;
  categoryIcon: string;
  address: string;
  city: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  googlePlaceId: string | null;
  /** True when the row hasn't been confirmed in the user DB yet. */
  pending: boolean;
}

/** What the Save modal hands us once a place is chosen. */
export interface SavePlaceInput {
  googlePlaceId: string;
  address: string;
  latitude: number;
  longitude: number;
  city?: string | null;
  country?: string | null;
}

interface RemoteCategory {
  category_code: string;
  user_id: string;
  category_name: string;
  category_icon: string;
}

interface RemoteAddress {
  user_id: string;
  category_code: string;
  full_formatted_address: string;
  city: string | null;
  country: string | null;
  lat: number | string | null; // DECIMAL may arrive as a string
  lng: number | string | null;
  google_place_id: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "place"
  );
}

/** Deterministic, globally-unique category_code for a (user, category name). */
export function slugCode(userId: string, name: string): string {
  return `${userId}:${slug(name)}`;
}

function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function toSavedPlaces(rows: SavedPlaceMirrorRow[]): SavedPlace[] {
  return rows.map((r) => ({
    categoryCode: r.category_code,
    categoryName: r.category_name,
    categoryIcon: r.category_icon,
    address: r.full_formatted_address,
    city: r.city,
    country: r.country,
    latitude: r.lat,
    longitude: r.lng,
    googlePlaceId: r.google_place_id,
    pending: r.pending === 1,
  }));
}

/** Push one row to the user DB in FK-safe order: user_info → category → address. */
async function pushRow(user: User, row: SavedPlaceMirrorRow): Promise<void> {
  await syncUserInfo(user); // idempotent; guarantees the user_info row exists
  await middlewareUpsert("user_defined_default_categories", {
    category_code: row.category_code,
    user_id: row.user_id,
    category_name: row.category_name,
    category_icon: row.category_icon,
  });
  await middlewareUpsert("saved_addresses", {
    user_id: row.user_id,
    category_code: row.category_code,
    full_formatted_address: row.full_formatted_address,
    city: row.city,
    country: row.country,
    lat: row.lat,
    lng: row.lng,
    google_place_id: row.google_place_id,
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load the user's saved places. Pulls the authoritative rows from the user DB and
 * refreshes the mirror; on any network/503 error falls back to the cached mirror
 * so saved places still render offline. Also retries anything pending.
 */
export async function fetchSavedPlaces(user: User): Promise<SavedPlace[]> {
  const userId = user.id;
  // Best-effort flush of anything queued from a previous offline save.
  await pushPending(user);
  try {
    const [cats, addrs] = await Promise.all([
      middlewareUserQuery<RemoteCategory>("user_defined_default_categories", {
        user_id: userId,
      }),
      middlewareUserQuery<RemoteAddress>("saved_addresses", { user_id: userId }),
    ]);
    const catByCode = new Map(cats.map((c) => [c.category_code, c]));
    const rows: SavedPlaceMirrorRow[] = [];
    for (const a of addrs) {
      const c = catByCode.get(a.category_code);
      if (!c) continue; // address without its category (shouldn't happen) — skip
      rows.push({
        user_id: userId,
        category_code: a.category_code,
        category_name: c.category_name,
        category_icon: c.category_icon,
        full_formatted_address: a.full_formatted_address,
        city: a.city ?? null,
        country: a.country ?? null,
        lat: toNum(a.lat),
        lng: toNum(a.lng),
        google_place_id: a.google_place_id ?? null,
        pending: 0,
      });
    }
    await mirrorReplaceAll(userId, rows);
  } catch (err) {
    if (__DEV__)
      console.warn("[savedPlaces] remote fetch failed, using mirror", err);
  }
  // Read back the merged view (remote rows + any still-pending local rows).
  return toSavedPlaces(await mirrorReadSavedPlaces(userId));
}

/**
 * Save (or overwrite) the address for a category. Writes the mirror immediately
 * (optimistic) and attempts the remote write; if the remote write fails the row
 * stays `pending` and is retried later — it is never lost and the call still
 * resolves. Only a local SQLite failure rejects.
 */
export async function savePlace(params: {
  user: User;
  categoryName: string;
  place: SavePlaceInput;
}): Promise<SavedPlace> {
  const { user, categoryName, place } = params;
  const userId = user.id;
  const name = categoryName.trim();
  const row: SavedPlaceMirrorRow = {
    user_id: userId,
    category_code: slugCode(userId, name),
    category_name: name,
    category_icon: categoryIconFor(name),
    full_formatted_address: place.address,
    city: place.city ?? null,
    country: place.country ?? null,
    lat: place.latitude,
    lng: place.longitude,
    google_place_id: place.googlePlaceId,
    pending: 1,
  };

  await mirrorUpsertSavedPlace(row); // optimistic local write
  try {
    await pushRow(user, row);
    await mirrorClearPending(userId, row.category_code);
    row.pending = 0;
  } catch (err) {
    if (__DEV__)
      console.warn("[savedPlaces] remote save failed, kept pending", err);
  }
  return toSavedPlaces([row])[0];
}

/**
 * Flush the outbox: retry rows saved locally but not yet confirmed remotely, then
 * replay tombstoned deletes. A permanent 4xx (not 408/429) is logged and given up
 * on so it doesn't retry forever (a save loses its pending flag, a delete drops its
 * tombstone).
 */
export async function pushPending(user: User): Promise<void> {
  const userId = user.id;
  let pending: SavedPlaceMirrorRow[];
  try {
    pending = await mirrorReadPending(userId);
  } catch {
    return;
  }
  for (const row of pending) {
    try {
      await pushRow(user, row);
      await mirrorClearPending(userId, row.category_code);
    } catch (err) {
      if (isPermanentFailure(err)) {
        console.warn("[savedPlaces] giving up on save", row.category_code, err);
        await mirrorClearPending(userId, row.category_code).catch(() => {});
      } else if (__DEV__)
        console.warn("[savedPlaces] pushPending failed", row.category_code, err);
    }
  }

  let tombs: { entity_key: string }[] = [];
  try {
    tombs = await tombstoneRead(userId, "saved_place");
  } catch {
    return;
  }
  for (const t of tombs) {
    try {
      await deleteRemote(userId, t.entity_key);
      await tombstoneDrop(userId, "saved_place", t.entity_key);
    } catch (err) {
      if (isPermanentFailure(err)) {
        console.warn("[savedPlaces] giving up on delete", t.entity_key, err);
        await tombstoneDrop(userId, "saved_place", t.entity_key).catch(() => {});
      } else if (__DEV__)
        console.warn("[savedPlaces] delete replay failed", t.entity_key, err);
    }
  }
}

/** DELETE that treats 404 (already gone) as success. */
async function deleteIgnoringMissing(
  table: string,
  params: Record<string, string>,
): Promise<void> {
  try {
    await middlewareUserDelete(table, params);
  } catch (err) {
    if (outboxHttpStatus(err) !== 404) throw err;
  }
}

/** Remote delete: the address first (it's the FK child), then its category. */
async function deleteRemote(userId: string, categoryCode: string): Promise<void> {
  await deleteIgnoringMissing("saved_addresses", {
    user_id: userId,
    category_code: categoryCode,
  });
  await deleteIgnoringMissing("user_defined_default_categories", {
    user_id: userId,
    category_code: categoryCode,
  });
}

/**
 * Delete a saved place. Removes the mirror row and records a tombstone
 * atomically, then tries the remote delete. Offline/5xx: the tombstone stays and
 * pushPending replays it — the call still resolves. A permanent 4xx drops the
 * tombstone and rethrows so the caller can restore the list.
 */
export async function deletePlace(
  user: User,
  categoryCode: string,
): Promise<void> {
  const userId = user.id;
  await tombstoneDelete(userId, "saved_place", categoryCode);
  try {
    await deleteRemote(userId, categoryCode);
    await tombstoneDrop(userId, "saved_place", categoryCode);
  } catch (err) {
    if (isPermanentFailure(err)) {
      await tombstoneDrop(userId, "saved_place", categoryCode).catch(() => {});
      throw err;
    }
    if (__DEV__)
      console.warn("[savedPlaces] remote delete failed, tombstoned", err);
  }
}
