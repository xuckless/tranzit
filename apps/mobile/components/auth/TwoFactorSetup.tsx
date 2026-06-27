/**
 * Two-factor authentication (TOTP) enrollment.
 *
 * Deferred to a later auth pass — see TODO.md → "Deferred auth". The previous
 * implementation was Clerk-specific; Supabase MFA (`supabase.auth.mfa.*`) will be
 * reimplemented here. Currently unmounted from Settings and renders nothing.
 */
export function TwoFactorSetup() {
  return null;
}
