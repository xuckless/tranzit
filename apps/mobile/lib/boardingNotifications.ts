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

export async function scheduleBoarding(
  stopId: string,
  stopName: string,
  sessionId: string,
): Promise<void> {
  const { granted } = await Notifications.requestPermissionsAsync();
  if (!granted) return;

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
        title: "Still on board?",
        body: `60 seconds remain to confirm boarding at ${stopName}.`,
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
