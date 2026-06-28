// Runnable self-check for the timeline ↔ timestamp math. Pure functions only, no
// React/Native — run with: `bun components/planner/trip.selfcheck.ts`
import assert from "node:assert";
import {
    type PlannedEvent,
    minutesOfDay,
    isoForDay,
    localDayKey,
    eventOnDay,
    durationMin,
    shiftEvent,
    DAY_MIN,
} from "./trip";

const day = "2026-06-28";

// isoForDay ↔ minutesOfDay round-trip (both local-time based).
for (const min of [0, 525, 13 * 60 + 5, DAY_MIN - 5]) {
    assert.strictEqual(minutesOfDay(isoForDay(day, min)), min, `round-trip ${min}`);
}

// localDayKey of an isoForDay timestamp is the same day.
assert.strictEqual(localDayKey(new Date(isoForDay(day, 525))), day);

const ev = (startMin: number, durMin: number): PlannedEvent => ({
    eventId: "x",
    name: "n",
    location: null,
    notes: null,
    start: isoForDay(day, startMin),
    end: isoForDay(day, startMin + durMin),
    timezone: null,
    pending: false,
    imported: false,
});

// duration is preserved and correct.
const e1 = ev(8 * 60, 60);
assert.strictEqual(durationMin(e1), 60);
assert.strictEqual(eventOnDay(e1, day), true);
assert.strictEqual(eventOnDay(e1, "2026-06-27"), false);

// shiftEvent moves both ends, preserving duration.
const e2 = shiftEvent(e1, 30);
assert.strictEqual(minutesOfDay(e2.start), 8 * 60 + 30);
assert.strictEqual(durationMin(e2), 60);

// clamp: can't start before 00:00.
const e3 = shiftEvent(ev(10, 60), -100);
assert.strictEqual(minutesOfDay(e3.start), 0);
assert.strictEqual(durationMin(e3), 60);

// clamp: can't push the block past 24:00.
const e4 = shiftEvent(ev(DAY_MIN - 60, 60), 200);
assert.strictEqual(minutesOfDay(e4.end) === 0 || minutesOfDay(e4.end) === DAY_MIN, true);
assert.strictEqual(durationMin(e4), 60);

// no-op shift returns the same reference.
assert.strictEqual(shiftEvent(e1, 0), e1);

console.log("trip.selfcheck: OK");
