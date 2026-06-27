/**
 * Linking additional external OAuth accounts (and the Google Calendar grant).
 *
 * Deferred to a later auth pass — see TODO.md → "Deferred auth". The previous
 * implementation was Clerk-specific; with Supabase this becomes identity linking
 * via `supabase.auth.linkIdentity`. Currently unmounted from Settings and renders
 * nothing.
 */
export function ConnectedAccounts() {
  return null;
}
