import { useEffect } from "react";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as Notifications from "expo-notifications";
import {
  BOARDING_CATEGORY,
  ACTION_YES,
  registerBoardingCategory,
  setupBoardingChannel,
  cancelBoarding,
} from "@/lib/boardingNotifications";
import { setupTripProgressChannel } from "@/lib/liveActivity";

const ROUTE_SAVE_URL = process.env.EXPO_PUBLIC_ROUTE_SAVE_URL ?? "";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function RootLayout() {
  useEffect(() => {
    setupBoardingChannel();
    registerBoardingCategory();
    setupTripProgressChannel();

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const { actionIdentifier, notification } = response;
      if (notification.request.content.categoryIdentifier !== BOARDING_CATEGORY) return;

      const data = notification.request.content.data as { stopId?: string; sessionId?: string };
      const { stopId, sessionId } = data;
      if (!stopId || !sessionId) return;

      const boarded = actionIdentifier === ACTION_YES;

      if (ROUTE_SAVE_URL) {
        fetch(`${ROUTE_SAVE_URL}/trips/${sessionId}/unsure-response`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stop_id: stopId, boarded }),
        }).catch(() => {});
      }

      cancelBoarding(stopId);
    });

    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }} />
    </GestureHandlerRootView>
  );
}
