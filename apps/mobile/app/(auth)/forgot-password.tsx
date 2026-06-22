import { useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { router } from "expo-router";
import { useSignIn } from "@clerk/expo/legacy";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";
import { AuthScaffold } from "@/components/auth/AuthScaffold";
import { AuthField } from "@/components/auth/AuthField";
import { PasswordField } from "@/components/auth/PasswordField";
import { OtpField } from "@/components/auth/OtpField";
import { AuthButton } from "@/components/auth/AuthButton";
import { authErrorMessage } from "@/components/auth/authError";
import { authDebug, authDebugResult, authDebugError } from "@/lib/authDebug";

type Step = "request" | "reset";

/**
 * Password reset via emailed code (classic Clerk flow):
 *   create({ strategy: reset_password_email_code }) → attemptFirstFactor(code)
 *   → resetPassword(newPassword) → setActive → "/".
 */
export default function ForgotPasswordScreen() {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);
  const { isLoaded, signIn, setActive } = useSignIn();

  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const sendCode = async () => {
    authDebug("forgot sendCode()", { isLoaded, email: email.trim() });
    if (!isLoaded) return;
    const result = await signIn.create({
      strategy: "reset_password_email_code",
      identifier: email.trim(),
    });
    authDebugResult("forgot signIn.create(reset_password_email_code) result", result);
  };

  const onRequest = async () => {
    authDebug("forgot onRequest()");
    if (!isLoaded || loading) return;
    setError("");
    setLoading(true);
    try {
      await sendCode();
      setStep("reset");
    } catch (err) {
      authDebugError("forgot onRequest / sendCode", err);
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const onResend = async () => {
    authDebug("forgot onResend()");
    if (!isLoaded) return;
    setError("");
    try {
      await sendCode();
    } catch (err) {
      authDebugError("forgot onResend / sendCode", err);
      setError(authErrorMessage(err));
    }
  };

  const onReset = async () => {
    authDebug("forgot onReset()", { hasSetActive: !!setActive });
    if (!isLoaded || loading) return;
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const attempt = await signIn.attemptFirstFactor({
        strategy: "reset_password_email_code",
        code: code.trim(),
      });
      authDebugResult("forgot attemptFirstFactor() result", attempt);
      if (attempt.status !== "needs_new_password" && attempt.status !== "complete") {
        setError("That code is incorrect or expired. Please try again.");
        return;
      }
      const result = await signIn.resetPassword({ password: newPassword });
      authDebugResult("forgot resetPassword() result", result, {
        hasSetActive: !!setActive,
      });
      if (result.status === "complete" && result.createdSessionId && setActive) {
        await setActive({ session: result.createdSessionId });
        router.replace("/");
      } else {
        authDebug("forgot onReset → not complete/activatable", {
          status: result.status,
          hasCreatedSessionId: !!result.createdSessionId,
          hasSetActive: !!setActive,
        });
        setError("Couldn't reset your password. Please try again.");
      }
    } catch (err) {
      authDebugError("forgot onReset / attemptFirstFactor|resetPassword", err);
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  if (step === "reset") {
    return (
      <AuthScaffold
        title="Reset password"
        subtitle={`Enter the code we sent to ${email.trim()} and choose a new password.`}
        onBack={() => {
          setStep("request");
          setError("");
          setCode("");
        }}
      >
        <OtpField value={code} onChangeText={setCode} />
        <PasswordField
          label="New password"
          value={newPassword}
          onChangeText={setNewPassword}
          placeholder="At least 8 characters"
          textContentType="newPassword"
          showStrength
        />
        <PasswordField
          label="Confirm new password"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="Re-enter password"
          textContentType="newPassword"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <AuthButton label="Reset password" onPress={onReset} loading={loading} />
        <TouchableOpacity style={styles.linkBtn} onPress={onResend}>
          <Text style={styles.linkText}>Resend code</Text>
        </TouchableOpacity>
      </AuthScaffold>
    );
  }

  return (
    <AuthScaffold
      title="Forgot password?"
      subtitle="Enter your email and we'll send you a reset code."
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
