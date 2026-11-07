// Planned events live in the user DB (`user_defined_events`) with SQLite as an
// offline mirror. This module is the single API the Planner UI uses; it hides the
// remote write order, the mirror write-through, and the pending-outbox retry.
// It also imports device-calendar events into the same store.
//
// Backend constraints that shape this file (tranzit-user-db/schema.sql):
//  • user_defined_events.event_id is a client-supplied VARCHAR PK → real UPSERT.
//  • user_defined_events FKs user_info → writes go user_info → events.
//  • user_calendar links (user_id, event_id) but its PK is a GENERATED id, so the
//    middleware can't ON CONFLICT on its UNIQUE(user_id,event_id) — re-saving would
//    409. We delete-then-insert that stub row (same trick as searchHistory dedup).
//  • Deleting an event CASCADEs to user_calendar / cached_pre_routes.
//  • travel_time is owned by lib/preRoutes.ts (arrive-by pre-routing); every save
//    nulls it so a stale pre-route never survives a time/place edit.
//  • recurrence_rule holds an RRULE subset (components/planner/recurrence.ts);
//    edits/deletes apply to the whole series.
//  • Deletes are tombstoned locally (lib/db.ts) and replayed by pushPending, so an
//    offline delete survives the next fetch instead of resurrecting the row.

import type { User } from "@supabase/supabase-js";
import * as Crypto from "expo-crypto";
import * as Calendar from "expo-calendar";
import {
  middlewareUpsert,
  middlewareUserDelete,
  middlewareUserQuery,
} from "@/lib/middleware";
import { syncUserInfo } from "@/lib/userSync";
import {
  isPermanentFailure,
  mirrorClearPendingEvent,
  mirrorReadEvents,
  mirrorReadPendingEvents,
  mirrorReplaceAllEvents,
  mirrorUpsertEvent,
  outboxHttpStatus,
  tombstoneDelete,
  tombstoneDrop,
  tombstoneRead,
  type PlannedEventMirrorRow,
} from "@/lib/db";
import {
  allDayLocalMidnight,
  deviceTimezone,
  type PlannedEvent,
} from "@/components/planner/trip";
import { cancelLeaveNow } from "@/lib/leaveNowNotifications";

// ─── Types ──────────────────────────────────────────────────────────────────

/** What the create/edit forms hand us. Omit `eventId` to create a new event. */
export interface SaveEventInput {
  eventId?: string;
  name: string;
  location: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  placeId?: string | null;
  notes: string | null;
  start: string; // ISO
  end: string; // ISO
  timezone?: string | null;
  /** RRULE subset (see components/planner/recurrence.ts); null/omitted = one-off. */
  recurrenceRule?: string | null;
}

