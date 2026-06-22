import { useEffect, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { Link, router } from "expo-router";
import { useSignUp } from "@clerk/expo/legacy";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";
import { AuthScaffold } from "@/components/auth/AuthScaffold";
import { AuthField } from "@/components/auth/AuthField";
import { PasswordField } from "@/components/auth/PasswordField";
import { OtpField } from "@/components/auth/OtpField";
import { AuthButton } from "@/components/auth/AuthButton";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { authErrorMessage } from "@/components/auth/authError";
import { authDebug, authDebugResult, authDebugError } from "@/lib/authDebug";

const RESEND_COOLDOWN = 30; // seconds

export default function SignUpScreen() {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);
  const { isLoaded, signUp, setActive } = useSignUp();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  // Resend cooldown ticker.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setInterval(() => setResendIn((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [resendIn]);

  const onSubmit = async () => {
    authDebug("signUp onSubmit()", {
      isLoaded,
      loading,
      hasSignUp: !!signUp,
      hasSetActive: !!setActive,
      email: email.trim(),
      passwordLength: password.length,
    });
    if (!isLoaded || loading) return;
    setError("");
    setLoading(true);
    try {
      const created = await signUp.create({
        emailAddress: email.trim(),
        password,
      });
      authDebugResult("signUp.create() result", created);
      const prepared = await signUp.prepareEmailAddressVerification({
        strategy: "email_code",
      });
      authDebugResult("prepareEmailAddressVerification() result", prepared);
      setPendingVerification(true);
      setResendIn(RESEND_COOLDOWN);
    } catch (err) {
      authDebugError("signUp onSubmit / create|prepare", err);
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const onVerify = async () => {
    authDebug("signUp onVerify()", { hasSetActive: !!setActive });
    if (!isLoaded || loading) return;
    setError("");
    setLoading(true);
    try {
      const result = await signUp.attemptEmailAddressVerification({
        code: code.trim(),
      });
      authDebugResult("attemptEmailAddressVerification() result", result, {
        hasSetActive: !!setActive,
      });
      if (result.status === "complete" && result.createdSessionId && setActive) {
        await setActive({ session: result.createdSessionId });
        router.replace("/");
      } else {
        authDebug("signUp onVerify → not complete/activatable", {
          status: result.status,
          hasCreatedSessionId: !!result.createdSessionId,
          hasSetActive: !!setActive,
        });
        setError("That code didn't complete sign up. Please try again.");
      }
    } catch (err) {
      authDebugError("signUp onVerify / attemptEmailAddressVerification", err);
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const onResend = async () => {
    authDebug("signUp onResend()");
    if (!isLoaded || resendIn > 0) return;
    setError("");
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setResendIn(RESEND_COOLDOWN);
    } catch (err) {
      authDebugError("signUp onResend / prepareEmailAddressVerification", err);
      setError(authErrorMessage(err));
    }
  };

  if (pendingVerification) {
    return (
      <AuthScaffold
        title="Check your email"
        subtitle={`Enter the code we sent to ${email.trim()}`}
        onBack={() => {
          setPendingVerification(false);
          setError("");
          setCode("");
        }}
      >
        <OtpField value={code} onChangeText={setCode} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <AuthButton label="Verify" onPress={onVerify} loading={loading} />
        <TouchableOpacity
          style={styles.linkBtn}
          onPress={onResend}
          disabled={resendIn > 0}
        >
          <Text style={resendIn > 0 ? styles.linkTextMuted : styles.linkText}>
            {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
          </Text>
        </TouchableOpacity>
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
