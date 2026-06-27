import type { User } from "@supabase/supabase-js";
import { middlewareUpsert } from "@/lib/middleware";

/** The `user_info` columns we mirror from the Supabase identity. */
export interface UserInfoRow {
  user_id: string;
  username: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  is_guest: boolean;
}

/** Build the `user_info` row from a Supabase user. */
export function userInfoRow(user: User): UserInfoRow {
  const meta = user.user_metadata ?? {};
  const email = user.email ?? null;
  const name = meta.full_name ?? meta.name ?? null;
  const avatar = meta.avatar_url ?? meta.picture ?? null;

  // username is UNIQUE NOT NULL in user_info. Prefer a provider-supplied handle;
  // otherwise the email-local part suffixed with a short id fragment so two
  // different emails that share a local part (john@a.com / john@b.com) don't
  // collide on the unique constraint. Last resort: the full user id.
  const handle = meta.user_name ?? meta.preferred_username ?? null;
  const local = email ? email.split("@")[0] : null;
  const username = handle
    ? String(handle)
    : local
      ? `${local}-${user.id.slice(0, 8)}`
      : user.id;

  return {
    user_id: user.id,
    username,
    email,
    name: name || null,
    avatar: avatar || null,
    // Supabase anonymous sign-in sets is_anonymous; mirror it so guest rows are
    // flagged in user_info (and can later be "upgraded" when they add an email).
    is_guest: user.is_anonymous ?? false,
  };
}

/**
 * Upsert the signed-in user's identity into the middleware `user_info` table
 * (`user_id` is the Supabase UUID). Throws on failure so callers can decide
 * whether to retry; logs the attempt/outcome in development so a failure is never
 * silent. The user DB is best-effort — callers should not block the UI on it.
 */
export async function syncUserInfo(user: User): Promise<void> {
  const row = userInfoRow(user);
  if (__DEV__) console.log("[userSync] upserting user_info", row.user_id);
  await middlewareUpsert("user_info", row);
  if (__DEV__) console.log("[userSync] user_info OK", row.user_id);
}
