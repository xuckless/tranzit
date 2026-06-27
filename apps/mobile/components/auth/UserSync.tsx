import { useEffect, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { middlewareUpsert } from "@/lib/middleware";

/**
 * Mirrors the signed-in Supabase user into our user-database (`user_info`) so the
 * rest of the app (saved addresses, history, planner) can key off a stable
 * `user_id` (the Supabase UUID). Best-effort: the user DB may be unreachable
 * (503) — failures are logged and never block the UI. The session itself lives in
 * expo-secure-store via the Supabase client's storage adapter, not here.
 *
 * Renders nothing. Mounted once inside AuthProvider in the root layout.
 */
export function UserSync() {
  const { isLoaded, isSignedIn, user } = useAuth();
  // Avoid re-posting the same identity snapshot on every render.
  const lastSynced = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !user) return;

    const meta = user.user_metadata ?? {};
    const email = user.email ?? null;
    const name = meta.full_name ?? meta.name ?? null;
    const avatar = meta.avatar_url ?? meta.picture ?? null;
    // username is UNIQUE NOT NULL in user_info — always provide something stable.
    const username =
      meta.user_name ??
      meta.preferred_username ??
      email?.split("@")[0] ??
      user.id;

    const row = {
      user_id: user.id,
      username,
      email,
      name: name || null,
      avatar: avatar || null,
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
  }, [isLoaded, isSignedIn, user]);

  return null;
}
