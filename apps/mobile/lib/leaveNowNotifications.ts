// "Leave now" reminders for planner events with a pre-routed travel time
// (lib/preRoutes.ts). One notification per event, fired 5 minutes before the
// leave-by moment (event start − travel time). Tapping it starts a live trip —
// see the response listener in app/_layout.tsx. Clone of leaveByNotifications.ts;
// shares its Android channel.

import * as Notifications from "expo-notifications";
import { LEAVE_BY_CHANNEL } from "@/lib/leaveByNotifications";
import type { PlannedEvent } from "@/components/planner/trip";

export const LEAVE_NOW_PREFIX = "leave-now-";
const BUFFER_MIN = 5; // heads-up before the leave-by moment

/** Payload carried on the notification; the tap handler re-plans from it. */
export interface LeaveNowData {
  kind: "leave-now";
  eventId: string;
  name: string;
  lat: number;
  lng: number;
  start: string; // event start ISO — the arrive-by anchor for the fresh route
}

function idFor(eventId: string) {
  return `${LEAVE_NOW_PREFIX}${eventId}`;
}

/**
 * Schedule (or reschedule) the leave-now reminder for an event. No-ops if the
 * fire time is already past or the event has no coordinates.
 */
export async function scheduleLeaveNow(
  ev: PlannedEvent,
  travelMin: number,
): Promise<void> {
  if (ev.locationLat == null || ev.locationLng == null) return;
  const fireAt =
    new Date(ev.start).getTime() - (travelMin + BUFFER_MIN) * 60_000;
  if (fireAt <= Date.now()) return;

  const { granted } = await Notifications.requestPermissionsAsync();
  if (!granted) return;

  await Notifications.cancelScheduledNotificationAsync(idFor(ev.eventId)).catch(
    () => {},
  );
  const data: LeaveNowData = {
    kind: "leave-now",
    eventId: ev.eventId,
    name: ev.name,
    lat: ev.locationLat,
    lng: ev.locationLng,
    start: ev.start,
  };
  await Notifications.scheduleNotificationAsync({
    identifier: idFor(ev.eventId),
    content: {
      title: "Time to leave",
      body: `Leave in ${BUFFER_MIN} min for ${ev.name} — tap to start your trip`,
      data: data as unknown as Record<string, unknown>,
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      channelId: LEAVE_BY_CHANNEL,
      date: new Date(fireAt),
    },
  });
}

export async function cancelLeaveNow(eventId: string): Promise<void> {
  await Promise.allSettled([
    Notifications.cancelScheduledNotificationAsync(idFor(eventId)),
    Notifications.dismissNotificationAsync(idFor(eventId)),
  ]);
}
