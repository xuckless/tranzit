// Background GPS for an active trip.
//
// The foreground watcher in commute.tsx (watchPositionAsync) stops delivering
// once the app is backgrounded, so the server stops seeing the rider. While a
// trip is active we additionally run Location.startLocationUpdatesAsync with a
// TaskManager task; its fixes feed the same path as the foreground watcher
// (submitLocation → LOCATION frame on the trip WebSocket, or kept as the latest
// fix and sent on reconnect if the socket is down).
//
// REGISTRATION: TaskManager.defineTask must run at module scope, before React
// mounts, every time the JS bundle starts — including a headless relaunch by the
// OS to deliver a background location batch. This module is imported for its
// side effect from the top of app/(tabs)/commute.tsx. Because expo-router may
// load route modules lazily, the most robust place is the root
// app/_layout.tsx (`import "@/lib/backgroundLocation";`). If the task is not
// defined when the OS delivers a batch, expo-task-manager just logs a warning
// and drops it; there is no live socket in that case anyway.

import { Alert, AppState } from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { submitLocation } from "@/lib/tripWebSocket";

export const TRIP_LOCATION_TASK = "tranzit-trip-location";

/** Min spacing between background LOCATION frames (matches the foreground throttle). */
const MIN_SEND_INTERVAL_MS = 5000;
let _lastBgSentAt = 0;

TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(
  TRIP_LOCATION_TASK,
  async ({ data, error }) => {
    if (error) {
      console.warn("[backgroundLocation] task error:", error.message);
      return;
    }
    const locations = data?.locations;
    if (!locations?.length) return;
    // While the app is in the foreground the watchPositionAsync subscription is
    // already sending; don't double up.
    if (AppState.currentState === "active") return;
    const now = Date.now();
    if (now - _lastBgSentAt < MIN_SEND_INTERVAL_MS) return;
    _lastBgSentAt = now;
    // Batches arrive oldest → newest; only the latest position matters.
    const { coords } = locations[locations.length - 1];
    submitLocation(
      coords.latitude,
      coords.longitude,
      coords.speed ?? undefined,
      coords.heading ?? undefined,
    );
  },
);

// Ask for "Always" only once per app run; a refusal falls back to foreground
// tracking without nagging on every trip.
let _askedThisRun = false;

function explain(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Keep tracking in the background?",
      "Tranzit uses your location while your phone is locked or another app is open, so it can tell when you board, update your arrival time and warn you before your stop. It is only used during an active trip and stops when the trip ends.",
      [
        { text: "Not now", style: "cancel", onPress: () => resolve(false) },
        { text: "Continue", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

async function ensureBackgroundPermission(): Promise<boolean> {
  const fg = await Location.getForegroundPermissionsAsync();
  if (!fg.granted) {
    const req = await Location.requestForegroundPermissionsAsync();
    if (!req.granted) return false;
  }
  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.granted) return true;
  if (!bg.canAskAgain || _askedThisRun) return false;
  _askedThisRun = true;
  if (!(await explain())) return false;
  const res = await Location.requestBackgroundPermissionsAsync();
  return res.granted;
}

/**
 * Start background location updates for the active trip. Requests background
 * permission (with an explanation) the first time; if it is denied, returns
 * false and the caller keeps foreground-only tracking. Safe to call repeatedly.
 */
export async function startBackgroundTracking(): Promise<boolean> {
  try {
    if (!(await TaskManager.isAvailableAsync())) return false;
    if (!(await ensureBackgroundPermission())) return false;
    if (await Location.hasStartedLocationUpdatesAsync(TRIP_LOCATION_TASK)) return true;
    _lastBgSentAt = 0;
    await Location.startLocationUpdatesAsync(TRIP_LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 20,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.OtherNavigation,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "Tranzit is tracking your trip",
        notificationBody: "Live trip updates are on until you arrive or end the journey.",
        killServiceOnDestroy: true,
      },
    });
    return true;
  } catch (e) {
    console.warn("[backgroundLocation] start failed:", e);
    return false;
  }
}

/** Stop background updates (trip completed or ended). Safe to call when not running. */
export async function stopBackgroundTracking(): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(TRIP_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(TRIP_LOCATION_TASK);
    }
  } catch (e) {
    console.warn("[backgroundLocation] stop failed:", e);
  }
}
