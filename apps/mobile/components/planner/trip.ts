// Shared model + helpers for the Trip Planner timeline.
//
// An event is a plain time block backed by the user DB `user_defined_events`
// (name, location + coords, description→notes, start_time, end_time, timezone,
// travel_time) and mirrored into expo-sqlite for offline reads (lib/plannerEvents.ts,
// lib/db.ts). travelTime is pre-routed via lib/preRoutes.ts (cached_pre_routes);
// recurrence is deferred to the recurring-events pass.

// ─── Layout constants (shared by the screen and the card) ─────────────────────
export const HOUR_HEIGHT = 60; // px per hour row — the timeline's vertical scale
export const GUTTER_WIDTH = 56; // left column holding the hour labels
export const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
export const EVENT_MIN_HEIGHT = 44; // floor so short events stay legible
export const DAY_MIN = 24 * 60;
export const SNAP_MIN = 5; // drag + steppers snap to 5-minute increments

// ─── Model ────────────────────────────────────────────────────────────────────

/** A planned event. `start`/`end` are ISO 8601 timestamps (with offset). */
export type PlannedEvent = {
    eventId: string;
    name: string;
    location: string | null;
    /** Coordinates from location search; null for free-text locations (no routing). */
    locationLat: number | null;
    locationLng: number | null;
    placeId: string | null;
    notes: string | null;
    start: string; // ISO — event start
    end: string; // ISO — event end
    timezone: string | null;
    /** Pre-routed door-to-door minutes (arrive-by event start); null = not computed. */
    travelTime: number | null;
    /** True when the row hasn't been confirmed in the user DB yet. */
    pending: boolean;
    /** Derived: imported from the device calendar (event_id begins "device:"). */
    imported: boolean;
};

// ─── Time ↔ timeline helpers ──────────────────────────────────────────────────

/** Minutes from local midnight for an ISO timestamp (device-local rendering). */
export function minutesOfDay(iso: string): number {
    const d = new Date(iso);
    return d.getHours() * 60 + d.getMinutes();
}

/** YYYY-MM-DD in local time — the key used to bucket events onto a day. */
export function localDayKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/** True when the event's local start date matches the given YYYY-MM-DD key. */
export function eventOnDay(ev: PlannedEvent, dayKey: string): boolean {
    return localDayKey(new Date(ev.start)) === dayKey;
}

/** Build an ISO timestamp for a YYYY-MM-DD day at `min` minutes local time. */
export function isoForDay(dayKey: string, min: number): string {
    const [y, m, d] = dayKey.split("-").map(Number);
    return new Date(y, m - 1, d, Math.floor(min / 60), min % 60, 0, 0).toISOString();
}

/** The device's IANA timezone (e.g. "America/Edmonton"), or null if unavailable. */
export function deviceTimezone(): string | null {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
        return null;
    }
}

// ─── Formatters ───────────────────────────────────────────────────────────────
export function formatHourLabel(hour: number): string {
    const h = hour % 12 === 0 ? 12 : hour % 12;
    const ampm = hour < 12 ? "AM" : "PM";
    return `${h} ${ampm}`;
}

export function formatClock(min: number): string {
    const clamped = Math.max(0, Math.min(DAY_MIN, min));
    const h24 = Math.floor(clamped / 60);
    const m = clamped % 60;
    const h = h24 % 12 === 0 ? 12 : h24 % 12;
    const ampm = h24 < 12 ? "AM" : "PM";
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function formatDuration(min: number): string {
    const safe = Math.max(0, min);
    const h = Math.floor(safe / 60);
    const m = safe % 60;
    const parts: string[] = [];
    if (h > 0) parts.push(`${h} hr`);
    if (m > 0) parts.push(`${m} min`);
    return parts.join(" ") || "0 min";
}

// ─── Mutations (pure) ─────────────────────────────────────────────────────────

/** Minutes between start and end. */
export function durationMin(ev: PlannedEvent): number {
    return Math.round(
        (new Date(ev.end).getTime() - new Date(ev.start).getTime()) / 60000,
    );
}

/**
 * Shift the event by deltaMin, clamped so it stays within its start day (drag is
 * single-day). Preserves the calendar date and the event's duration.
 */
export function shiftEvent(ev: PlannedEvent, deltaMin: number): PlannedEvent {
    const startMin = minutesOfDay(ev.start);
    const dur = durationMin(ev);
    let d = deltaMin;
    d = Math.max(d, -startMin); // can't start before 00:00
    d = Math.min(d, DAY_MIN - (startMin + dur)); // keep the block within the day
    if (d === 0) return ev;
    const newStart = new Date(new Date(ev.start).getTime() + d * 60000);
    const newEnd = new Date(newStart.getTime() + dur * 60000);
    return { ...ev, start: newStart.toISOString(), end: newEnd.toISOString() };
}
