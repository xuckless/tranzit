// Shared model + helpers for the Trip Planner timeline.
//
// An event is a plain time block backed by the user DB `user_defined_events`
// (name, location + coords, description→notes, start_time, end_time, timezone,
// travel_time, recurrence_rule) and mirrored into expo-sqlite for offline reads
// (lib/plannerEvents.ts, lib/db.ts). travelTime is pre-routed via lib/preRoutes.ts
// (cached_pre_routes); repeats are expanded at render time (./recurrence.ts).
//
// Pure module — no react-native imports (tested with `bun test`).

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
    /** RFC 5545 RRULE (subset, see ./recurrence.ts); null = one-off event. */
    recurrenceRule: string | null;
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

/** Anything with an ISO start/end — events and expanded occurrences. */
export type TimeSpan = { start: string; end: string };

/** Local midnight of a YYYY-MM-DD key. */
export function dayStart(dayKey: string): Date {
    const [y, m, d] = dayKey.split("-").map(Number);
    return new Date(y, m - 1, d);
}

/** Calendar-day arithmetic in local time (DST-safe: keeps wall-clock time). */
export function addDays(d: Date, n: number): Date {
    const next = new Date(d);
    next.setDate(next.getDate() + n);
    return next;
}

/** Monday on/before `d`, at local midnight. */
export function startOfWeek(d: Date): Date {
    const mid = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    return addDays(mid, -((mid.getDay() + 6) % 7));
}

/** Same day-of-month `n` months away, clamped to the target month's length. */
export function addMonths(d: Date, n: number): Date {
    const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return new Date(
        first.getFullYear(),
        first.getMonth(),
        Math.min(d.getDate(), last),
    );
}

/** The 42 days (6 weeks, Monday-first) of the month grid containing `d`. */
export function monthGridDays(d: Date): Date[] {
    const start = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1));
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/**
 * Items overlapping the half-open window [start, end). Zero-length items count
 * when their instant falls inside the window.
 */
export function eventsInRange<T extends TimeSpan>(
    events: T[],
    start: Date,
    end: Date,
): T[] {
    const a = start.getTime();
    const b = end.getTime();
    return events.filter((e) => {
        const s = new Date(e.start).getTime();
        const f = new Date(e.end).getTime();
        if (f <= s) return s >= a && s < b;
        return s < b && f > a;
    });
}

/** One item's slice of a single day, in timeline minutes (0..DAY_MIN). */
export type DaySegment<T> = {
    item: T;
    startMin: number;
    endMin: number;
    /** Started on an earlier day (render "↑ cont.", no rounded top). */
    continuesBefore: boolean;
    /** Runs past this day's midnight (no rounded bottom). */
    continuesAfter: boolean;
};

/**
 * Clip an item to the local day `dayKey`; null when it doesn't touch that day.
 * In-day ends use wall-clock minutes (so DST days still map onto 24 rows).
 */
export function clipToDay<T extends TimeSpan>(
    item: T,
    dayKey: string,
): DaySegment<T> | null {
    const d0 = dayStart(dayKey);
    const a = d0.getTime();
    const b = addDays(d0, 1).getTime();
    const s = new Date(item.start).getTime();
    const f = Math.max(s, new Date(item.end).getTime());
    if (f === s ? !(s >= a && s < b) : !(s < b && f > a)) return null;
    const continuesBefore = s < a;
    const continuesAfter = f > b;
    const startMin = continuesBefore ? 0 : minutesOfDay(item.start);
    let endMin = f >= b ? DAY_MIN : minutesOfDay(new Date(f).toISOString());
    if (endMin < startMin) endMin = DAY_MIN;
    return { item, startMin, endMin, continuesBefore, continuesAfter };
}

/**
 * Derived all-day: starts at local midnight and ends exactly on a later local
 * midnight. No stored flag — matches what the import normalizer writes.
 * Midnight-to-midnight (not duration >= 1440) so DST days (23/25h) still count.
 */
export function isAllDay(ev: TimeSpan): boolean {
    return (
        minutesOfDay(ev.start) === 0 &&
        minutesOfDay(ev.end) === 0 &&
        new Date(ev.end).getTime() > new Date(ev.start).getTime()
    );
}

/**
 * Local midnight of the calendar day an all-day device event means.
 * Android CalendarContract stores all-day events at UTC midnight, iOS EventKit
 * at local midnight — take date parts from whichever frame the timestamp is
 * midnight-aligned in.
 */
export function allDayLocalMidnight(d: Date): Date {
    const utcAligned = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
    return utcAligned
        ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
        : new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
