import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "@/contexts/AuthContext";
import { syncUserInfo } from "@/lib/userSync";

/**
 * Mirrors the signed-in Supabase user into our user-database (`user_info`) so the
 * rest of the app (saved addresses, history, planner) can key off a stable
 * `user_id` (the Supabase UUID). Best-effort: the user DB may be unreachable
 * (503 / network) — failures are logged and never block the UI, but the sync is
 * retried (on app-foreground, token refresh, and cold start) until it succeeds,
 * so a confirmed user reliably lands in `user_info`.
 *
 * Session-gated by design: the row is created the first time the user has a real
 * session (email-confirmation deep link, or a sign-in after confirming), not at
 * signup. Renders nothing. Mounted once inside AuthProvider in the root layout.
 */
export function UserSync() {
  const { isLoaded, isSignedIn, user } = useAuth();
  // The identity snapshot we last *successfully* synced — failures leave this
  // unchanged so the next trigger retries.
  const lastSynced = useRef<string | null>(null);
  // Bumped on app-foreground to retry a previously failed sync within a session.
  const [foregroundTick, setForegroundTick] = useState(0);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") setForegroundTick((t) => t + 1);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user) return;

    // Re-sync when the user record changes (metadata edits bump updated_at);
    // skip once a snapshot has synced successfully.
    const fingerprint = `${user.id}:${user.updated_at ?? ""}`;
    if (lastSynced.current === fingerprint) return;

    let cancelled = false;
    (async () => {
      try {
        await syncUserInfo(user);
        if (!cancelled) lastSynced.current = fingerprint;
      } catch (err) {
        // Keep the app usable; surface loudly in dev so it isn't silent.
        if (__DEV__) console.error("[UserSync] user_info upsert failed", err);
        else console.warn("[UserSync] user_info upsert failed", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, user, foregroundTick]);

  return null;
}
