import { describe, expect, test } from "bun:test";
import { makeEvent } from "./testUtil";
import {
    buildRRule,
    daySegments,
    describeRRule,
    expandOccurrences,
    isRepeating,
    nextInstance,
    occurrencesInRange,
    parseRRule,
} from "./recurrence";
import { addDays, dayStart, localDayKey, minutesOfDay, DAY_MIN } from "./trip";

// 2026-11-02 is a Monday.
const MON = "2026-11-02";
const range = (fromKey: string, days: number): [Date, Date] => [
    dayStart(fromKey),
    addDays(dayStart(fromKey), days),
];
const keys = (occ: { start: string }[]) =>
    occ.map((o) => localDayKey(new Date(o.start)));

describe("buildRRule / parseRRule", () => {
    test("builds exactly the supported patterns", () => {
        expect(buildRRule("never")).toBeNull();
        expect(buildRRule("daily")).toBe("FREQ=DAILY");
        expect(buildRRule("weekdays")).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
        expect(buildRRule("weekly")).toBe("FREQ=WEEKLY");
        expect(buildRRule("monthly")).toBe("FREQ=MONTHLY");
        expect(buildRRule("weekly", "2026-12-31")).toBe(
            "FREQ=WEEKLY;UNTIL=20261231T235959Z",
        );
    });

    test("round-trips through describeRRule", () => {
        for (const k of ["daily", "weekdays", "weekly", "monthly"] as const) {
            expect(describeRRule(buildRRule(k, "2027-01-05")).kind).toBe(k);
            expect(describeRRule(buildRRule(k, "2027-01-05")).untilKey).toBe(
                "2027-01-05",
            );
        }
        expect(describeRRule(null).kind).toBe("never");
    });

    test("rejects unsupported rules (treated as one-off)", () => {
        expect(parseRRule("FREQ=YEARLY")).toBeNull();
        expect(parseRRule("FREQ=DAILY;INTERVAL=2")).toBeNull();
        expect(parseRRule("FREQ=WEEKLY;COUNT=3")).toBeNull();
        expect(parseRRule("FREQ=DAILY;BYDAY=MO")).toBeNull();
        expect(parseRRule("BYDAY=MO")).toBeNull();
        expect(parseRRule("")).toBeNull();
        expect(isRepeating({ recurrenceRule: "FREQ=HOURLY" })).toBe(false);
        expect(parseRRule("RRULE:FREQ=DAILY")).not.toBeNull();
    });
});

