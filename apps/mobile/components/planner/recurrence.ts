// Repeating planner events: a deliberately small RFC 5545 RRULE subset, stored in
// user_defined_events.recurrence_rule. Pure — no react-native (tested with bun).
//
// Supported (exactly what the Add Event "Repeat" picker writes):
//   FREQ=DAILY
//   FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR      ("Weekdays"; any BYDAY list is honoured)
//   FREQ=WEEKLY                           (weekday of the event start)
//   FREQ=MONTHLY                          (day-of-month of the start; months without
//                                          that day are skipped, as in RFC 5545)
// each optionally followed by ;UNTIL=YYYYMMDDT235959Z. The UNTIL date part is read
// as an inclusive *local* calendar day, so "ends Nov 20" keeps a 6 PM occurrence on
// Nov 20 even west of UTC. INTERVAL/COUNT/etc. are not supported: such a rule is
// treated as a one-off event rather than guessed at.
//
// The event's own start is always the first occurrence. Occurrences keep the
// wall-clock start time (DST-safe) and the series' duration.

import {
    clipToDay,
    isAllDay,
    localDayKey,
    type DaySegment,
    type PlannedEvent,
} from "./trip";

export type RepeatKind = "never" | "daily" | "weekdays" | "weekly" | "monthly";

export const REPEAT_OPTIONS: { kind: RepeatKind; label: string }[] = [
    { kind: "never", label: "Never" },
    { kind: "daily", label: "Daily" },
    { kind: "weekdays", label: "Weekdays" },
    { kind: "weekly", label: "Weekly" },
    { kind: "monthly", label: "Monthly" },
];

const BYDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const; // JS getDay() order
const WEEKDAYS = "MO,TU,WE,TH,FR";

/** Build the stored RRULE for a picker choice; null for "never". `untilDayKey` is YYYY-MM-DD. */
export function buildRRule(
    kind: RepeatKind,
    untilDayKey?: string | null,
): string | null {
    let rule: string;
    switch (kind) {
        case "never":
            return null;
        case "daily":
            rule = "FREQ=DAILY";
            break;
        case "weekdays":
            rule = `FREQ=WEEKLY;BYDAY=${WEEKDAYS}`;
            break;
        case "weekly":
            rule = "FREQ=WEEKLY";
            break;
        case "monthly":
            rule = "FREQ=MONTHLY";
            break;
    }
    if (untilDayKey) rule += `;UNTIL=${untilDayKey.replace(/-/g, "")}T235959Z`;
    return rule;
}

type ParsedRule = {
    freq: "DAILY" | "WEEKLY" | "MONTHLY";
    byDay: number[] | null; // JS weekday numbers
    untilKey: string | null; // YYYY-MM-DD, inclusive local day
};

/** Parse a supported RRULE; null when empty or outside the supported subset. */
export function parseRRule(rule: string | null | undefined): ParsedRule | null {
    if (!rule) return null;
    const body = rule.trim().replace(/^RRULE:/i, "");
    if (!body) return null;
    let freq: ParsedRule["freq"] | null = null;
    let byDay: number[] | null = null;
    let untilKey: string | null = null;
    for (const part of body.split(";")) {
        if (!part) continue;
        const [rawK, rawV = ""] = part.split("=");
        const k = rawK.toUpperCase();
        const v = rawV.toUpperCase();
        if (k === "FREQ") {
            if (v !== "DAILY" && v !== "WEEKLY" && v !== "MONTHLY") return null;
            freq = v;
        } else if (k === "BYDAY") {
            const days = v
                .split(",")
                .map((c) => BYDAY_CODES.indexOf(c as never));
            if (days.length === 0 || days.some((d) => d < 0)) return null;
            byDay = days;
        } else if (k === "UNTIL") {
            const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
            if (!m) return null;
            untilKey = `${m[1]}-${m[2]}-${m[3]}`;
        } else if (k === "WKST") {
            // harmless; ignore
        } else {
            return null; // INTERVAL, COUNT, BYMONTHDAY, … — unsupported
        }
    }
    if (!freq) return null;
    if (byDay && freq !== "WEEKLY") return null;
    return { freq, byDay, untilKey };
}

/** Picker state for an existing rule (for the detail sheet / edit forms). */
export function describeRRule(rule: string | null | undefined): {
    kind: RepeatKind;
    untilKey: string | null;
    label: string;
} {
    const p = parseRRule(rule);
    if (!p) return { kind: "never", untilKey: null, label: "Never" };
    let kind: RepeatKind;
    if (p.freq === "DAILY") kind = "daily";
    else if (p.freq === "MONTHLY") kind = "monthly";
    else if (p.byDay && p.byDay.slice().sort().join(",") === "1,2,3,4,5")
        kind = "weekdays";
    else kind = "weekly";
    const base = REPEAT_OPTIONS.find((o) => o.kind === kind)!.label;
    return { kind, untilKey: p.untilKey, label: base };
}

export function isRepeating(ev: Pick<PlannedEvent, "recurrenceRule">): boolean {
    return parseRRule(ev.recurrenceRule) !== null;
}

