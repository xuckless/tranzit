// Demo mode (EXPO_PUBLIC_DEMO_MODE=true, set by ./demo.sh app).
//
// The app runs against the local Docker Compose stack with no Supabase: sign-in
// is skipped, everyone is one fixed demo user, and every backend call carries the
// placeholder token "demo", which the services accept when started with
// DEMO_USER_ID (see demo/compose.yml). Nothing here is used outside demo mode.
import type { Session, User } from "@supabase/supabase-js";

export const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO_MODE === "true";

/** Must match DEMO_USER_ID in demo/compose.yml / demo.sh. */
export const DEMO_USER_ID =
  process.env.EXPO_PUBLIC_DEMO_USER_ID || "00000000-0000-4000-8000-000000000001";

export const DEMO_TOKEN = "demo";

const now = new Date().toISOString();

export const DEMO_USER = {
  id: DEMO_USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "demo@tranzit.local",
  is_anonymous: false,
  app_metadata: { provider: "demo" },
  user_metadata: { full_name: "Demo Rider" },
  created_at: now,
  updated_at: now,
} as unknown as User;

export const DEMO_SESSION = {
  access_token: DEMO_TOKEN,
  refresh_token: DEMO_TOKEN,
  token_type: "bearer",
  expires_in: 60 * 60 * 24 * 365,
  expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
  user: DEMO_USER,
} as unknown as Session;
