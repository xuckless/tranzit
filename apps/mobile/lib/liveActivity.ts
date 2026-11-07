import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as ExpoLiveActivity from "expo-live-activity";

export const TRIP_PROGRESS_CHANNEL = "trip_progress";
const TRIP_PROGRESS_NOTIF_ID = "tranzit-trip-live";

export interface TripActivityInput {
  routeName: string;
  destination: string;
  currentStopName: string;
  nextStopName: string;
  etaMinutes: number;
  progressDots: Array<"departed" | "current" | "upcoming">;
  journeyFraction: number; // 0..1
}

let _iosActivityId: string | null = null;

function buildDotString(dots: TripActivityInput["progressDots"]): string {
  return dots.map((d) => (d === "departed" ? "⬤" : d === "current" ? "◉" : "○")).join(" ");
}

function buildTitle(input: TripActivityInput): string {
  return `${input.routeName} · ${input.etaMinutes} min`;
}

function buildSubtitle(input: TripActivityInput): string {
  return `${input.currentStopName}  ${buildDotString(input.progressDots)}  ${input.nextStopName}`;
}

export async function setupTripProgressChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(TRIP_PROGRESS_CHANNEL, {
    name: "Trip Progress",
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: null,
    vibrationPattern: null,
    showBadge: false,
  });
}

/**
 * Start the trip's Live Activity (iOS) / sticky notification (Android).
 * Idempotent: if an activity is already running it is updated in place instead
 * of starting a second one (re-calling start on every tab return used to orphan
 * the previous activity on the Lock Screen).
 */
export async function startTripActivity(input: TripActivityInput): Promise<void> {
  try {
    if (Platform.OS === "ios") {
      if (_iosActivityId) {
        ExpoLiveActivity.updateActivity(_iosActivityId, {
          title: buildTitle(input),
          subtitle: buildSubtitle(input),
          progressBar: { progress: input.journeyFraction },
        });
        return;
      }
      const id = ExpoLiveActivity.startActivity(
        {
          title: buildTitle(input),
          subtitle: buildSubtitle(input),
          progressBar: { progress: input.journeyFraction },
        },
        { deepLinkUrl: "tranzit://commute" },
      );
      if (_iosActivityId && id && _iosActivityId !== id) {
        // Defensive: never leave a previous activity running behind the new one.
        try {
          ExpoLiveActivity.stopActivity(_iosActivityId, { title: "Journey Complete", subtitle: "" });
        } catch {
          // ignore
        }
      }
      _iosActivityId = id ?? null;
    } else {
      await _presentAndroidNotification(input);
    }
  } catch {
    // Live activity failures must never crash the journey
  }
}

export async function updateTripActivity(input: TripActivityInput): Promise<void> {
  try {
    if (Platform.OS === "ios") {
      if (!_iosActivityId) return;
      ExpoLiveActivity.updateActivity(_iosActivityId, {
        title: buildTitle(input),
        subtitle: buildSubtitle(input),
        progressBar: { progress: input.journeyFraction },
      });
    } else {
      await _presentAndroidNotification(input);
    }
  } catch {
    // safe to ignore
  }
}

export async function endTripActivity(finalSubtitle = ""): Promise<void> {
  try {
    if (Platform.OS === "ios") {
      if (_iosActivityId) {
        const id = _iosActivityId;
        _iosActivityId = null;
        ExpoLiveActivity.stopActivity(id, {
          title: "Journey Complete",
          subtitle: finalSubtitle,
        });
      }
    } else {
      await Notifications.dismissNotificationAsync(TRIP_PROGRESS_NOTIF_ID);
    }
  } catch {
    // safe to ignore
  }
}

async function _presentAndroidNotification(input: TripActivityInput): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    identifier: TRIP_PROGRESS_NOTIF_ID,
    content: {
      title: buildTitle(input),
      body: buildSubtitle(input),
      sticky: true,
      priority: Notifications.AndroidNotificationPriority.DEFAULT,
      data: { type: "trip_progress" },
    },
    trigger: { channelId: TRIP_PROGRESS_CHANNEL },
  });
}
