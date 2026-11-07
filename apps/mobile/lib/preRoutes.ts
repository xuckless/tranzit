// Pre-routing for planner events: computes an arrive-by route to each event's
// searched location, caches it in the user DB (cached_pre_routes, PK "pre:{event_id}"
// so recompute is an upsert), writes travel_time back onto the event, and keeps the
// leave-now notification schedule in sync (lib/leaveNowNotifications.ts).
//
// Origin chain (user decision): a directly-preceding event with coords (ends ≤2h
// before this one starts) → the saved "Home" place → device GPS (only if permission
// is already granted — never prompt from a background compute) → skip the compute.
//
// Repeating events: every entry point resolves a series to its next occurrence
// that starts within SCHEDULE_HORIZON_MS (components/planner/recurrence.ts
// nextInstance) — same eventId, occurrence start/end — so the arrive-by route and
// the single leave-now reminder target that occurrence. travel_time stays one
// value per series.
//
// Also home to the "Leave Later" stash (Routes → add-trip handoff) and the
// notification-tap → live-trip starter used by app/_layout.tsx.

import type { User } from "@supabase/supabase-js";
import * as Location from "expo-location";
import { TranzitApiService } from "@/services/TranzitApiService";
import { middlewareUpsert } from "@/lib/middleware";
import { setEventTravelTime } from "@/lib/plannerEvents";
import {
  cancelLeaveNow,
  scheduleLeaveNow,
  LEAVE_NOW_PREFIX,
  type LeaveNowData,
} from "@/lib/leaveNowNotifications";
import { mirrorReadSavedPlaces } from "@/lib/db";
import { slugCode } from "@/lib/savedPlaces";
import { isAllDay, localDayKey, type PlannedEvent } from "@/components/planner/trip";
import { nextInstance } from "@/components/planner/recurrence";
import { routeStore, type StoredLocation } from "@/lib/routeStore";
import { saveActiveTrip } from "@/lib/activeTrip";
import { getAccessToken } from "@/lib/supabase";
import { ROUTE_SAVE_URL } from "@/lib/config";
import type { OTPItinerary } from "@/types/places";
import * as Notifications from "expo-notifications";

const preRouteId = (eventId: string) => `pre:${eventId}`;

const ORIGIN_CHAIN_MS = 2 * 3_600_000; // prev event counts as origin within 2h
const SCHEDULE_HORIZON_MS = 48 * 3_600_000; // only schedule leave-nows within 48h
const MAX_SCHEDULED = 20; // ponytail: well under iOS's 64-pending cap shared with boarding/leave-by
const RECOMPUTE_TTL_MS = 15 * 60_000; // focus-recompute throttle per event

/** A repeating event as its next occurrence within the horizon (one-offs unchanged). */
const upcoming = (e: PlannedEvent, now = Date.now()) =>
  nextInstance(e, now, SCHEDULE_HORIZON_MS);

/** In-memory recency stamp so planner-focus recomputes don't hammer the router. */
const lastComputed = new Map<string, number>();

type LatLng = { lat: number; lng: number };

function hasCoords(ev: PlannedEvent): ev is PlannedEvent & {
  locationLat: number;
  locationLng: number;
} {
  return ev.locationLat != null && ev.locationLng != null;
}

// ─── Origin resolution ─────────────────────────────────────────────────────────