describe("expandOccurrences", () => {
    test("one-off event yields itself only when in range", () => {
        const e = makeEvent(MON, 9 * 60, 60);
        const occ = expandOccurrences(e, ...range(MON, 1));
        expect(occ).toHaveLength(1);
        expect(occ[0].key).toBe(e.eventId);
        expect(occ[0].start).toBe(e.start);
        expect(expandOccurrences(e, ...range("2026-11-03", 1))).toHaveLength(0);
    });

    test("daily: one per day from the start, original id, same wall-clock time", () => {
        const e = makeEvent(MON, 9 * 60, 30, {
            eventId: "d",
            recurrenceRule: "FREQ=DAILY",
        });
        const occ = expandOccurrences(e, ...range("2026-10-30", 10));
        expect(keys(occ)).toEqual([
            "2026-11-02",
            "2026-11-03",
            "2026-11-04",
            "2026-11-05",
            "2026-11-06",
            "2026-11-07",
            "2026-11-08",
        ]);
        for (const o of occ) {
            expect(o.eventId).toBe("d");
            expect(o.event).toBe(e);
            expect(minutesOfDay(o.start)).toBe(9 * 60);
            expect(
                new Date(o.end).getTime() - new Date(o.start).getTime(),
            ).toBe(30 * 60000);
        }
        expect(new Set(occ.map((o) => o.key)).size).toBe(occ.length);
    });

    test("daily keeps wall-clock time across a DST change", () => {
        // North-American DST starts 2026-03-08; in any zone the 9:00 must hold.
        const e = makeEvent("2026-03-05", 9 * 60, 60, {
            recurrenceRule: "FREQ=DAILY",
        });
        const occ = expandOccurrences(e, ...range("2026-03-05", 7));
        expect(occ).toHaveLength(7);
        for (const o of occ) expect(minutesOfDay(o.start)).toBe(9 * 60);
    });

    test("weekdays skips Saturday and Sunday", () => {
        const e = makeEvent(MON, 8 * 60, 60, {
            recurrenceRule: buildRRule("weekdays"),
        });
        const occ = expandOccurrences(e, ...range(MON, 14));
        expect(occ).toHaveLength(10);
        for (const o of occ) {
            const wd = new Date(o.start).getDay();
            expect(wd >= 1 && wd <= 5).toBe(true);
        }
    });

    test("weekly repeats on the start's weekday", () => {
        const e = makeEvent("2026-11-04", 18 * 60, 90, {
            recurrenceRule: "FREQ=WEEKLY",
        });
        const occ = expandOccurrences(e, ...range(MON, 28));
        expect(keys(occ)).toEqual([
            "2026-11-04",
            "2026-11-11",
            "2026-11-18",
            "2026-11-25",
        ]);
    });

    test("monthly keeps the day of month and skips months without it", () => {
        const e = makeEvent("2026-01-31", 10 * 60, 60, {
            recurrenceRule: "FREQ=MONTHLY",
        });
        const occ = expandOccurrences(e, ...range("2026-01-01", 220));
        expect(keys(occ)).toEqual([
            "2026-01-31",
            "2026-03-31",
            "2026-05-31",
            "2026-07-31",
        ]);
    });

    test("monthly far from the start still finds the right month", () => {
        const e = makeEvent("2024-02-15", 10 * 60, 60, {
            recurrenceRule: "FREQ=MONTHLY",
        });
        expect(keys(expandOccurrences(e, ...range("2026-11-01", 30)))).toEqual([
            "2026-11-15",
        ]);
    });

    test("UNTIL is an inclusive local day", () => {
        const e = makeEvent(MON, 23 * 60, 30, {
            recurrenceRule: buildRRule("daily", "2026-11-04"),
        });
        expect(keys(expandOccurrences(e, ...range(MON, 30)))).toEqual([
            "2026-11-02",
            "2026-11-03",
            "2026-11-04",
        ]);
    });

    test("nothing before the series start", () => {
        const e = makeEvent(MON, 9 * 60, 60, { recurrenceRule: "FREQ=DAILY" });
        expect(expandOccurrences(e, ...range("2026-10-20", 10))).toHaveLength(
            0,
        );
    });

    test("an occurrence spanning midnight is found from the next day's range", () => {
        const e = makeEvent(MON, 23 * 60, 120, {
            recurrenceRule: "FREQ=WEEKLY",
        });
        const occ = expandOccurrences(e, ...range("2026-11-10", 1)); // Tue after 2nd Monday
        expect(keys(occ)).toEqual(["2026-11-09"]);
    });

    test("occurrencesInRange mixes one-offs and repeats, sorted", () => {
        const a = makeEvent(MON, 12 * 60, 60, { eventId: "a" });
        const b = makeEvent(MON, 9 * 60, 60, {
            eventId: "b",
            recurrenceRule: "FREQ=DAILY",
        });
        const occ = occurrencesInRange([a, b], ...range(MON, 2));
        expect(occ.map((o) => o.eventId)).toEqual(["b", "a", "b"]);
    });
});

describe("daySegments", () => {
    test("splits all-day from timed and clips multi-day items", () => {
        const allDay = makeEvent(MON, 0, 2 * DAY_MIN, { eventId: "ad" });
        const overnight = makeEvent(MON, 22 * 60, 4 * 60, { eventId: "on" });
        const occ = occurrencesInRange([allDay, overnight], ...range(MON, 3));
        const tue = daySegments(occ, "2026-11-03");
        expect(tue.allDay.map((s) => s.item.eventId)).toEqual(["ad"]);
        expect(tue.timed.map((s) => s.item.eventId)).toEqual(["on"]);
        expect(tue.timed[0].continuesBefore).toBe(true);
        expect(tue.timed[0].endMin).toBe(120);
        const wed = daySegments(occ, "2026-11-04");
        expect(wed.allDay).toHaveLength(0);
        expect(wed.timed).toHaveLength(0);
    });
});

describe("nextInstance", () => {
    test("resolves a repeating series to its next occurrence within the horizon", () => {
        const e = makeEvent(MON, 9 * 60, 60, { recurrenceRule: "FREQ=DAILY" });
        const now = new Date(2026, 10, 5, 10, 0).getTime(); // Thu 10:00, after today's 9:00
        const next = nextInstance(e, now, 48 * 3_600_000);
        expect(localDayKey(new Date(next.start))).toBe("2026-11-06");
        expect(minutesOfDay(next.start)).toBe(9 * 60);
        expect(next.eventId).toBe(e.eventId);
    });

    test("no occurrence in the horizon → unchanged; one-offs unchanged", () => {
        const e = makeEvent(MON, 9 * 60, 60, {
            recurrenceRule: "FREQ=MONTHLY",
        });
        const now = new Date(2026, 10, 5, 10, 0).getTime();
        expect(nextInstance(e, now, 48 * 3_600_000)).toBe(e);
        const one = makeEvent(MON, 9 * 60, 60);
        expect(nextInstance(one, now, 48 * 3_600_000)).toBe(one);
    });
});