/** A row from `user_defined_events` (timestamptz columns arrive as ISO strings). */
interface RemoteEvent {
  event_id: string;
  user_id: string;
  name: string;
  description: string | null;
  start_time: string;
  end_time: string;
  timezone: string | null;
  location: string | null;
  location_lat: number | string | null; // floats can arrive as strings
  location_lng: number | string | null;
  place_id: string | null;
  recurrence_rule: string | null;
  travel_time: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Coerce a numeric column that may arrive as a string (pg float/decimal). */
function toNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function toPlannedEvents(rows: PlannedEventMirrorRow[]): PlannedEvent[] {
  return rows.map((r) => ({
    eventId: r.event_id,
    name: r.name,
    location: r.location,
    locationLat: r.location_lat,
    locationLng: r.location_lng,
    placeId: r.place_id,
    notes: r.description,
    start: r.start_time,
    end: r.end_time,
    timezone: r.timezone,
    travelTime: r.travel_time,
    recurrenceRule: r.recurrence_rule ?? null,
    pending: r.pending === 1,
    imported: r.event_id.startsWith("device:"),
  }));
}

/** Push one event to the user DB in FK-safe order: user_info → events → calendar. */
async function pushRow(user: User, row: PlannedEventMirrorRow): Promise<void> {
  await syncUserInfo(user); // idempotent; guarantees the user_info row exists
  await middlewareUpsert("user_defined_events", {
    event_id: row.event_id,
    user_id: row.user_id,
    name: row.name,
    description: row.description,
    start_time: row.start_time,
    end_time: row.end_time,
    timezone: row.timezone,
    location: row.location,
    location_lat: row.location_lat,
    location_lng: row.location_lng,
    place_id: row.place_id,
    travel_time: row.travel_time,
    recurrence_rule: row.recurrence_rule,
  });
  // user_calendar link. Its PK is generated, but the middleware upserts it on its
  // UNIQUE (user_id, event_id) natural key, so re-saving updates the row in place
  // (an older delete-then-insert raced itself into 409s when two pushes overlapped).
  // cached_pre_route_id FK is safe: travel_time is only non-null after preRoutes has
  // upserted the cached_pre_routes row (see lib/preRoutes.ts persistPreRoute).
  await middlewareUpsert("user_calendar", {
    user_id: row.user_id,
    event_id: row.event_id,
    time_critical: row.travel_time != null,
    cached_pre_route_id: row.travel_time != null ? `pre:${row.event_id}` : null,
    travel_time: row.travel_time,
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load the user's planned events. Pulls the authoritative rows from the user DB and
 * refreshes the mirror; on any network/503 error falls back to the cached mirror so
 * events still render offline. Also retries anything pending.
 */
export async function fetchEvents(user: User): Promise<PlannedEvent[]> {
  const userId = user.id;
  await pushPending(user);
  try {
    const remote = await middlewareUserQuery<RemoteEvent>(
      "user_defined_events",
      { user_id: userId },
    );
    const rows: PlannedEventMirrorRow[] = remote.map((r) => ({
      user_id: userId,
      event_id: r.event_id,
      name: r.name,
      description: r.description ?? null,
      location: r.location ?? null,
      location_lat: toNum(r.location_lat),
      location_lng: toNum(r.location_lng),
      place_id: r.place_id ?? null,
      start_time: r.start_time,
      end_time: r.end_time,
      timezone: r.timezone ?? null,
      travel_time: r.travel_time ?? null,
      recurrence_rule: r.recurrence_rule ?? null,
      pending: 0,
    }));
    await mirrorReplaceAllEvents(userId, rows);
  } catch (err) {
    if (__DEV__)
      console.warn("[plannerEvents] remote fetch failed, using mirror", err);
  }
  return toPlannedEvents(await mirrorReadEvents(userId));
}

/**
 * Create or update an event. Writes the mirror immediately (optimistic) and attempts
 * the remote write; if it fails the row stays `pending` and is retried later — it is
 * never lost and the call still resolves. Only a local SQLite failure rejects.
 */
export async function saveEvent(params: {
  user: User;
  event: SaveEventInput;
}): Promise<PlannedEvent> {
  const { user, event } = params;
  const userId = user.id;
  const row: PlannedEventMirrorRow = {
    user_id: userId,
    event_id: event.eventId ?? Crypto.randomUUID(),
    name: event.name.trim() || "Untitled event",
    description: event.notes?.trim() || null,
    location: event.location?.trim() || null,
    location_lat: event.locationLat ?? null,
    location_lng: event.locationLng ?? null,
    place_id: event.placeId ?? null,
    start_time: event.start,
    end_time: event.end,
    timezone: event.timezone ?? deviceTimezone(),
    // Every save invalidates the pre-route (time/place may have changed);
    // lib/preRoutes.ts recomputes and writes it back via setEventTravelTime.
    travel_time: null,
    recurrence_rule: event.recurrenceRule ?? null,
    pending: 1,
  };

  await mirrorUpsertEvent(row); // optimistic local write
  try {
    await pushRow(user, row);
    await mirrorClearPendingEvent(userId, row.event_id);
    row.pending = 0;
  } catch (err) {
    if (__DEV__)
      console.warn("[plannerEvents] remote save failed, kept pending", err);
  }
  return toPlannedEvents([row])[0];
}

/** Remote delete; a 404 means it's already gone, which is what we wanted. */
async function deleteRemote(userId: string, eventId: string): Promise<void> {
  try {
    await middlewareUserDelete("user_defined_events", {
      user_id: userId,
      event_id: eventId,
    });
  } catch (err) {
    if (outboxHttpStatus(err) !== 404) throw err;
  }
}

/**
 * Flush the outbox: retry events saved locally but not yet confirmed remotely,
 * then replay tombstoned deletes. A row failing with a permanent 4xx (not
 * 408/429) is logged and given up on so it doesn't retry forever: a save loses
 * its pending flag (the next fetch reconciles it with the server), a delete
 * drops its tombstone.
 */
export async function pushPending(user: User): Promise<void> {
  const userId = user.id;
  let pending: PlannedEventMirrorRow[];
  try {
    pending = await mirrorReadPendingEvents(userId);
  } catch {
    return;
  }
  for (const row of pending) {
    try {
      await pushRow(user, row);
      await mirrorClearPendingEvent(userId, row.event_id);
    } catch (err) {
      if (isPermanentFailure(err)) {
        console.warn("[plannerEvents] giving up on save", row.event_id, err);
        await mirrorClearPendingEvent(userId, row.event_id).catch(() => {});
      } else if (__DEV__)
        console.warn("[plannerEvents] pushPending failed", row.event_id, err);
    }
  }

  let tombs: { entity_key: string }[] = [];
  try {
    tombs = await tombstoneRead(userId, "planner_event");
  } catch {
    return;
  }
  for (const t of tombs) {
    try {
      await deleteRemote(userId, t.entity_key);
      await tombstoneDrop(userId, "planner_event", t.entity_key);
    } catch (err) {
      if (isPermanentFailure(err)) {
        console.warn("[plannerEvents] giving up on delete", t.entity_key, err);
        await tombstoneDrop(userId, "planner_event", t.entity_key).catch(() => {});
      } else if (__DEV__)
        console.warn("[plannerEvents] delete replay failed", t.entity_key, err);
    }
  }
}

/**
 * Set a freshly pre-routed travel time on an event. Same optimistic mirror-then-push
 * shape as saveEvent; pushRow also refreshes the user_calendar link. Only called by
 * lib/preRoutes.ts after the cached_pre_routes row exists remotely.
 */
export async function setEventTravelTime(
  user: User,
  eventId: string,
  travelMin: number,
): Promise<void> {
  const userId = user.id;
  const row = (await mirrorReadEvents(userId)).find(
    (r) => r.event_id === eventId,
  );
  if (!row) return; // deleted while the route was computing
  row.travel_time = travelMin;
  row.pending = 1;
  await mirrorUpsertEvent(row);
  try {
    await pushRow(user, row);
    await mirrorClearPendingEvent(userId, eventId);
  } catch (err) {
    if (__DEV__)
      console.warn("[plannerEvents] travel_time push failed, kept pending", err);
  }
}

/**
 * Delete an event (a repeating event's whole series). Removes the mirror row and
 * records a tombstone atomically, then tries the remote delete (its user_calendar /
 * cached_pre_routes rows cascade away with it). Offline/5xx: the tombstone stays
 * and pushPending replays it — the call still resolves. A permanent 4xx drops the
 * tombstone and rethrows so the caller can restore the list. Also cancels any
 * queued leave-now notification — the single choke point for every delete path.
 */
export async function deleteEvent(user: User, eventId: string): Promise<void> {
  const userId = user.id;
  await cancelLeaveNow(eventId);
  await tombstoneDelete(userId, "planner_event", eventId);
  try {
    await deleteRemote(userId, eventId);
    await tombstoneDrop(userId, "planner_event", eventId);
  } catch (err) {
    if (isPermanentFailure(err)) {
      await tombstoneDrop(userId, "planner_event", eventId).catch(() => {});
      throw err;
    }
    if (__DEV__)
      console.warn("[plannerEvents] remote delete failed, tombstoned", err);
  }
}

// ─── Device-calendar import ─────────────────────────────────────────────────

// ponytail: import a -7d…+60d window; widen if users need more.
const IMPORT_BACK_DAYS = 7;
const IMPORT_FWD_DAYS = 60;

export interface ImportResult {
  granted: boolean;
  imported: number;
  /** Previously imported events in the window that are gone from the device. */
  removed?: number;
  /**
   * Why the import couldn't run:
   *  - "module-missing"  — expo-calendar's native module isn't in this build
   *    (dev client predates the plugin) → rebuild required.
   *  - "denied"          — user refused, can be asked again.
   *  - "denied-forever"  — OS won't re-prompt → send the user to Settings.
   */
  reason?: "module-missing" | "denied" | "denied-forever";
}

/**
 * Request calendar permission and import device-calendar events into the user DB.
 * Each event is keyed `device:{calId}:{eventId}:{startMs}` — expo-calendar returns
 * a recurring event's expanded occurrences with the same id, so the occurrence
 * start keeps a weekly class from collapsing into one row — and re-import UPSERTs
 * in place (idempotent — no duplicates). Previously imported `device:` events in
 * the window that no longer exist on the device are deleted. Never throws — every
 * native failure maps to a `reason` the UI can explain.
 *
 * ponytail: re-import overwrites local edits to imported events; acceptable until a
 * source/synced flag is added.
 */
export async function importDeviceEvents(user: User): Promise<ImportResult> {
  try {
    // Check first: if already denied without re-ask, requesting is a silent no.
    let perm = await Calendar.getCalendarPermissionsAsync();
    if (!perm.granted) {
      if (!perm.canAskAgain)
        return { granted: false, imported: 0, reason: "denied-forever" };
      perm = await Calendar.requestCalendarPermissionsAsync();
      if (!perm.granted)
        return {
          granted: false,
          imported: 0,
          reason: perm.canAskAgain ? "denied" : "denied-forever",
        };
    }

    const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    if (cals.length === 0) return { granted: true, imported: 0 };

    const now = Date.now();
    const start = new Date(now - IMPORT_BACK_DAYS * 86_400_000);
    const end = new Date(now + IMPORT_FWD_DAYS * 86_400_000);
    const events = await Calendar.getEventsAsync(
      cals.map((c) => c.id),
      start,
      end,
    );

    let imported = 0;
    const seen = new Set<string>();
    for (const e of events) {
      if (!e.startDate || !e.endDate) continue;
      const occurrenceMs = new Date(e.startDate).getTime();
      if (!Number.isFinite(occurrenceMs)) continue;
      const eventId = `device:${e.calendarId}:${e.id}:${occurrenceMs}`;
      seen.add(eventId);
      let startD = new Date(e.startDate);
      let endD = new Date(e.endDate);
      if (e.allDay) {
        // Normalize to local midnight(s) so isAllDay() derives it at render
        // time and the plaque lands on the intended calendar day. Day count
        // from raw duration is robust to both platform end conventions
        // (Android exclusive next-midnight, iOS inclusive ~23:59:59) and DST.
        const s = allDayLocalMidnight(startD);
        const days = Math.max(
          1,
          Math.round((endD.getTime() - startD.getTime()) / 86_400_000),
        );
        startD = s;
        endD = new Date(s.getFullYear(), s.getMonth(), s.getDate() + days);
      }
      const startISO = startD.toISOString();
      const endISO = endD.toISOString();
      // user_defined_events enforces end_time > start_time.
      if (new Date(endISO).getTime() <= new Date(startISO).getTime()) continue;
      await saveEvent({
        user,
        event: {
          eventId,
          name: e.title || "Calendar event",
          location: e.location ?? null,
          notes: e.notes ?? null,
          start: startISO,
          end: endISO,
          timezone: e.timeZone ?? deviceTimezone(),
        },
      });
      imported++;
    }

    // Prune imports in the window that the device no longer has (deleted there,
    // or keyed the old pre-occurrence way `device:{calId}:{eventId}`).
    let removed = 0;
    const startMs = start.getTime();
    const endMs = end.getTime();
    for (const row of await mirrorReadEvents(user.id)) {
      if (!row.event_id.startsWith("device:") || seen.has(row.event_id)) continue;
      const s = new Date(row.start_time).getTime();
      const f = new Date(row.end_time).getTime();
      if (!(s < endMs && f > startMs)) continue; // outside the window — keep
      try {
        await deleteEvent(user, row.event_id);
        removed++;
      } catch (err) {
        if (__DEV__)
          console.warn("[plannerEvents] stale import delete failed", row.event_id, err);
      }
    }
    return { granted: true, imported, removed };
  } catch (err) {
    // Calendar.* throws when the native module is missing from the installed
    // build (plugin added after the last native build) — the "massive error".
    if (__DEV__) console.warn("[plannerEvents] calendar import failed", err);
    return { granted: false, imported: 0, reason: "module-missing" };
  }
}
