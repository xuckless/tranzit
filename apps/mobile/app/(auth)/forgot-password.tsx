import { useState } from "react";
import { View, Text } from "react-native";
import { router } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";
import { AuthScaffold } from "@/components/auth/AuthScaffold";
import { AuthField } from "@/components/auth/AuthField";
import { AuthButton } from "@/components/auth/AuthButton";
import { OtpStep } from "@/components/auth/OtpStep";
import { authErrorMessage } from "@/components/auth/authError";
import { supabase } from "@/lib/supabase";

/**
 * Password reset via emailed one-time code: `resetPasswordForEmail` sends a
 * 6-digit token (the dashboard Recovery template uses {{ .Token }}), `verifyOtp`
 * exchanges it for a recovery session, and `reset-password.tsx` sets the new
 * password. Fully in-app — no links, works across devices.
 */
export default function ForgotPasswordScreen() {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);

  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const onRequest = async () => {
    if (loading) return;
    setError("");
    setLoading(true);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        email.trim(),
      );
      if (resetError) {
        setError(authErrorMessage(resetError));
        return;
      }
      setSubmitted(true);
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const onVerify = async (token: string) => {
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token,
      type: "recovery",
    });
    if (verifyError) throw verifyError;
    // verifyOtp fires PASSWORD_RECOVERY (sets recoveryMode) before resolving;
    // replace explicitly so landing on the set-password screen doesn't depend
    // on gate render order.
    router.replace("/reset-password");
  };

  const onResend = async () => {
    const { error: resendError } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
    );
    if (resendError) throw resendError;
  };

  if (submitted) {
    return (
      <AuthScaffold
        title="Enter your code"
        subtitle={`If an account exists for ${email.trim()}, we sent a 6-digit code. Enter it below to reset your password.`}
        onBack={() => setSubmitted(false)}
      >
        <OtpStep onVerify={onVerify} onResend={onResend} />
      </AuthScaffold>
    );
  }

  return (
    <AuthScaffold
      title="Forgot password?"
      subtitle="Enter your email and we'll send you a 6-digit reset code."
      onBack={() => router.back()}
    >
      <AuthField
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
        autoFocus
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <AuthButton label="Send reset code" onPress={onRequest} loading={loading} />

      <View style={styles.footer}>
        <Text style={styles.footerText}>Remembered it? </Text>
        <Text
          style={styles.footerLink}
          onPress={() => router.replace("/(auth)/sign-in")}
        >
          Back to sign in
        </Text>
      </View>
    </AuthScaffold>
  );
}
