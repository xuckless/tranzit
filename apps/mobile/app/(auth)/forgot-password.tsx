import { useState } from "react";
import { View, Text } from "react-native";
import { router } from "expo-router";
import { makeRedirectUri } from "expo-auth-session";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";
import { AuthScaffold } from "@/components/auth/AuthScaffold";
import { AuthField } from "@/components/auth/AuthField";
import { AuthButton } from "@/components/auth/AuthButton";
import { authErrorMessage } from "@/components/auth/authError";
import { supabase } from "@/lib/supabase";

/**
 * Password reset via Supabase email link: `resetPasswordForEmail` sends a link
 * that deep-links back into the app; the recovery session routes to
 * `reset-password.tsx`, where the user sets a new password.
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
        { redirectTo: makeRedirectUri() },
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

  if (submitted) {
    return (
      <AuthScaffold
        title="Check your email"
        subtitle={`If an account exists for ${email.trim()}, we sent a password-reset link. Tap it to choose a new password.`}
        onBack={() => router.replace("/(auth)/sign-in")}
      >
        <AuthButton
          label="Back to sign in"
          onPress={() => router.replace("/(auth)/sign-in")}
        />
      </AuthScaffold>
    );
  }

  return (
    <AuthScaffold
      title="Forgot password?"
      subtitle="Enter your email and we'll send you a reset link."
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
      <AuthButton label="Send reset link" onPress={onRequest} loading={loading} />

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
