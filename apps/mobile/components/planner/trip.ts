// Shared model + helpers for the Trip Planner timeline.
//
// TODO(trip-planner): PlannedTrip is currently in-memory only (SAMPLE_TRIPS). Back
// it with a user-specific trips store — a Supabase table keyed by user id, optionally
// mirrored into expo-sqlite for offline reads — and load/persist edits there. Travel
// times (departMin→arriveMin) should come from the Route Service ETA, and eventEndMin
// from the linked calendar event (iCal / Google / Outlook import).

// ─── Layout constants (shared by the screen and the card) ─────────────────────
export const HOUR_HEIGHT = 60; // px per hour row — the timeline's vertical scale
export const GUTTER_WIDTH = 56; // left column holding the hour labels
export const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
export const TRAVEL_MIN_HEIGHT = 30; // floor so short travel sections stay legible
export const EVENT_MIN_HEIGHT = 44; // floor so short destination sections stay legible
export const DAY_MIN = 24 * 60;
export const SNAP_MIN = 5; // drag + steppers snap to 5-minute increments

// ─── Model ────────────────────────────────────────────────────────────────────
export type TimingMode = "leave" | "arrive";

export type PlannedTrip = {
    id: string;
    destination: string;
    origin: string;
    departMin: number; // minutes from midnight — leave origin (travel starts)
    arriveMin: number; // minutes from midnight — reach destination (travel ends)
    eventEndMin: number; // minutes from midnight — end of the appointment
    mode: TimingMode;
};

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

/** Shift the whole trip block by deltaMin, clamped so it stays within the day. */
export function shiftTrip(trip: PlannedTrip, deltaMin: number): PlannedTrip {
    let d = deltaMin;
    d = Math.max(d, -trip.departMin); // can't start before 00:00
    d = Math.min(d, DAY_MIN - trip.eventEndMin); // can't end after 24:00
    if (d === 0) return trip;
    return {
        ...trip,
        departMin: trip.departMin + d,
        arriveMin: trip.arriveMin + d,
        eventEndMin: trip.eventEndMin + d,
    };
}

// ─── Sample data (skeleton only) ──────────────────────────────────────────────
export const SAMPLE_TRIPS: PlannedTrip[] = [
    {
        id: "1",
        destination: "Downtown — 7th Ave Office",
        origin: "Current location",
        departMin: 8 * 60, // 08:00 leave
        arriveMin: 8 * 60 + 45, // 08:45 arrive (45 min travel)
        eventEndMin: 9 * 60 + 45, // 09:45
        mode: "arrive",
    },
    {
        id: "2",
        destination: "University of Calgary",
        origin: "Downtown — 7th Ave Office",
        departMin: 17 * 60 + 15, // 17:15 leave
        arriveMin: 18 * 60 + 5, // 18:05 arrive (50 min travel)
        eventEndMin: 19 * 60 + 5, // 19:05
        mode: "leave",
    },
];
