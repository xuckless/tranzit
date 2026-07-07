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
//  • Deferred this pass: recurrence_rule.

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
  mirrorClearPendingEvent,
  mirrorDeleteEvent,
  mirrorReadEvents,
  mirrorReadPendingEvents,
  mirrorReplaceAllEvents,
  mirrorUpsertEvent,
  type PlannedEventMirrorRow,
} from "@/lib/db";
import { deviceTimezone, type PlannedEvent } from "@/components/planner/trip";
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
    // recurrence_rule stays NULL (deferred to the recurring pass)
  });
  // user_calendar stub. Its PK is generated, so the middleware does a plain INSERT
  // and a re-save would hit UNIQUE(user_id,event_id) → 409. Delete-then-insert makes
  // it idempotent (mirrors the remote-dedup in lib/searchHistory.ts).
  // cached_pre_route_id FK is safe: travel_time is only non-null after preRoutes has
  // upserted the cached_pre_routes row (see lib/preRoutes.ts persistPreRoute).
  await middlewareUserDelete("user_calendar", {
    user_id: row.user_id,
    event_id: row.event_id,
  });
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

/** Retry any events saved locally but not yet confirmed remotely. */
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
      if (__DEV__)
        console.warn("[plannerEvents] pushPending failed", row.event_id, err);
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
 * Delete an event. Removes the mirror row immediately, then the remote event (its
 * user_calendar / cached_pre_routes rows cascade away with it). Also cancels any
 * queued leave-now notification — the single choke point for every delete path.
 */
export async function deleteEvent(user: User, eventId: string): Promise<void> {
  const userId = user.id;
  await cancelLeaveNow(eventId);
  await mirrorDeleteEvent(userId, eventId);
  await middlewareUserDelete("user_defined_events", {
    user_id: userId,
    event_id: eventId,
  });
}

// ─── Device-calendar import ─────────────────────────────────────────────────

// ponytail: import a -7d…+60d window; widen if users need more.
const IMPORT_BACK_DAYS = 7;
const IMPORT_FWD_DAYS = 60;

export interface ImportResult {
  granted: boolean;
  imported: number;
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
 * Each event is keyed `device:{calId}:{eventId}` so re-import UPSERTs in place
 * (idempotent — no duplicates). Never throws — every native failure maps to a
 * `reason` the UI can explain.
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
    for (const e of events) {
      if (!e.startDate || !e.endDate) continue;
      const startISO = new Date(e.startDate).toISOString();
      const endISO = new Date(e.endDate).toISOString();
      // user_defined_events enforces end_time > start_time.
      if (new Date(endISO).getTime() <= new Date(startISO).getTime()) continue;
      await saveEvent({
        user,
        event: {
          eventId: `device:${e.calendarId}:${e.id}`,
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
    return { granted: true, imported };
  } catch (err) {
    // Calendar.* throws when the native module is missing from the installed
    // build (plugin added after the last native build) — the "massive error".
    if (__DEV__) console.warn("[plannerEvents] calendar import failed", err);
    return { granted: false, imported: 0, reason: "module-missing" };
  }
}
