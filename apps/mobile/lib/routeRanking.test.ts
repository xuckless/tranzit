import { describe, expect, test } from "bun:test";

import type { OTPItinerary, Route, RouteStep } from "@/types/places";
import { groupRoutes, routeArrivalEpoch } from "./routeRanking";

const T0 = Date.parse("2026-11-07T08:00:00Z") / 1000;
const iso = (offsetSecs: number) => new Date((T0 + offsetSecs) * 1000).toISOString();

function walk(secs: number): RouteStep {
  return { travelMode: "WALK", duration: `${secs}s`, distanceMeters: secs };
}

function bus(line: string, depart: number, arrive: number, stop = "Stop"): RouteStep {
  return {
    travelMode: "TRANSIT",
    duration: `${arrive - depart}s`,
    transitDetails: {
      transitLine: { nameShort: line, name: line } as never,
      stopDetails: {
        departureTime: iso(depart),
        arrivalTime: iso(arrive),
        arrivalStop: { name: stop } as never,
      },
    },
  };
}

function route(steps: RouteStep[], duration = 0, otp?: OTPItinerary): Route {
  return {
    distanceMeters: 0,
    duration: `${duration}s`,
    legs: [{ steps }],
    polyline: { encodedPolyline: "" },
    ...(otp ? { otpItinerary: otp } : {}),
  };
}

describe("routeArrivalEpoch", () => {
  test("includes the final walk after alighting", () => {
    const r = route([walk(120), bus("201", 300, 1200), walk(600)]);
    expect(routeArrivalEpoch(r, T0)).toBe(T0 + 1200 + 600);
  });

  test("no final walk → last transit arrival", () => {
    const r = route([walk(120), bus("201", 300, 1200)]);
    expect(routeArrivalEpoch(r, T0)).toBe(T0 + 1200);
  });

  test("different alighting stops: earlier bus with long walk is slower", () => {
    // A: alight at 10:00 (+600s) but 15-minute walk → +1500
    const a = route([bus("1", 0, 600, "Far stop"), walk(900)]);
    // B: alight at +900 right at the door, 2-minute walk → +1020
    const b = route([bus("2", 0, 900, "Near stop"), walk(120)]);
    expect(routeArrivalEpoch(a, T0)).toBe(T0 + 1500);
    expect(routeArrivalEpoch(b, T0)).toBe(T0 + 1020);
    expect(routeArrivalEpoch(b, T0)).toBeLessThan(routeArrivalEpoch(a, T0));

    const { meta } = groupRoutes([a, b]);
    expect(meta.get(b)!.arrival).toBeLessThan(meta.get(a)!.arrival);
  });

  test("prefers the OTP itinerary end_time when present", () => {
    const otp: OTPItinerary = {
      duration_seconds: 2000,
      walk_distance_m: 500,
      start_time: iso(0),
      end_time: iso(2000),
      legs: [],
    };
    const r = route([bus("201", 300, 1200)], 2000, otp);
    expect(routeArrivalEpoch(r, T0)).toBe(T0 + 2000);
  });

  test("falls back to the OTP last leg end_time when end_time is missing", () => {
    const otp = {
      duration_seconds: 0,
      walk_distance_m: 0,
      start_time: iso(0),
      end_time: "",
      legs: [
        { mode: "BUS", start_time: iso(0), end_time: iso(1000) },
        { mode: "WALK", start_time: iso(1000), end_time: iso(1400) },
      ],
    } as unknown as OTPItinerary;
    expect(routeArrivalEpoch(route([], 0, otp), T0)).toBe(T0 + 1400);
  });

  test("walk-only route falls back to now + duration", () => {
    const r = route([walk(900)], 900);
    expect(routeArrivalEpoch(r, T0)).toBe(T0 + 900);
  });
});
