// Everything a sign-out must leave behind: no cached user data in SQLite, no
// scheduled leave-now / boarding notifications for the old account, no live trip
// tracking. Each step is best-effort so one failure can't block signing out.
import * as Notifications from "expo-notifications";
import { wipeLocalUserData } from "@/lib/db";
import { clearActiveTrip } from "@/lib/activeTrip";
import { stopBackgroundTracking } from "@/lib/backgroundLocation";
import { endTripActivity } from "@/lib/liveActivity";

export async function cleanUpAfterSignOut(): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ["local data", wipeLocalUserData],
    ["notifications", () => Notifications.cancelAllScheduledNotificationsAsync()],
    ["active trip", clearActiveTrip],
    ["background location", stopBackgroundTracking],
    ["live activity", () => endTripActivity()],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (err) {
      console.warn(`[signOut] could not clear ${name}`, err);
    }
  }
}
