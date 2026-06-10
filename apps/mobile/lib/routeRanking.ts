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
 * When the route reaches the destination, as a Unix epoch (seconds). Uses the
 * last transit leg's arrival time; walk-only/missing-time routes fall back to
 * `nowEpoch + duration` so they still sort sensibly.
 */
export function routeArrivalEpoch(r: Route, nowEpoch: number): number {
  const last = isoToEpoch(
    transitSteps(r).at(-1)?.transitDetails?.stopDetails?.arrivalTime,
  );
  return last ?? nowEpoch + parseDurationSecs(r.duration);
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
