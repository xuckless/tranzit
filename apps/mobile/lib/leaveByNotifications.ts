import * as Notifications from "expo-notifications";

export const LEAVE_BY_CHANNEL = "leave_by";

function idFor(sessionId: string) {
  return `leave-by-${sessionId}`;
}

export async function setupLeaveByChannel(): Promise<void> {
  await Notifications.setNotificationChannelAsync(LEAVE_BY_CHANNEL, {
    name: "Leave-by Reminder",
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
    vibrationPattern: [0, 250, 250, 250],
    showBadge: false,
  });
}

/**
 * Schedule the "start heading to your stop" reminder at the leave-by time
 * (bus arrival − walk duration − buffer, computed by the commute screen).
 * One notification per session — rescheduling replaces the previous one.
 * No-ops if the leave-by moment has already passed.
 */
export async function scheduleLeaveBy(
  sessionId: string,
  stopName: string,
  leaveByEpoch: number,
): Promise<void> {
  if (leaveByEpoch * 1000 <= Date.now()) return;

  const { granted } = await Notifications.requestPermissionsAsync();
  if (!granted) return;

  await Notifications.cancelScheduledNotificationAsync(idFor(sessionId)).catch(
    () => {},
  );
  await Notifications.scheduleNotificationAsync({
    identifier: idFor(sessionId),
    content: {
      title: "Time to go",
      body: `Start heading to ${stopName} now`,
      data: { sessionId },
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      channelId: LEAVE_BY_CHANNEL,
      date: new Date(leaveByEpoch * 1000),
    },
  });
}

export async function cancelLeaveBy(sessionId: string): Promise<void> {
  await Promise.allSettled([
    Notifications.cancelScheduledNotificationAsync(idFor(sessionId)),
    Notifications.dismissNotificationAsync(idFor(sessionId)),
  ]);
}
