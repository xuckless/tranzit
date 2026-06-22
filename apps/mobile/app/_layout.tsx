import { useEffect } from "react";
import { Stack } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import * as WebBrowser from "expo-web-browser";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { UserSync } from "@/components/auth/UserSync";
import * as Notifications from "expo-notifications";
import {
  BOARDING_CATEGORY,
  ACTION_YES,
  registerBoardingCategory,
  setupBoardingChannel,
  cancelBoarding,
} from "@/lib/boardingNotifications";
import { setupLeaveByChannel } from "@/lib/leaveByNotifications";
import { setupTripProgressChannel } from "@/lib/liveActivity";
import { submitUnsureResponse } from "@/lib/tripWebSocket";

// Required so the OAuth/SSO web-browser redirect resolves back into the app.
WebBrowser.maybeCompleteAuthSession();

const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;
if (!publishableKey) {
  throw new Error(
    "Add EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY to your .env.local (copy it from the Clerk dashboard).",
  );
}

// Notification handlers
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Main component
export default function RootLayout() {
  useEffect(() => {
    setupBoardingChannel();
    registerBoardingCategory();
    setupLeaveByChannel();
    setupTripProgressChannel();

    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const { actionIdentifier, notification } = response;
        if (
          notification.request.content.categoryIdentifier !== BOARDING_CATEGORY
        )
          return;

        const data = notification.request.content.data as {
          stopId?: string;
          sessionId?: string;
        };
        const { stopId, sessionId } = data;
        if (!stopId || !sessionId) return;

        const boarded = actionIdentifier === ACTION_YES;

        // UNSURE_RESPONSE is a WebSocket message — Route Save exposes no REST
        // endpoint for it. Deliver over the live trip socket (queued + flushed on
        // connect if it is momentarily down).
        submitUnsureResponse(stopId, boarded);

        cancelBoarding(stopId);
      },
    );

    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
        <ThemeProvider>
          <UserSync />
          <Stack screenOptions={{ headerShown: false }} />
        </ThemeProvider>
      </ClerkProvider>
    </GestureHandlerRootView>
  );
}
