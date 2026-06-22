import { Redirect, Stack } from "expo-router";
import { useAuth } from "@clerk/expo";

/**
 * Auth group: only reachable while signed-out. Once Clerk reports a session,
 * bounce into the app. The complementary guard in `(tabs)/_layout.tsx` keeps
 * signed-out users out of the app.
 */
export default function AuthLayout() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return null;
  if (isSignedIn) return <Redirect href="/(tabs)/map" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
