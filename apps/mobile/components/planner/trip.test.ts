import { describe, expect, test } from "bun:test";
import { makeEvent } from "./testUtil";
import {
    addDays,
    addMonths,
    allDayLocalMidnight,
    clipToDay,
    dayStart,
    durationMin,
    eventsInRange,
    isAllDay,
    isoForDay,
    localDayKey,
    minutesOfDay,
    monthGridDays,
    shiftEvent,
    startOfWeek,
    DAY_MIN,
} from "./trip";

const day = "2026-06-28";
const ev = (startMin: number, durMin: number) =>
    makeEvent(day, startMin, durMin);
const dayRange = (key: string): [Date, Date] => [
    dayStart(key),
    addDays(dayStart(key), 1),
];

// ─── Ported from the old trip.selfcheck.ts ──────────────────────────────────
describe("timeline ↔ timestamp math (ported selfcheck)", () => {
    test("isoForDay ↔ minutesOfDay round-trip", () => {
        for (const min of [0, 525, 13 * 60 + 5, DAY_MIN - 5]) {
            expect(minutesOfDay(isoForDay(day, min))).toBe(min);
        }
    });

    test("localDayKey of an isoForDay timestamp is the same day", () => {
        expect(localDayKey(new Date(isoForDay(day, 525)))).toBe(day);
    });

    test("duration + day membership (was eventOnDay)", () => {
        const e1 = ev(8 * 60, 60);
        expect(durationMin(e1)).toBe(60);
        expect(eventsInRange([e1], ...dayRange(day))).toHaveLength(1);
        expect(eventsInRange([e1], ...dayRange("2026-06-27"))).toHaveLength(0);
    });

    test("shiftEvent moves both ends, preserving duration", () => {
        const e2 = shiftEvent(ev(8 * 60, 60), 30);
        expect(minutesOfDay(e2.start)).toBe(8 * 60 + 30);
        expect(durationMin(e2)).toBe(60);
    });

    test("shiftEvent clamps at 00:00", () => {
        const e3 = shiftEvent(ev(10, 60), -100);
        expect(minutesOfDay(e3.start)).toBe(0);
        expect(durationMin(e3)).toBe(60);
    });

    test("shiftEvent clamps at 24:00", () => {
        const e4 = shiftEvent(ev(DAY_MIN - 60, 60), 200);
        const endMin = minutesOfDay(e4.end);
        expect(endMin === 0 || endMin === DAY_MIN).toBe(true);
        expect(durationMin(e4)).toBe(60);
    });

    test("no-op shift returns the same reference", () => {
        const e1 = ev(8 * 60, 60);
        expect(shiftEvent(e1, 0)).toBe(e1);
    });

    test("isAllDay", () => {
        expect(isAllDay(ev(0, DAY_MIN))).toBe(true);
        expect(isAllDay(ev(0, 3 * DAY_MIN))).toBe(true);
        expect(isAllDay(ev(0, DAY_MIN - 1))).toBe(false);
        expect(isAllDay(ev(8 * 60, 60))).toBe(false);
    });

    test("allDayLocalMidnight handles UTC- and local-aligned inputs", () => {
        expect(
            allDayLocalMidnight(new Date(Date.UTC(2026, 6, 10))).getTime(),
        ).toBe(new Date(2026, 6, 10).getTime());
        expect(allDayLocalMidnight(new Date(2026, 6, 10)).getTime()).toBe(
            new Date(2026, 6, 10).getTime(),
        );
    });
});

// ─── eventsInRange ──────────────────────────────────────────────────────────
describe("eventsInRange", () => {
    test("half-open overlap", () => {
        const a = ev(9 * 60, 60); // 9–10
        const [s, e] = [
            new Date(isoForDay(day, 10 * 60)),
            new Date(isoForDay(day, 11 * 60)),
        ];
        expect(eventsInRange([a], s, e)).toHaveLength(0); // ends exactly at range start
        const [s2, e2] = [
            new Date(isoForDay(day, 8 * 60)),
            new Date(isoForDay(day, 9 * 60)),
        ];
        expect(eventsInRange([a], s2, e2)).toHaveLength(0); // starts exactly at range end
        const [s3, e3] = [
            new Date(isoForDay(day, 9 * 60 + 59)),
            new Date(isoForDay(day, 12 * 60)),
        ];
        expect(eventsInRange([a], s3, e3)).toHaveLength(1);
    });

    test("multi-day event appears on every covered day", () => {
        const long = ev(22 * 60, 2 * DAY_MIN); // Jun 28 22:00 → Jun 30 22:00
        for (const k of ["2026-06-28", "2026-06-29", "2026-06-30"]) {
            expect(eventsInRange([long], ...dayRange(k))).toHaveLength(1);
        }
        expect(eventsInRange([long], ...dayRange("2026-07-01"))).toHaveLength(
            0,
        );
        expect(eventsInRange([long], ...dayRange("2026-06-27"))).toHaveLength(
            0,
        );
    });

    test("zero-length events count when their instant is inside", () => {
        const z = ev(12 * 60, 0);
        expect(eventsInRange([z], ...dayRange(day))).toHaveLength(1);
        expect(
            eventsInRange([ev(0, 0)], ...dayRange("2026-06-27")),
        ).toHaveLength(0);
    });
});

