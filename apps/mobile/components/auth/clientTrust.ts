/**
 * Device ("client") trust helpers.
 *
 * When `auth_password.device_trust` is enabled on the Clerk instance, signing in
 * from a new/untrusted device returns `status: "needs_client_trust"` *after* the
 * password is verified. Clerk resolves it like a second factor: send an email
 * code (`prepareSecondFactor`) then verify it (`attemptSecondFactor`), which
 * trusts the device and completes the sign-in.
 *
 * Loosely typed on purpose — the auth screens derive their Clerk types from the
 * hook, so these helpers accept just the fields they read.
 */

type SecondFactor = {
  strategy?: string;
  emailAddressId?: string;
  safeIdentifier?: string;
};

export type ClientTrustEmailFactor = {
  emailAddressId: string;
  safeIdentifier: string | null;
};

/** True when a sign-in attempt is paused waiting for this device to be verified. */
export function needsClientTrust(status: string | null | undefined): boolean {
  return status === "needs_client_trust";
}

/**
 * The email-code factor Clerk expects us to verify to trust this device, or
 * `null` if none is offered.
 */
export function clientTrustEmailFactor(
  supportedSecondFactors: SecondFactor[] | null | undefined,
): ClientTrustEmailFactor | null {
  const factor = supportedSecondFactors?.find(
    (f) => f.strategy === "email_code",
  );
  if (!factor?.emailAddressId) return null;
  return {
    emailAddressId: factor.emailAddressId,
    safeIdentifier: factor.safeIdentifier ?? null,
  };
}