async function resolveOrigin(
  user: User,
  event: PlannedEvent,
  all: PlannedEvent[],
): Promise<LatLng | null> {
  // 1. Closely-linked preceding event: ends at most 2h before this one starts.
  const startMs = new Date(event.start).getTime();
  const prev = all
    .filter(
      (e) =>
        e.eventId !== event.eventId &&
        hasCoords(e) &&
        new Date(e.end).getTime() <= startMs &&
        startMs - new Date(e.end).getTime() <= ORIGIN_CHAIN_MS,
    )
    .sort((a, b) => new Date(b.end).getTime() - new Date(a.end).getTime())[0];
  if (prev && hasCoords(prev))
    return { lat: prev.locationLat, lng: prev.locationLng };

  // 2. Saved "Home" place (offline mirror — no network).
  try {
    const homeCode = slugCode(user.id, "home");
    const home = (await mirrorReadSavedPlaces(user.id)).find(
      (r) => r.category_code === homeCode && r.lat != null && r.lng != null,
    );
    if (home) return { lat: Number(home.lat), lng: Number(home.lng) };
  } catch {
    // mirror unavailable — fall through to GPS
  }

  // 3. Device GPS, but only if permission was already granted elsewhere.
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (perm.granted) {
      const pos = await Location.getLastKnownPositionAsync();
      const p =
        pos ??
        (await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        }));
      return { lat: p.coords.latitude, lng: p.coords.longitude };
    }
  } catch {
    // no fix — skip compute
  }
  return null;
}

// ─── Compute + persist ─────────────────────────────────────────────────────────

/**
 * Persist an itinerary as the event's pre-route: cached_pre_routes upsert first
 * (user_calendar FKs it), then travel_time onto the event, then the notification.
 */
export async function persistPreRoute(
  user: User,
  series: PlannedEvent,
  itinerary: OTPItinerary,
): Promise<void> {
  const event = upcoming(series);
  const travelMin = Math.max(1, Math.round(itinerary.duration_seconds / 60));
  await middlewareUpsert("cached_pre_routes", {
    route_id: preRouteId(event.eventId),
    event_id: event.eventId,
    user_id: user.id,
    route_engine_json_response: itinerary,
    travel_time: travelMin,
  });
  await setEventTravelTime(user, event.eventId, travelMin);
  await scheduleLeaveNow(event, travelMin);
  lastComputed.set(event.eventId, Date.now());
}

/**
 * Compute (or refresh) the pre-route for one event. Returns true when a new
 * travel time was persisted. Silent on failure — travel time is a progressive
 * enhancement, never an error the user has to deal with.
 */
export async function computePreRoute(
  user: User,
  series: PlannedEvent,
  allSeries: PlannedEvent[],
): Promise<boolean> {
  const now = Date.now();
  const event = upcoming(series, now);
  const all = allSeries.map((e) => upcoming(e, now));
  try {
    // All-day events have no meaningful arrive-by time — never route or notify.
    if (
      !hasCoords(event) ||
      isAllDay(event) ||
      new Date(event.start).getTime() <= Date.now()
    ) {
      await cancelLeaveNow(event.eventId);
      return false;
    }
    const origin = await resolveOrigin(user, event, all);
    if (!origin) {
      await cancelLeaveNow(event.eventId);
      return false;
    }
    const res = await TranzitApiService.getOTPRoute({
      origin,
      destination: { lat: event.locationLat, lng: event.locationLng },
      arrival_time: event.start,
      num_itineraries: 1,
    });
    const itinerary = res.routes[0]?.otpItinerary;
    if (!itinerary) return false;
    await persistPreRoute(user, event, itinerary);
    return true;
  } catch (err) {
    if (__DEV__) console.warn("[preRoutes] compute failed", event.eventId, err);
    return false;
  }
}

/**
 * Silent refresh on Planner focus: recompute today's next few upcoming events
 * (skipping ones computed within the TTL) and reconcile the notification queue.
 * Returns true when any travel time changed so the caller can re-read.
 */
export async function recomputeUpcoming(
  user: User,
  events: PlannedEvent[],
): Promise<boolean> {
  const now = Date.now();
  const todayKey = localDayKey(new Date());
  const candidates = events
    .map((e) => upcoming(e, now))
    .filter(
      (e) =>
        hasCoords(e) &&
        new Date(e.start).getTime() > now &&
        localDayKey(new Date(e.start)) === todayKey &&
        now - (lastComputed.get(e.eventId) ?? 0) > RECOMPUTE_TTL_MS,
    )
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 3);

  let changed = false;
  for (const ev of candidates) {
    if (await computePreRoute(user, ev, events)) changed = true;
  }
  await syncSchedules(events);
  return changed;
}

