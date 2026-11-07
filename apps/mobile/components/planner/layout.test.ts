import { describe, expect, test } from "bun:test";
import { assignLanes, type LaneInput } from "./layout";

const it = (key: string, startMin: number, endMin: number): LaneInput => ({
    key,
    startMin,
    endMin,
});

describe("assignLanes", () => {
    test("non-overlapping events each get a single full-width lane", () => {
        const m = assignLanes([
            it("a", 0, 60),
            it("b", 60, 120),
            it("c", 200, 260),
        ]);
        for (const k of ["a", "b", "c"])
            expect(m.get(k)).toEqual({ lane: 0, lanes: 1 });
    });

    test("two overlapping events sit side by side", () => {
        const m = assignLanes([it("a", 60, 120), it("b", 90, 150)]);
        expect(m.get("a")).toEqual({ lane: 0, lanes: 2 });
        expect(m.get("b")).toEqual({ lane: 1, lanes: 2 });
    });

    test("three-way overlap uses three lanes", () => {
        const m = assignLanes([
            it("a", 0, 120),
            it("b", 30, 90),
            it("c", 60, 100),
        ]);
        expect(new Set([...m.values()].map((v) => v.lane))).toEqual(
            new Set([0, 1, 2]),
        );
        for (const v of m.values()) expect(v.lanes).toBe(3);
    });

    test("lanes are reused greedily; the cluster shares one lane count", () => {
        // a: 0–60, b: 30–90, c: 60–120 → c reuses a's lane; 2 lanes total.
        const m = assignLanes([
            it("a", 0, 60),
            it("b", 30, 90),
            it("c", 60, 120),
        ]);
        expect(m.get("a")).toEqual({ lane: 0, lanes: 2 });
        expect(m.get("b")).toEqual({ lane: 1, lanes: 2 });
        expect(m.get("c")).toEqual({ lane: 0, lanes: 2 });
    });

    test("separate clusters get independent lane counts", () => {
        const m = assignLanes([
            it("a", 0, 60),
            it("b", 30, 90),
            it("c", 300, 360), // alone, later
        ]);
        expect(m.get("a")!.lanes).toBe(2);
        expect(m.get("c")).toEqual({ lane: 0, lanes: 1 });
    });

    test("input order doesn't matter; longer event wins the first lane on ties", () => {
        const m = assignLanes([it("short", 60, 90), it("long", 60, 240)]);
        expect(m.get("long")).toEqual({ lane: 0, lanes: 2 });
        expect(m.get("short")).toEqual({ lane: 1, lanes: 2 });
    });

    test("minSpan makes short back-to-back events overlap visually", () => {
        const items = [it("a", 60, 65), it("b", 70, 80)];
        expect(assignLanes(items).get("b")).toEqual({ lane: 0, lanes: 1 });
        const m = assignLanes(items, 44);
        expect(m.get("a")).toEqual({ lane: 0, lanes: 2 });
        expect(m.get("b")).toEqual({ lane: 1, lanes: 2 });
    });

    test("empty input", () => {
        expect(assignLanes([]).size).toBe(0);
    });
});
