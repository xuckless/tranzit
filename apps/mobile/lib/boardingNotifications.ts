import * as Notifications from "expo-notifications";

export const BOARDING_CATEGORY = "BOARDING_CONFIRM";
export const BOARDING_CHANNEL = "boarding_confirm";
export const ACTION_YES = "BOARDING_YES";
export const ACTION_NO = "BOARDING_NO";

function idFor(stopId: string, slot: 0 | 60) {
  return `boarding-${stopId}-${slot}`;
}

export async function setupBoardingChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(BOARDING_CHANNEL, {
    name: "Boarding Confirmation",
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
    vibrationPattern: [0, 250, 250, 250],
    showBadge: false,
  });
}

export async function registerBoardingCategory(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(BOARDING_CATEGORY, [
    {
      identifier: ACTION_YES,
      buttonTitle: "Yes, I boarded",
      options: { isDestructive: false, isAuthenticationRequired: false },
    },
    {
      identifier: ACTION_NO,
      buttonTitle: "I missed it",
      options: { isDestructive: true, isAuthenticationRequired: false },
    },
  ]);
}

// Cached notification-permission result. Requested once when a trip starts
// (ensureNotificationPermission) — not on every schedule call, which re-prompted
// / re-queried the OS for each boarding question.
let _permission: boolean | null = null;

/**
 * Ask for notification permission once (call when a trip starts) and cache the
 * answer for later schedule calls. Returns whether notifications are allowed.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (_permission != null) return _permission;
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) {
      _permission = true;
    } else if (current.canAskAgain) {
      _permission = (await Notifications.requestPermissionsAsync()).granted;
    } else {
      _permission = false;
    }
  } catch {
    _permission = false;
  }
  return _permission;
}

async function hasNotificationPermission(): Promise<boolean> {
  if (_permission != null) return _permission;
  // Not asked yet this run (e.g. trip restored after a cold start): read the
  // current status without prompting.
  // Only a grant is cached here, so a later ensureNotificationPermission() can
  // still prompt.
  try {
    const granted = (await Notifications.getPermissionsAsync()).granted;
    if (granted) _permission = true;
    return granted;
  } catch {
    return false;
  }
}

export async function scheduleBoarding(
  stopId: string,
  stopName: string,
  sessionId: string,
): Promise<void> {
  if (!(await hasNotificationPermission())) return;

  const data = { stopId, sessionId };
  const baseContent: Notifications.NotificationContentInput = {
    title: "Did you board the bus?",
    body: `Confirm whether you boarded at ${stopName}.`,
    data,
    categoryIdentifier: BOARDING_CATEGORY,
    sound: true,
  };

  await Promise.allSettled([
    Notifications.scheduleNotificationAsync({
      identifier: idFor(stopId, 0),
      content: baseContent,
      trigger: { channelId: BOARDING_CHANNEL },
    }),
    Notifications.scheduleNotificationAsync({
      identifier: idFor(stopId, 60),
      content: {
        ...baseContent,
        title: "Did you make it on?",
        body: `Reminder: let us know whether you boarded at ${stopName} so we can keep your trip on track.`,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        channelId: BOARDING_CHANNEL,
        seconds: 60,
        repeats: false,
      },
    }),
  ]);
}

export async function cancelBoarding(stopId: string): Promise<void> {
  await Promise.allSettled([
    Notifications.cancelScheduledNotificationAsync(idFor(stopId, 0)),
    Notifications.cancelScheduledNotificationAsync(idFor(stopId, 60)),
    Notifications.dismissNotificationAsync(idFor(stopId, 0)),
    Notifications.dismissNotificationAsync(idFor(stopId, 60)),
  ]);
}