/**
 * Reconcile scheduled leave-now notifications with the current event list:
 * (re)schedule the soonest MAX_SCHEDULED within the horizon, and cancel
 * orphans — events deleted on another device, past events, coords removed.
 * Never cancels on travelTime-null alone: that's the mid-recompute state.
 */
async function syncSchedules(series: PlannedEvent[]): Promise<void> {
  const now = Date.now();
  const events = series.map((e) => upcoming(e, now));
  const desired = events
    .filter(
      (e) =>
        hasCoords(e) &&
        !isAllDay(e) &&
        e.travelTime != null &&
        new Date(e.start).getTime() > now &&
        new Date(e.start).getTime() - now < SCHEDULE_HORIZON_MS,
    )
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, MAX_SCHEDULED);
  for (const ev of desired) {
    await scheduleLeaveNow(ev, ev.travelTime!);
  }

  const keep = new Set(
    events
      .filter(
        (e) =>
          hasCoords(e) && !isAllDay(e) && new Date(e.start).getTime() > now,
      )
      .map((e) => e.eventId),
  );
  try {
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    for (const n of pending) {
      const id = n.identifier;
      if (!id.startsWith(LEAVE_NOW_PREFIX)) continue;
      if (!keep.has(id.slice(LEAVE_NOW_PREFIX.length))) {
        await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
      }
    }
  } catch {
    // reconcile is best-effort
  }
}

// ─── "Leave Later" stash (Routes → add-trip handoff) ───────────────────────────

interface PlannedRouteStash {
  itinerary: OTPItinerary;
  origin: StoredLocation;
  destination: StoredLocation;
}

let _stash: PlannedRouteStash | null = null;

export function stashPlannedRoute(s: PlannedRouteStash): void {
  _stash = s;
}

/** Returns and clears the stash — one add-trip save consumes it. */
export function takePlannedRoute(): PlannedRouteStash | null {
  const s = _stash;
  _stash = null;
  return s;
}

// ─── Leave-now tap → live trip ─────────────────────────────────────────────────

/**
 * Start a live trip from a tapped leave-now notification: fresh arrive-by route
 * from the current position (the cached pre-route's departures may be stale),
 * POST /trips to Route Save, populate routeStore + the durable pointer so the
 * Commute screen picks the trip up exactly like a Routes-screen start.
 */
export async function startTripFromLeaveNow(
  data: LeaveNowData,
): Promise<boolean> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return false;
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    const origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const destination = { lat: data.lat, lng: data.lng };

    // Tapped on time → arrive by the event start; tapped late → just leave now.
    const arriveBy = new Date(data.start).getTime() > Date.now();
    const res = await TranzitApiService.getOTPRoute({
      origin,
      destination,
      num_itineraries: 1,
      ...(arriveBy ? { arrival_time: data.start } : {}),
    });
    const route = res.routes[0];
    if (!route?.otpItinerary) return false;

    // Same POST /trips contract as routes.tsx handleStart's OTP branch.
    const token = await getAccessToken();
    const resp = await fetch(`${ROUTE_SAVE_URL}/trips`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        source: "opentrip",
        route: route.otpItinerary,
        destination,
        origin,
      }),
    });
    if (!resp.ok) return false;
    const { session_id, ws_url } = (await resp.json()) as {
      session_id: string;
      ws_url: string;
    };

    const destinationInfo = { label: data.name, ...destination };
    const originInfo = { label: "Current Location", ...origin };
    const session = { sessionId: session_id, wsUrl: ws_url };
    routeStore.setSelectedRoute(route);
    routeStore.setDestination(destinationInfo);
    routeStore.setOrigin(originInfo);
    routeStore.setTripSession(session);
    await saveActiveTrip({
      session,
      destination: destinationInfo,
      origin: originInfo,
    });
    return true;
  } catch (err) {
    if (__DEV__) console.warn("[preRoutes] leave-now start failed", err);
    return false;
  }
}
