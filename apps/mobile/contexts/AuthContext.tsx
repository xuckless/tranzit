import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AppState } from "react-native";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { completeAuthFromUrl } from "@/lib/authLinking";

interface AuthContextValue {
  /** False until the cached session has been restored. */
  isLoaded: boolean;
  /** True when there is an active Supabase session. */
  isSignedIn: boolean;
  session: Session | null;
  user: User | null;
  /** True between a password-recovery deep link and the user setting a new password. */
  recoveryMode: boolean;
  clearRecoveryMode: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  isLoaded: false,
  isSignedIn: false,
  session: null,
  user: null,
  recoveryMode: false,
  clearRecoveryMode: () => {},
  signOut: async () => {},
});

/**
 * Single source of auth truth, replacing Clerk's provider/hooks. Restores the
 * cached Supabase session, tracks auth changes, keeps the token fresh only while
 * foregrounded, and completes email/recovery deep links. Exposes the same
 * `{ isLoaded, isSignedIn }` shape the route guards relied on under Clerk.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);

  // Hydrate the cached session, then subscribe to auth changes.
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      setIsLoaded(true);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      setIsLoaded(true);
      if (event === "PASSWORD_RECOVERY") setRecoveryMode(true);
      if (event === "SIGNED_OUT") setRecoveryMode(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // Auto-refresh only while foregrounded (Supabase React Native guidance).
  useEffect(() => {
    if (AppState.currentState === "active") supabase.auth.startAutoRefresh();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") supabase.auth.startAutoRefresh();
      else supabase.auth.stopAutoRefresh();
    });
    return () => {
      sub.remove();
      supabase.auth.stopAutoRefresh();
    };
  }, []);

  // Complete auth deep links (email confirmation / password recovery) opened from
  // the Mail app — cold start and warm. OAuth redirects are handled inline by
  // SocialButtons via openAuthSessionAsync.
  useEffect(() => {
    const handle = (url: string | null) => {
      if (!url) return;
      completeAuthFromUrl(url).catch((err) => {
        console.warn("[auth] deep-link completion failed", err);
      });
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", ({ url }) => handle(url));
    return () => sub.remove();
  }, []);

  // A recovery deep link establishes a session but must land on the
  // set-new-password screen rather than the app, wherever the user currently is.
  useEffect(() => {
    if (recoveryMode) router.replace("/reset-password");
  }, [recoveryMode]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isLoaded,
      isSignedIn: !!session,
      session,
      user: session?.user ?? null,
      recoveryMode,
      clearRecoveryMode: () => setRecoveryMode(false),
      signOut: async () => {
        await supabase.auth.signOut();
      },
    }),
    [isLoaded, session, recoveryMode],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
