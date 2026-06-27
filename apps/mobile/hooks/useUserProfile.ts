import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { middlewareUserQuery } from "@/lib/middleware";
import { syncUserInfo } from "@/lib/userSync";

/** The user_info row, the single source of truth for profile display. */
export interface UserProfile {
  user_id: string;
  username: string | null;
  email: string | null;
  name: string | null;
  date_of_birth: string | null;
  avatar: string | null;
  is_guest: boolean;
  subscription_status: string | null;
  country: string | null;
  city: string | null;
}

/**
 * Loads the signed-in user's profile from the user DB (`user_info`). The session
 * is used only to get `user.id`; all displayed values come from `user_info`.
 * Seeds the row from the Supabase identity first (idempotent) so a fresh sign-in
 * doesn't show an empty profile while UserSync is still in flight.
 */
export function useUserProfile() {
  const { user } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!user) {
      setProfile(null);
      setLoading(false);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      // Best-effort seed; ignore failures (offline / 503) and try to read anyway.
      await syncUserInfo(user).catch(() => {});
      const rows = await middlewareUserQuery<UserProfile>("user_info", {
        user_id: user.id,
        limit: 1,
      });
      if (mounted.current) setProfile(rows[0] ?? null);
    } catch {
      if (mounted.current) setError("Couldn't load your profile.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  return { profile, loading, error, refresh: load };
}
