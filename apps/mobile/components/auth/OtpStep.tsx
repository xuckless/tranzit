import { useEffect, useState } from "react";
import { Text, TouchableOpacity } from "react-native";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";
import { OtpField } from "@/components/auth/OtpField";
import { AuthButton } from "@/components/auth/AuthButton";
import { authErrorMessage } from "@/components/auth/authError";

// Supabase enforces 60s between auth emails per address.
const RESEND_COOLDOWN_S = 60;

/**
 * Code-entry step shared by forgot-password and sign-up verification: OTP
 * input, verify button, and a resend link with a cooldown countdown. Callers
 * own navigation on success and throw Supabase errors from both callbacks.
 */
export function OtpStep({
  onVerify,
  onResend,
  verifyLabel = "Verify",
}: {
  onVerify: (token: string) => Promise<void>;
  onResend: () => Promise<void>;
  verifyLabel?: string;
}) {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);

  const [token, setToken] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState("");
  // Starts hot: an email was just sent before this step mounted.
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const onVerifyPress = async () => {
    if (verifying) return;
    setError("");
    setVerifying(true);
    try {
      await onVerify(token.trim());
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setVerifying(false);
    }
  };

  const onResendPress = async () => {
    if (cooldown > 0 || resending) return;
    setError("");
    setResending(true);
    try {
      await onResend();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      // Restart even on error — a 429 means the server window is active anyway.
      setCooldown(RESEND_COOLDOWN_S);
      setResending(false);
    }
  };

  return (
    <>
      <OtpField value={token} onChangeText={setToken} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <AuthButton
        label={verifyLabel}
        onPress={onVerifyPress}
        loading={verifying}
        disabled={token.trim().length < 6}
      />
      <TouchableOpacity
        style={styles.linkBtn}
        onPress={onResendPress}
        disabled={cooldown > 0 || resending}
      >
        {cooldown > 0 ? (
          <Text style={styles.linkTextMuted}>Resend code in {cooldown}s</Text>
        ) : (
          <Text style={styles.linkText}>
            {resending ? "Sending…" : "Resend code"}
          </Text>
        )}
      </TouchableOpacity>
    </>
  );
}
