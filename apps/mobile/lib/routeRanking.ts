import type { Route, RouteStep } from "@/types/places";

// Grouping/ranking helpers for the Routes screen. Routes are sectioned by the
// transit line(s) they ride ("201", "201+30", …) and ranked by wall-clock
// times parsed from the itinerary, not by the order the engine returned them.

function transitSteps(r: Route): RouteStep[] {
  return (r.legs ?? [])
    .flatMap((l) => l.steps ?? [])
    .filter((s) => s.travelMode === "TRANSIT");
}

function parseDurationSecs(dur: string | undefined): number {
  const secs = parseInt((dur ?? "").replace("s", ""), 10);
  return isNaN(secs) ? 0 : secs;
}

function isoToEpoch(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : t / 1000;
}

/**
 * Section key for a route: the deduped short names of every transit line it
 * uses, in boarding order, joined with "+" — e.g. "201", "201+30". Walk-only
 * routes group under "Walk".
 */
export function routeGroupKey(r: Route): string {
  const names: string[] = [];
  for (const s of transitSteps(r)) {
    const n =
      s.transitDetails?.transitLine?.nameShort ??
      s.transitDetails?.transitLine?.name;
    if (n && !names.includes(n)) names.push(n);
  }
  return names.length > 0 ? names.join("+") : "Walk";
}

/**
 * When the route reaches the destination, as a Unix epoch (seconds) — the
 * itinerary's true end, including any final walk after alighting.
 *
 * 1. OTP: the itinerary's `end_time` (or its last leg's `end_time`).
 * 2. Otherwise: the last transit step's arrival time plus the durations of
 *    every step after it (the walk from the alighting stop).
 * 3. Walk-only / missing times: `nowEpoch + duration`.
 */
export function routeArrivalEpoch(r: Route, nowEpoch: number): number {
  const otp = r.otpItinerary;
  if (otp) {
    const end = isoToEpoch(otp.end_time) ?? isoToEpoch(otp.legs?.at(-1)?.end_time);
    if (end != null) return end;
  }

  const steps = (r.legs ?? []).flatMap((l) => l.steps ?? []);
  let lastTransitIdx = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].travelMode === "TRANSIT") {
      lastTransitIdx = i;
      break;
    }
  }
  if (lastTransitIdx >= 0) {
    const alight = isoToEpoch(
      steps[lastTransitIdx].transitDetails?.stopDetails?.arrivalTime,
    );
    if (alight != null) {
      const tail = steps
        .slice(lastTransitIdx + 1)
        .reduce(
          (sum, s) => sum + parseDurationSecs(s.duration ?? s.staticDuration),
          0,
        );
      return alight + tail;
    }
  }
  return nowEpoch + parseDurationSecs(r.duration);
}

/**
 * When the first bus departs its boarding stop, as a Unix epoch (seconds).
 * Same fallback as routeArrivalEpoch for walk-only routes.
 */
export function routeFirstDepartureEpoch(r: Route, nowEpoch: number): number {
  const first = isoToEpoch(
    transitSteps(r)[0]?.transitDetails?.stopDetails?.departureTime,
  );
  return first ?? nowEpoch + parseDurationSecs(r.duration);
}

export interface RouteMeta {
  group: string;
  arrival: number;
  departure: number;
}

export interface GroupedRoutes {
  /** Per-route precomputed key + times, so sort comparators stay pure. */
  meta: Map<Route, RouteMeta>;
  /** Section key → routes, each section ascending by first bus departure. */
  groups: Map<string, Route[]>;
}

export function groupRoutes(routes: Route[]): GroupedRoutes {
  const now = Date.now() / 1000;
  const meta = new Map<Route, RouteMeta>();
  const groups = new Map<string, Route[]>();
  for (const r of routes) {
    const m = {
      group: routeGroupKey(r),
      arrival: routeArrivalEpoch(r, now),
      departure: routeFirstDepartureEpoch(r, now),
    };
    meta.set(r, m);
    const arr = groups.get(m.group);
    if (arr) arr.push(r);
    else groups.set(m.group, [r]);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => meta.get(a)!.departure - meta.get(b)!.departure);
  }
  return { meta, groups };
}

/** Total walking distance in metres across all legs/steps. */
export function routeWalkDistance(r: Route): number {
  if (r.otpItinerary?.walk_distance_m != null) return r.otpItinerary.walk_distance_m;
  return (r.legs ?? [])
    .flatMap((l) => l.steps ?? [])
    .filter((s) => s.travelMode === "WALK")
    .reduce((sum, s) => sum + (s.distanceMeters ?? 0), 0);
}

/** True if any leg of the route rides the CTrain/LRT (used for chip icons). */
export function routeUsesTrain(r: Route): boolean {
  return transitSteps(r).some((s) => {
    const name = (s.transitDetails?.transitLine?.name ?? "").toLowerCase();
    const ns = (s.transitDetails?.transitLine?.nameShort ?? "").toLowerCase();
    return (
      name.includes("ctrain") || name.includes("lrt") || ns.includes("ctrain")
    );
  });
}
