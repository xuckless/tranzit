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
//  • Deferred this pass: travel_time, recurrence_rule, cached_pre_routes (route svc).

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

// ─── Types ──────────────────────────────────────────────────────────────────

/** What the create/edit forms hand us. Omit `eventId` to create a new event. */
export interface SaveEventInput {
  eventId?: string;
  name: string;
  location: string | null;
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
  recurrence_rule: string | null;
  travel_time: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toPlannedEvents(rows: PlannedEventMirrorRow[]): PlannedEvent[] {
  return rows.map((r) => ({
    eventId: r.event_id,
    name: r.name,
    location: r.location,
    notes: r.description,
    start: r.start_time,
    end: r.end_time,
    timezone: r.timezone,
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
    // recurrence_rule + travel_time stay NULL (deferred to the route/recurring passes)
  });
  // user_calendar stub. Its PK is generated, so the middleware does a plain INSERT
  // and a re-save would hit UNIQUE(user_id,event_id) → 409. Delete-then-insert makes
  // it idempotent (mirrors the remote-dedup in lib/searchHistory.ts).
  await middlewareUserDelete("user_calendar", {
    user_id: row.user_id,
    event_id: row.event_id,
  });
  await middlewareUpsert("user_calendar", {
    user_id: row.user_id,
    event_id: row.event_id,
    time_critical: false,
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
      start_time: r.start_time,
      end_time: r.end_time,
      timezone: r.timezone ?? null,
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
    start_time: event.start,
    end_time: event.end,
    timezone: event.timezone ?? deviceTimezone(),
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
 * Delete an event. Removes the mirror row immediately, then the remote event (its
 * user_calendar / cached_pre_routes rows cascade away with it).
 */
export async function deleteEvent(user: User, eventId: string): Promise<void> {
  const userId = user.id;
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

/**
 * Request calendar permission and import device-calendar events into the user DB.
 * Each event is keyed `device:{calId}:{eventId}` so re-import UPSERTs in place
 * (idempotent — no duplicates).
 *
 * ponytail: re-import overwrites local edits to imported events; acceptable until a
 * source/synced flag is added.
 */
export async function importDeviceEvents(
  user: User,
): Promise<{ granted: boolean; imported: number }> {
  const { granted } = await Calendar.requestCalendarPermissionsAsync();
  if (!granted) return { granted: false, imported: 0 };

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
}
