/**
 * Extract a human-readable message from a Clerk error (returned object or thrown).
 * Clerk API errors carry an `errors[]` array with `longMessage`/`message`.
 */
export function authErrorMessage(error: unknown): string {
  if (!error) return "";
  const e = error as {
    errors?: { longMessage?: string; message?: string }[];
    message?: string;
  };
  return (
    e.errors?.[0]?.longMessage ??
    e.errors?.[0]?.message ??
    e.message ??
    "Something went wrong. Please try again."
  );
}
