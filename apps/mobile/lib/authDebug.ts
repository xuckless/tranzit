/**
 * TEMPORARY auth-flow diagnostics. Every line is tagged `[auth-debug]` so it is
 * easy to grep in the Metro logs and easy to rip out once the login failure is
 * understood. DEV-only.
 *
 * Why a helper: Clerk errors are `Error` instances whose useful data
 * (`errors[]`, `status`, `clerkError`) lives on non-enumerable props, so a bare
 * `JSON.stringify(err)` yields `{}`. We pull those fields out explicitly.
 */

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Plain breadcrumb / arbitrary payload. */
export function authDebug(label: string, data?: unknown): void {
  if (!__DEV__) return;
  if (data === undefined) {
    console.log(`[auth-debug] ${label}`);
  } else {
    console.log(`[auth-debug] ${label}`, safeStringify(data));
  }
}

/** Dump a Clerk SignIn/SignUp resource: status, factors, verifications, + extras. */
export function authDebugResult(
  label: string,
  result: any,
  extra?: Record<string, unknown>,
): void {
  if (!__DEV__) return;
  const summary = {
    status: result?.status,
    createdSessionId: result?.createdSessionId,
    supportedFirstFactors: result?.supportedFirstFactors,
    supportedSecondFactors: result?.supportedSecondFactors,
    firstFactorVerification: result?.firstFactorVerification,
    secondFactorVerification: result?.secondFactorVerification,
    ...extra,
  };
  console.log(`[auth-debug] ${label} » summary`, safeStringify(summary));
  console.log(`[auth-debug] ${label} » full`, safeStringify(result));
}

/** Dump a thrown/returned Clerk error with its non-enumerable fields exposed. */
export function authDebugError(label: string, err: any): void {
  if (!__DEV__) return;
  console.warn(
    `[auth-debug] ${label} ERROR`,
    safeStringify({
      message: err?.message,
      status: err?.status,
      code: err?.code,
      clerkError: err?.clerkError,
      errors: err?.errors,
    }),
  );
  console.warn(`[auth-debug] ${label} ERROR (raw)`, err);
}
