// Search history lives in the user DB `user_history`, with SQLite as an offline
// mirror / outbox. This module is the single API the UI uses; it hides the dedup
// key, the optimistic mirror write, the remote write, and the pending-outbox retry.
//
// Backend constraints that shape this file:
//  • user_history.history_id is GENERATED ALWAYS → every POST is a plain INSERT
//    (no upsert), so dedup and the size cap are the CLIENT's job.
//  • user_history.user_id FKs user_info, so a row's user must exist first
//    (syncUserInfo, idempotent) before inserting.
//  • bus_number is nullable and stays null for these place searches.

import type { User } from "@supabase/supabase-js";
import type { SearchSuggestion } from "@/types/places";
import {
  middlewareUpsert,
  middlewareUserDelete,
  middlewareUserQuery,
} from "@/lib/middleware";
import { syncUserInfo } from "@/lib/userSync";
import {
  mirrorCapSearch,
  mirrorClearPendingSearch,
  mirrorListRecentSearch,
  mirrorReadPendingSearch,
  mirrorReplaceAllSearch,
  mirrorUpsertSearch,
  type SearchHistoryMirrorRow,
} from "@/lib/db";

/** Keep the newest N searched places per user (mirror and, best-effort, remote). */
const HISTORY_CAP = 50;

// ─── Types ──────────────────────────────────────────────────────────────────

/** What a search chokepoint hands us. Decoupled from the DB column names. */
export interface SearchHistoryInput {
  /** google_place_id, when the place came from Places. */
  placeId?: string | null;
  /** Business / display name shown as the primary line (→ common_name). */
  name?: string | null;
  /** Destination label / formatted address (→ destination_full_formatted_address). */
  address: string;
  lat?: number | null;
  lng?: number | null;
  city?: string | null;
  country?: string | null;
  originLat?: number | null;
  originLng?: number | null;
  originAddress?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slug(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "place"
  );
}

/**
 * A stable per-place dedup key: the Places id when we have one, else rounded
 * coordinates, else a slug of the address. Re-searching the same place collapses
 * onto the same mirror row (and the same remote dedup delete).
 */
function placeKeyOf(input: SearchHistoryInput): string {
  if (input.placeId) return input.placeId;
  if (input.lat != null && input.lng != null)
    return `${input.lat.toFixed(5)},${input.lng.toFixed(5)}`;
  return slug(input.address);
}

function toRow(userId: string, input: SearchHistoryInput): SearchHistoryMirrorRow {
  return {
    user_id: userId,
    place_key: placeKeyOf(input),
    google_place_id: input.placeId ?? null,
    common_name: input.name ?? null,
    destination_full_formatted_address: input.address,
    destination_city: input.city ?? null,
    destination_country: input.country ?? null,
    destination_lat: input.lat ?? null,
    destination_lng: input.lng ?? null,
    origin_lat: input.originLat ?? null,
    origin_lng: input.originLng ?? null,
    origin_address: input.originAddress ?? null,
    category_code: null, // history→category link deferred (avoids FK on pending categories)
    date_time: new Date().toISOString(),
    pending: 1,
  };
}

