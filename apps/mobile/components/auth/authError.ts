/**
 * Extract a human-readable message from a Supabase `AuthError` (or any thrown
 * value). Supabase errors expose a flat `message`; OAuth redirect errors carry
 * `error_description`. Falls back to a generic string.
 */
export function authErrorMessage(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  const e = error as {
    message?: string;
    error_description?: string;
    code?: string;
  };
  // Supabase's raw "Token has expired or is invalid" reads oddly for a typo'd code.
  if (e.code === "otp_expired") {
    return "That code is incorrect or expired. Try again or resend a new one.";
  }
  return (
    e.error_description ||
    e.message ||
    "Something went wrong. Please try again."
  );
}
