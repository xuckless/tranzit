import { Redirect, Stack } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useAuthBypass } from "@/lib/devAuthBypass";

/**
 * Auth group: only reachable while signed-out. Once Supabase reports a session,
 * bounce into the app. The complementary guard in `(tabs)/_layout.tsx` keeps
 * signed-out users out of the app.
 */
export default function AuthLayout() {
  const { isLoaded, isSignedIn } = useAuth();
  const bypass = useAuthBypass();

  if (!isLoaded) return null;
  // Funnel through the index gate so there is a single redirect authority.
  if (isSignedIn || bypass) return <Redirect href="/" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}
