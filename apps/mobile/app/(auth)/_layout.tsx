import { Redirect, Stack } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Auth group: only reachable while signed-out. Once Supabase reports a session,
 * bounce into the app. The complementary guard in `(tabs)/_layout.tsx` keeps
 * signed-out users out of the app.
 */
export default function AuthLayout() {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded) return null;
  // Funnel through the index gate so there is a single redirect authority.
  if (isSignedIn) return <Redirect href="/" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