// ─── clipToDay ──────────────────────────────────────────────────────────────
describe("clipToDay", () => {
    test("same-day event is unclipped", () => {
        const seg = clipToDay(ev(9 * 60, 90), day)!;
        expect(seg.startMin).toBe(540);
        expect(seg.endMin).toBe(630);
        expect(seg.continuesBefore).toBe(false);
        expect(seg.continuesAfter).toBe(false);
    });

    test("event crossing midnight is split across both days", () => {
        const e = ev(23 * 60, 120); // 23:00 → 01:00 next day
        const first = clipToDay(e, day)!;
        expect(first.startMin).toBe(23 * 60);
        expect(first.endMin).toBe(DAY_MIN);
        expect(first.continuesBefore).toBe(false);
        expect(first.continuesAfter).toBe(true);
        const second = clipToDay(e, "2026-06-29")!;
        expect(second.startMin).toBe(0);
        expect(second.endMin).toBe(60);
        expect(second.continuesBefore).toBe(true);
        expect(second.continuesAfter).toBe(false);
    });

    test("middle day of a 3-day event covers the whole day", () => {
        const e = ev(20 * 60, 2 * DAY_MIN);
        const mid = clipToDay(e, "2026-06-29")!;
        expect(mid.startMin).toBe(0);
        expect(mid.endMin).toBe(DAY_MIN);
        expect(mid.continuesBefore).toBe(true);
        expect(mid.continuesAfter).toBe(true);
    });

    test("ending exactly at midnight is not a continuation", () => {
        const e = ev(22 * 60, 120); // 22:00 → 24:00
        const seg = clipToDay(e, day)!;
        expect(seg.endMin).toBe(DAY_MIN);
        expect(seg.continuesAfter).toBe(false);
        expect(clipToDay(e, "2026-06-29")).toBeNull();
    });

    test("non-touching day returns null", () => {
        expect(clipToDay(ev(9 * 60, 60), "2026-06-30")).toBeNull();
    });

    test("multi-day all-day event clips to whole days", () => {
        const e = ev(0, 3 * DAY_MIN);
        const seg = clipToDay(e, "2026-06-29")!;
        expect(seg.startMin).toBe(0);
        expect(seg.endMin).toBe(DAY_MIN);
        expect(clipToDay(e, "2026-07-01")).toBeNull();
    });
});

// ─── Calendar helpers ───────────────────────────────────────────────────────
describe("calendar helpers", () => {
    test("startOfWeek is the Monday on/before", () => {
        expect(localDayKey(startOfWeek(new Date(2026, 10, 7)))).toBe(
            "2026-11-02",
        ); // Sat
        expect(localDayKey(startOfWeek(new Date(2026, 10, 2)))).toBe(
            "2026-11-02",
        ); // Mon
        expect(localDayKey(startOfWeek(new Date(2026, 10, 8)))).toBe(
            "2026-11-02",
        ); // Sun
    });

    test("addMonths clamps to the target month's length", () => {
        expect(localDayKey(addMonths(new Date(2026, 0, 31), 1))).toBe(
            "2026-02-28",
        );
        expect(localDayKey(addMonths(new Date(2026, 10, 7), -1))).toBe(
            "2026-10-07",
        );
        expect(localDayKey(addMonths(new Date(2026, 11, 15), 1))).toBe(
            "2027-01-15",
        );
    });

    test("monthGridDays: 42 Monday-first days containing the 1st", () => {
        const days = monthGridDays(new Date(2026, 10, 18));
        expect(days).toHaveLength(42);
        expect(days[0].getDay()).toBe(1);
        expect(localDayKey(days[0])).toBe("2026-10-26");
        expect(days.some((d) => localDayKey(d) === "2026-11-01")).toBe(true);
        expect(days.some((d) => localDayKey(d) === "2026-11-30")).toBe(true);
    });
});
