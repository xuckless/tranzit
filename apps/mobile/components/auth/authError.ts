/**
 * Extract a human-readable message from a Clerk error (returned object or thrown).
 * Clerk API errors carry an `errors[]` array with `longMessage`/`message`.
 */
export function authErrorMessage(error: unknown): string {
  if (!error) return "";
  const e = error as {
    errors?: { code?: string; longMessage?: string; message?: string }[];
    message?: string;
  };
  const msg =
    e.errors?.[0]?.longMessage ??
    e.errors?.[0]?.message ??
    e.message ??
    "Something went wrong. Please try again.";
  // TEMPORARY [auth-debug]: see what raw error collapses to a user string.
  if (__DEV__) {
    console.warn("[auth-debug] authErrorMessage()", {
      collapsedTo: msg,
      errorsCount: e.errors?.length,
      firstCode: e.errors?.[0]?.code,
    });
  }
  return msg;
}
