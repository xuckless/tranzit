import { useEffect, useState } from "react";
import { router, Stack } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as WebBrowser from "expo-web-browser";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { UserSync } from "@/components/auth/UserSync";
import { useSearchHistorySync } from "@/hooks/useSearchHistory";
import * as Notifications from "expo-notifications";
import {
  BOARDING_CATEGORY,
  ACTION_YES,
  registerBoardingCategory,
  setupBoardingChannel,
  cancelBoarding,
} from "@/lib/boardingNotifications";
import { setupLeaveByChannel } from "@/lib/leaveByNotifications";
import type { LeaveNowData } from "@/lib/leaveNowNotifications";
import { startTripFromLeaveNow } from "@/lib/preRoutes";
import { setupTripProgressChannel } from "@/lib/liveActivity";
import { submitUnsureResponse } from "@/lib/tripWebSocket";
// Registers the background-location task at startup: if the OS relaunches the app
// headless to deliver a location batch, the task must already be defined.
import "@/lib/backgroundLocation";
import { LogBox } from "react-native";
import { DEMO_MODE } from "@/lib/demo";

// Demo builds are dev builds, and LogBox's yellow toasts would sit over the tab
// bar during a showcase. Warnings still print in the Metro terminal.
if (DEMO_MODE) LogBox.ignoreAllLogs(true);

// Required so the OAuth web-browser redirect resolves back into the app.
WebBrowser.maybeCompleteAuthSession();

// Notification handlers
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Drains the offline search-history outbox and prunes remote history to the cap
// once a user is available. Renders nothing; mounted inside AuthProvider.
function SearchHistorySync() {
  useSearchHistorySync();
  return null;
}

// Main component
export default function RootLayout() {
  const [startingTrip, setStartingTrip] = useState(false);

  useEffect(() => {
    setupBoardingChannel();
    registerBoardingCategory();
    setupLeaveByChannel();
    setupTripProgressChannel();

    // Tapping a leave-now reminder: fresh arrive-by route → POST /trips →
    // Commute live. On any failure, land on Routes prefilled so the user can
    // pick a route themselves.
    async function handleLeaveNow(data: LeaveNowData) {
      setStartingTrip(true);
      try {
        if (await startTripFromLeaveNow(data)) {
          router.navigate("/(tabs)/commute" as never);
          return;
        }
        throw new Error("start failed");
      } catch {
        Alert.alert("Couldn't start your trip", "Pick a route to get going.");
        router.navigate({
          pathname: "/(tabs)/routes",
          params: {
            destinationLat: String(data.lat),
            destinationLng: String(data.lng),
            destinationName: data.name,
          },
        } as never);
      } finally {
        setStartingTrip(false);
      }
    }

    const sub = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const { actionIdentifier, notification } = response;

        const raw = notification.request.content.data as Record<
          string,
          unknown
        > | null;
        if (raw?.kind === "leave-now") {
          void handleLeaveNow(raw as unknown as LeaveNowData);
          return;
        }

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
      <AuthProvider>
        <ThemeProvider>
          <UserSync />
          <SearchHistorySync />
          <Stack screenOptions={{ headerShown: false }} />
        </ThemeProvider>
      </AuthProvider>
      {startingTrip && (
        <View style={styles.startingOverlay} pointerEvents="auto">
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.startingText}>Starting your trip…</Text>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

// Theme-agnostic: this overlay can render before ThemeProvider settles.
const styles = StyleSheet.create({
  startingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
  },
  startingText: { color: "#fff", fontWeight: "700" },
});
