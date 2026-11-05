import { useState } from "react";
import { View, Text } from "react-native";
import { Link, router } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";
import { AuthScaffold } from "@/components/auth/AuthScaffold";
import { AuthField } from "@/components/auth/AuthField";
import { PasswordField } from "@/components/auth/PasswordField";
import { AuthButton } from "@/components/auth/AuthButton";
import { OtpStep } from "@/components/auth/OtpStep";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { authErrorMessage } from "@/components/auth/authError";
import { supabase } from "@/lib/supabase";

export default function SignUpScreen() {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    if (loading) return;
    setError("");
    setLoading(true);
    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });
      if (signUpError) {
        setError(authErrorMessage(signUpError));
        return;
      }
      // With confirmations off, Supabase returns a live session immediately.
      if (data.session) {
        router.replace("/");
        return;
      }
      // Confirmations on: a 6-digit code was emailed; verify it in-app.
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
      type: "signup",
    });
    if (verifyError) throw verifyError;
    // verifyOtp fires SIGNED_IN before resolving; the index gate forwards to tabs.
    router.replace("/");
  };

  const onResend = async () => {
    const { error: resendError } = await supabase.auth.resend({
      type: "signup",
      email: email.trim(),
    });
    if (resendError) throw resendError;
  };

  if (submitted) {
    return (
      <AuthScaffold
        title="Verify your email"
        subtitle={`We sent a 6-digit code to ${email.trim()}. Enter it to finish creating your account.`}
        onBack={() => {
          setSubmitted(false);
          setError("");
        }}
      >
        <OtpStep onVerify={onVerify} onResend={onResend} />
      </AuthScaffold>
    );
  }

  return (
    <AuthScaffold title="Create your account" subtitle="Get started with Tranzit">
      <AuthField
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
      />

      <PasswordField
        label="Password"
        value={password}
        onChangeText={setPassword}
        placeholder="At least 8 characters"
        textContentType="newPassword"
        showStrength
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <AuthButton label="Continue" onPress={onSubmit} loading={loading} />

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>

      <SocialButtons />

      <View style={styles.footer}>
        <Text style={styles.footerText}>Already have an account? </Text>
        <Link href="/(auth)/sign-in" style={styles.footerLink}>
          Sign in
        </Link>
      </View>
    </AuthScaffold>
  );
}