/** Push one history row to the user DB: ensure user_info, dedup by place, insert. */
async function pushRow(user: User, row: SearchHistoryMirrorRow): Promise<void> {
  await syncUserInfo(user); // idempotent; guarantees the user_info FK parent exists
  if (row.google_place_id) {
    // Remote dedup → most-recent wins for a given place.
    await middlewareUserDelete("user_history", {
      user_id: row.user_id,
      google_place_id: row.google_place_id,
    });
  }
  await middlewareUpsert("user_history", {
    user_id: row.user_id,
    common_name: row.common_name,
    origin_lat: row.origin_lat,
    origin_lng: row.origin_lng,
    origin_address: row.origin_address,
    destination_full_formatted_address: row.destination_full_formatted_address,
    destination_city: row.destination_city,
    destination_country: row.destination_country,
    destination_lat: row.destination_lat,
    destination_lng: row.destination_lng,
    google_place_id: row.google_place_id,
    category_code: row.category_code,
    date_time: row.date_time,
    bus_number: null,
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a search. Writes the mirror immediately (optimistic, deduped, capped)
 * and attempts the remote write; if the remote write fails the row stays
 * `pending` and is retried later — it is never lost and the call still resolves.
 * Best-effort: only a local SQLite failure rejects.
 */
export async function recordSearch(
  user: User,
  input: SearchHistoryInput,
): Promise<void> {
  const userId = user.id;
  const row = toRow(userId, input);

  await mirrorUpsertSearch(row); // optimistic local write (deduped by place_key)
  await mirrorCapSearch(userId, HISTORY_CAP);

  try {
    await pushRow(user, row);
    await mirrorClearPendingSearch(userId, row.place_key);
  } catch (err) {
    if (__DEV__)
      console.warn("[searchHistory] remote record failed, kept pending", err);
  }
}

/** Retry any searches recorded locally but not yet confirmed remotely. */
export async function pushPendingSearchHistory(user: User): Promise<void> {
  const userId = user.id;
  let pending: SearchHistoryMirrorRow[];
  try {
    pending = await mirrorReadPendingSearch(userId);
  } catch {
    return;
  }
  for (const row of pending) {
    try {
      await pushRow(user, row);
      await mirrorClearPendingSearch(userId, row.place_key);
    } catch (err) {
      if (__DEV__)
        console.warn("[searchHistory] pushPending failed", row.place_key, err);
    }
  }
}

/**
 * Best-effort cap of the remote history to the newest `HISTORY_CAP` rows: find
 * the cutoff (the (CAP+1)-th newest row's date_time) and delete everything older.
 * No-op when there are fewer than CAP rows.
 */
export async function pruneRemoteHistory(user: User): Promise<void> {
  const userId = user.id;
  try {
    const overflow = await middlewareUserQuery<{ date_time: string }>(
      "user_history",
      {
        user_id: userId,
        order_by: "date_time",
        order: "DESC",
        limit: 1,
        offset: HISTORY_CAP,
      },
    );
    const cutoff = overflow[0]?.date_time;
    if (!cutoff) return; // at or under the cap
    await middlewareUserDelete("user_history", {
      user_id: userId,
      date_time: `lt.${cutoff}`,
    });
  } catch (err) {
    if (__DEV__) console.warn("[searchHistory] pruneRemote failed", err);
  }
}

// ─── Recents (read side, for the "recent searches" UI) ──────────────────────────

/** A recent search, shaped for display in the search bars. */
export interface RecentSearch {
  placeKey: string;
  placeId: string | null;
  /** Business / common name, if known. */
  name: string | null;
  address: string;
  mainText: string;
  secondaryText?: string;
  lat: number | null;
  lng: number | null;
  city: string | null;
  country: string | null;
}

/** DECIMAL columns may arrive from the user DB as strings. */
function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Split a formatted address into a primary line and an optional secondary line. */
function splitAddress(address: string): { mainText: string; secondaryText?: string } {
  const i = address.indexOf(",");
  if (i === -1) return { mainText: address };
  const mainText = address.slice(0, i).trim() || address;
  const secondaryText = address.slice(i + 1).trim() || undefined;
  return { mainText, secondaryText };
}

function toRecent(row: SearchHistoryMirrorRow): RecentSearch {
  const address = row.destination_full_formatted_address;
  // Mirror the /autocomplete format: business/common name as the primary line,
  // the address as the secondary line. Fall back to splitting the address when
  // no common name was captured (older rows).
  const name = row.common_name?.trim() || null;
  let mainText: string;
  let secondaryText: string | undefined;
  if (name) {
    mainText = name;
    secondaryText = address || undefined;
  } else {
    ({ mainText, secondaryText } = splitAddress(address));
  }
  return {
    placeKey: row.place_key,
    placeId: row.google_place_id,
    name,
    address,
    mainText,
    secondaryText,
    lat: row.destination_lat,
    lng: row.destination_lng,
    city: row.destination_city,
    country: row.destination_country,
  };
}

/** Read the newest searches from the local mirror (instant, offline-safe). */
export async function listRecentSearches(
  user: User,
  limit = 8,
): Promise<RecentSearch[]> {
  try {
    const rows = await mirrorListRecentSearch(user.id, limit);
    return rows.map(toRecent);
  } catch {
    return [];
  }
}

interface RemoteHistoryRow {
  google_place_id: string | null;
  common_name: string | null;
  destination_full_formatted_address: string | null;
  destination_city: string | null;
  destination_country: string | null;
  destination_lat: number | string | null;
  destination_lng: number | string | null;
  origin_lat: number | string | null;
  origin_lng: number | string | null;
  origin_address: string | null;
  date_time: string | null;
}

/**
 * Hydrate the local mirror from the remote user_history so recents follow the
 * account across devices. Best-effort: offline / 503 leaves the mirror as-is.
 */
export async function syncRecentSearchesFromRemote(user: User): Promise<void> {
  const userId = user.id;
  try {
    const remote = await middlewareUserQuery<RemoteHistoryRow>("user_history", {
      user_id: userId,
      order_by: "date_time",
      order: "DESC",
      limit: HISTORY_CAP,
    });
    // Remote is newest-first; keep the first row seen per place_key.
    const byKey = new Map<string, SearchHistoryMirrorRow>();
    for (const r of remote) {
      const address = r.destination_full_formatted_address ?? "";
      const lat = toNum(r.destination_lat);
      const lng = toNum(r.destination_lng);
      const place_key = placeKeyOf({
        placeId: r.google_place_id,
        address,
        lat,
        lng,
      });
      if (byKey.has(place_key)) continue;
      const iso = r.date_time ? new Date(r.date_time).toISOString() : null;
      byKey.set(place_key, {
        user_id: userId,
        place_key,
        google_place_id: r.google_place_id ?? null,
        common_name: r.common_name ?? null,
        destination_full_formatted_address: address,
        destination_city: r.destination_city ?? null,
        destination_country: r.destination_country ?? null,
        destination_lat: lat,
        destination_lng: lng,
        origin_lat: toNum(r.origin_lat),
        origin_lng: toNum(r.origin_lng),
        origin_address: r.origin_address ?? null,
        category_code: null,
        date_time: iso ?? new Date().toISOString(),
        pending: 0,
      });
    }
    await mirrorReplaceAllSearch(userId, [...byKey.values()]);
  } catch (err) {
    if (__DEV__) console.warn("[searchHistory] recents hydrate failed", err);
  }
}

/** Map a recent into the SearchSuggestion shape so the suggestion list can render it. */
export function recentToSuggestion(r: RecentSearch): SearchSuggestion {
  return {
    placeId: r.placeId ?? r.placeKey,
    mainText: r.mainText,
    secondaryText: r.secondaryText,
    location:
      r.lat != null && r.lng != null
        ? { latitude: r.lat, longitude: r.lng }
        : undefined,
  };
}