/** One concrete instance of an event (a one-off event has exactly one). */
export type Occurrence = {
    /** Unique per instance: eventId for one-offs, `${eventId}@${startMs}` for repeats. */
    key: string;
    eventId: string;
    event: PlannedEvent;
    start: string; // ISO
    end: string; // ISO
};

const DAY_MS = 86_400_000;
const MAX_STEPS = 5000; // hard stop for pathological ranges

function overlaps(s: number, f: number, a: number, b: number): boolean {
    return f <= s ? s >= a && s < b : s < b && f > a;
}

/**
 * Occurrences of `event` overlapping [rangeStart, rangeEnd). Non-repeating events
 * (or unsupported rules) yield the event itself when it overlaps.
 */
export function expandOccurrences(
    event: PlannedEvent,
    rangeStart: Date,
    rangeEnd: Date,
): Occurrence[] {
    const a = rangeStart.getTime();
    const b = rangeEnd.getTime();
    const base = new Date(event.start);
    const baseMs = base.getTime();
    const durMs = Math.max(0, new Date(event.end).getTime() - baseMs);
    const rule = parseRRule(event.recurrenceRule);

    if (!rule) {
        return overlaps(baseMs, baseMs + durMs, a, b)
            ? [
                  {
                      key: event.eventId,
                      eventId: event.eventId,
                      event,
                      start: event.start,
                      end: event.end,
                  },
              ]
            : [];
    }

    const out: Occurrence[] = [];
    const y = base.getFullYear();
    const mo = base.getMonth();
    const d = base.getDate();
    const h = base.getHours();
    const mi = base.getMinutes();
    const sec = base.getSeconds();
    const push = (s: Date) => {
        const sMs = s.getTime();
        if (!overlaps(sMs, sMs + durMs, a, b)) return;
        out.push({
            key: `${event.eventId}@${sMs}`,
            eventId: event.eventId,
            event,
            start: s.toISOString(),
            end: new Date(sMs + durMs).toISOString(),
        });
    };
    const pastUntil = (s: Date) =>
        rule.untilKey !== null && localDayKey(s) > rule.untilKey;

    if (rule.freq === "MONTHLY") {
        // First month that could still overlap the range.
        const from = new Date(a - durMs);
        let n = Math.max(
            0,
            (from.getFullYear() - y) * 12 + from.getMonth() - mo - 1,
        );
        for (let steps = 0; steps < MAX_STEPS; steps++, n++) {
            const s = new Date(y, mo + n, d, h, mi, sec);
            if (s.getTime() >= b) break;
            if (s.getDate() !== d) continue; // e.g. the 31st in a 30-day month
            if (pastUntil(s)) break;
            push(s);
        }
        return out;
    }

    // DAILY / WEEKLY: walk calendar days from the first that could overlap.
    const days =
        rule.freq === "DAILY" ? null : new Set(rule.byDay ?? [base.getDay()]);
    let k = Math.max(0, Math.floor((a - durMs - baseMs) / DAY_MS) - 1);
    for (let steps = 0; steps < MAX_STEPS; steps++, k++) {
        const s = new Date(y, mo, d + k, h, mi, sec);
        if (s.getTime() >= b || pastUntil(s)) break;
        if (k > 0 && days && !days.has(s.getDay())) continue;
        push(s);
    }
    return out;
}

/** Expand every event into its occurrences within [rangeStart, rangeEnd), sorted by start. */
export function occurrencesInRange(
    events: PlannedEvent[],
    rangeStart: Date,
    rangeEnd: Date,
): Occurrence[] {
    return events
        .flatMap((e) => expandOccurrences(e, rangeStart, rangeEnd))
        .sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
}

/**
 * For pre-routing / leave-now: a repeating event resolved to its next occurrence
 * that starts after `now` and within `horizonMs` (same eventId, occurrence
 * start/end). One-offs — and series with no such occurrence — come back unchanged.
 */
export function nextInstance(
    event: PlannedEvent,
    now: number,
    horizonMs: number,
): PlannedEvent {
    if (!isRepeating(event)) return event;
    const next = expandOccurrences(
        event,
        new Date(now),
        new Date(now + horizonMs),
    ).find((o) => new Date(o.start).getTime() > now);
    return next ? { ...event, start: next.start, end: next.end } : event;
}

/**
 * One day's slices of a set of occurrences, split into all-day plaques and timed
 * blocks (timed sorted by start, longer first). Multi-day items appear on every
 * day they cover, clipped to it.
 */
export function daySegments(
    occurrences: Occurrence[],
    dayKey: string,
): { allDay: DaySegment<Occurrence>[]; timed: DaySegment<Occurrence>[] } {
    const allDay: DaySegment<Occurrence>[] = [];
    const timed: DaySegment<Occurrence>[] = [];
    for (const o of occurrences) {
        const seg = clipToDay(o, dayKey);
        if (!seg) continue;
        (isAllDay(o) ? allDay : timed).push(seg);
    }
    timed.sort((x, y) => x.startMin - y.startMin || y.endMin - x.endMin);
    return { allDay, timed };
}
