import { Redirect } from "expo-router";
import { useAuth } from "@clerk/expo";
import { useAuthBypass } from "@/lib/devAuthBypass";

export default function Index() {
  const { isLoaded, isSignedIn } = useAuth();
  const bypass = useAuthBypass();

  // Wait for Clerk to restore the cached session before deciding where to go.
  if (!isLoaded) return null;

  return (
    <Redirect
      href={isSignedIn || bypass ? "/(tabs)/map" : "/(auth)/sign-in"}
    />
  );
}
