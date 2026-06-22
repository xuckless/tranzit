import { useEffect, useRef } from "react";
import { useAuth, useUser } from "@clerk/expo";
import { middlewareUpsert } from "@/lib/middleware";

/**
 * Mirrors the signed-in Clerk user into our user-database (`user_info`) so the
 * rest of the app (saved addresses, history, planner) can key off a stable
 * `user_id`. Best-effort: the user DB may be unreachable (503) — failures are
 * logged and never block the UI. The Clerk session token is NOT persisted here;
 * it lives only in expo-secure-store via Clerk's tokenCache.
 *
 * Renders nothing. Mounted once inside ClerkProvider in the root layout.
 */
export function UserSync() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  // Avoid re-posting the same identity snapshot on every render.
  const lastSynced = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user) return;

    const email = user.primaryEmailAddress?.emailAddress ?? null;
    const name =
      user.fullName ??
      [user.firstName, user.lastName].filter(Boolean).join(" ") ??
      null;
    // username is UNIQUE NOT NULL in user_info — always provide something stable.
    const username = user.username ?? email?.split("@")[0] ?? user.id;

    const row = {
      user_id: user.id,
      username,
      email,
      name: name || null,
      avatar: user.imageUrl ?? null,
      is_guest: false,
    };

    const fingerprint = JSON.stringify(row);
    if (lastSynced.current === fingerprint) return;

    let cancelled = false;
    (async () => {
      try {
        await middlewareUpsert("user_info", row);
        if (!cancelled) lastSynced.current = fingerprint;
      } catch (err) {
        // 503 (user DB down) or network error — keep the app usable.
        console.warn("[UserSync] user_info upsert failed", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, user?.id, user?.updatedAt]);

  return null;
}
