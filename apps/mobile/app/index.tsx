import { Redirect } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";
import { useAuthBypass } from "@/lib/devAuthBypass";

export default function Index() {
  const { isLoaded, isSignedIn, recoveryMode } = useAuth();
  const bypass = useAuthBypass();

  // Wait for Supabase to restore the cached session before deciding where to go.
  if (!isLoaded) return null;

  // A password-recovery deep link establishes a session, but the user must set a
  // new password before entering the app.
  if (recoveryMode) return <Redirect href="/reset-password" />;

  return (
    <Redirect href={isSignedIn || bypass ? "/(tabs)/map" : "/(auth)/sign-in"} />
  );
}
