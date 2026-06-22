import { useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { Link, router } from "expo-router";
import { useSignIn } from "@clerk/expo/legacy";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";
import { AuthScaffold } from "@/components/auth/AuthScaffold";
import { AuthField } from "@/components/auth/AuthField";
import { PasswordField } from "@/components/auth/PasswordField";
import { OtpField } from "@/components/auth/OtpField";
import { AuthButton } from "@/components/auth/AuthButton";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { authErrorMessage } from "@/components/auth/authError";
import { setAuthBypass } from "@/lib/devAuthBypass";
import { authDebug, authDebugResult, authDebugError } from "@/lib/authDebug";
import { clientTrustEmailFactor } from "@/components/auth/clientTrust";

// Derive the resource type from the hook so we don't depend on @clerk/types.
type SignInResource = NonNullable<ReturnType<typeof useSignIn>["signIn"]>;

type Step = "signIn" | "twoFactor" | "verifyEmail" | "newPassword" | "clientTrust";
type SecondFactorStrategy = "totp" | "phone_code" | "backup_code";

const SECOND_FACTOR_LABEL: Record<SecondFactorStrategy, string> = {
  totp: "Authenticator app",
  phone_code: "Text message (SMS)",
  backup_code: "Backup code",
};

export default function SignInScreen() {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);
  const { isLoaded, signIn, setActive } = useSignIn();

  const [step, setStep] = useState<Step>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Second-factor state (populated when sign-in reports needs_second_factor).
  const [sfStrategies, setSfStrategies] = useState<SecondFactorStrategy[]>([]);
  const [sfStrategy, setSfStrategy] = useState<SecondFactorStrategy>("totp");
  const [sfPhoneId, setSfPhoneId] = useState<string | null>(null);
  const [sfPhoneLabel, setSfPhoneLabel] = useState<string | null>(null);

  // Device-trust challenge state (populated when sign-in reports needs_client_trust).
  const [ctEmailId, setCtEmailId] = useState<string | null>(null);
  const [ctLabel, setCtLabel] = useState<string | null>(null);

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  /** Activate the session and leave the auth stack via the index gate. */
  const finish = async (result: SignInResource): Promise<boolean> => {
    authDebugResult("finish() called", result, {
      isLoaded,
      hasSignIn: !!signIn,
      hasSetActive: !!setActive,
    });
    if (result.status === "complete" && result.createdSessionId && setActive) {
      authDebug("finish() → activating session", result.createdSessionId);
      await setActive({ session: result.createdSessionId });
      authDebug("finish() → setActive resolved, replacing route to /");
      router.replace("/");
      return true;
    }
    authDebug("finish() → NOT complete/activatable, returning false", {
      status: result.status,
      hasCreatedSessionId: !!result.createdSessionId,
      hasSetActive: !!setActive,
    });
    return false;
  };

  // ── Step 1: identifier + password ──────────────────────────────────────────
  const onSignIn = async () => {
    authDebug("onSignIn() invoked", {
      isLoaded,
      loading,
      hasSignIn: !!signIn,
      hasSetActive: !!setActive,
      email: email.trim(),
      passwordLength: password.length,
    });
    if (!isLoaded || loading) return;
    setError("");
    setLoading(true);
    try {
      const result = await signIn.create({
        identifier: email.trim(),
        password,
      });
      authDebugResult("signIn.create() result", result);
      if (await finish(result)) return;

      switch (result.status) {
        case "needs_second_factor": {
          authDebug("onSignIn switch → needs_second_factor");
          const factors = (result.supportedSecondFactors ?? [])
            .map((f) => f.strategy)
            .filter((s): s is SecondFactorStrategy =>
              s === "totp" || s === "phone_code" || s === "backup_code",
            );
          const phone = result.supportedSecondFactors?.find(
            (f) => f.strategy === "phone_code",
          ) as { phoneNumberId?: string; safeIdentifier?: string } | undefined;
          setSfStrategies(factors);
          setSfPhoneId(phone?.phoneNumberId ?? null);
          setSfPhoneLabel(phone?.safeIdentifier ?? null);
          const initial = factors.includes("totp")
            ? "totp"
            : (factors[0] ?? "totp");
          await selectSecondFactor(initial, phone?.phoneNumberId ?? null);
          setStep("twoFactor");
          break;
        }
        case "needs_new_password":
          // Forced reset (e.g. breached password — enforce_hibp_on_sign_in).
          authDebug("onSignIn switch → needs_new_password");
          setStep("newPassword");
          break;
        case "needs_client_trust": {
          // Password verified, but device trust is on — verify this new device
          // with an email code before the session is created.
          authDebug(
            "onSignIn switch → needs_client_trust",
            result.supportedSecondFactors,
          );
          const factor = clientTrustEmailFactor(result.supportedSecondFactors);
          if (factor) {
            setCtEmailId(factor.emailAddressId);
            setCtLabel(factor.safeIdentifier);
            await signIn.prepareSecondFactor({
              strategy: "email_code",
              emailAddressId: factor.emailAddressId,
            });
            setCode("");
            setStep("clientTrust");
          } else {
            setError("This device needs verification, but no email code is available.");
          }
          break;
        }
        case "needs_first_factor": {
          authDebug(
            "onSignIn switch → needs_first_factor",
            result.supportedFirstFactors,
          );
          const emailFactor = result.supportedFirstFactors?.find(
            (f) => f.strategy === "email_code",
          ) as { emailAddressId?: string } | undefined;
          if (emailFactor?.emailAddressId) {
            await signIn.prepareFirstFactor({
              strategy: "email_code",
              emailAddressId: emailFactor.emailAddressId,
            });
            setCode("");
            setStep("verifyEmail");
          } else {
            authDebug(
              "onSignIn → needs_first_factor but NO email_code factor",
              result.supportedFirstFactors,
            );
            setError("This account needs additional verification to sign in.");
          }
          break;
        }
        default:
          authDebug(
            "onSignIn switch → DEFAULT (unhandled status) ← this is the on-screen error",
            { status: result.status },
          );
          setError("Additional verification is required to sign in.");
      }
    } catch (err) {
      authDebugError("onSignIn / signIn.create", err);
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2a: two-factor challenge ───────────────────────────────────────────
  /** Switch 2FA method; (re)send the SMS code when phone is chosen. */
  const selectSecondFactor = async (
    strategy: SecondFactorStrategy,
    phoneId: string | null,
  ) => {
    authDebug("selectSecondFactor()", { strategy, phoneId });
    setSfStrategy(strategy);
    setCode("");
    if (strategy === "phone_code" && phoneId && isLoaded) {
      try {
        await signIn.prepareSecondFactor({
          strategy: "phone_code",
          phoneNumberId: phoneId,
        });
      } catch (err) {
        authDebugError("selectSecondFactor / prepareSecondFactor", err);
        setError(authErrorMessage(err));
      }
    }
  };

  const onVerifyTwoFactor = async () => {
    authDebug("onVerifyTwoFactor()", { sfStrategy });
    if (!isLoaded || loading) return;
    setError("");
    setLoading(true);
    try {
      const result = await signIn.attemptSecondFactor({
        strategy: sfStrategy,
        code: code.trim(),
      });
      authDebugResult("attemptSecondFactor() result", result);
      if (!(await finish(result))) {
        setError("That code didn't complete sign in. Please try again.");
      }
    } catch (err) {
      authDebugError("onVerifyTwoFactor / attemptSecondFactor", err);
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  // ── Device trust: verify this new device with an email code ─────────────────
  const onVerifyClientTrust = async () => {
    authDebug("onVerifyClientTrust()");
    if (!isLoaded || loading) return;
    setError("");
    setLoading(true);
    try {
      const result = await signIn.attemptSecondFactor({
        strategy: "email_code",
        code: code.trim(),
      });
      authDebugResult("attemptSecondFactor(client trust) result", result);
      if (!(await finish(result))) {
        setError("That code didn't verify this device. Please try again.");
      }
    } catch (err) {
      authDebugError("onVerifyClientTrust / attemptSecondFactor", err);
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const onResendClientTrust = async () => {
    authDebug("onResendClientTrust()", { ctEmailId });
    if (!isLoaded || !ctEmailId) return;
    setError("");
    try {
      await signIn.prepareSecondFactor({
        strategy: "email_code",
        emailAddressId: ctEmailId,
      });
    } catch (err) {
      authDebugError("onResendClientTrust / prepareSecondFactor", err);
      setError(authErrorMessage(err));
    }
  };

  // ── Step 2b: verify email (first factor) ────────────────────────────────────
  const onVerifyEmail = async () => {
    authDebug("onVerifyEmail()");
    if (!isLoaded || loading) return;
    setError("");
    setLoading(true);
    try {
      const result = await signIn.attemptFirstFactor({
        strategy: "email_code",
        code: code.trim(),
      });
      authDebugResult("attemptFirstFactor(email_code) result", result);
      if (!(await finish(result))) {
        if (result.status === "needs_new_password") {
          setStep("newPassword");
        } else {
          setError("That code didn't complete sign in. Please try again.");
        }
      }
    } catch (err) {
      authDebugError("onVerifyEmail / attemptFirstFactor", err);
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const onResendEmail = async () => {
    authDebug("onResendEmail()");
    if (!isLoaded) return;
    const emailFactor = signIn.supportedFirstFactors?.find(
      (f) => f.strategy === "email_code",
    ) as { emailAddressId?: string } | undefined;
    if (!emailFactor?.emailAddressId) return;
    try {
      await signIn.prepareFirstFactor({
        strategy: "email_code",
        emailAddressId: emailFactor.emailAddressId,
      });
    } catch (err) {
      authDebugError("onResendEmail / prepareFirstFactor", err);
      setError(authErrorMessage(err));
    }
  };

  // ── Step 2c: set a new password (forced reset) ──────────────────────────────
  const onSetNewPassword = async () => {
    authDebug("onSetNewPassword()");
    if (!isLoaded || loading) return;
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const result = await signIn.resetPassword({ password: newPassword });
      authDebugResult("resetPassword() result", result);
      if (!(await finish(result))) {
        setError("Couldn't set your new password. Please try again.");
      }
    } catch (err) {
      authDebugError("onSetNewPassword / resetPassword", err);
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const backToSignIn = () => {
    setStep("signIn");
    setError("");
    setCode("");
    setPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setCtEmailId(null);
    setCtLabel(null);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  if (step === "twoFactor") {
    return (
      <AuthScaffold
        title="Two-step verification"
        subtitle={
          sfStrategy === "phone_code"
            ? `Enter the code sent to ${sfPhoneLabel ?? "your phone"}`
            : sfStrategy === "backup_code"
              ? "Enter one of your backup codes"
              : "Enter the code from your authenticator app"
        }
        onBack={backToSignIn}
      >
        <OtpField value={code} onChangeText={setCode} label="Code" />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <AuthButton label="Verify" onPress={onVerifyTwoFactor} loading={loading} />

        {sfStrategies.filter((s) => s !== sfStrategy).length > 0 ? (
          <View style={{ marginTop: 16 }}>
            {sfStrategies
              .filter((s) => s !== sfStrategy)
              .map((s) => (
                <TouchableOpacity
                  key={s}
                  style={styles.linkBtn}
                  onPress={() => selectSecondFactor(s, sfPhoneId)}
                >
                  <Text style={styles.linkText}>
                    Use {SECOND_FACTOR_LABEL[s].toLowerCase()} instead
                  </Text>
                </TouchableOpacity>
              ))}
          </View>
        ) : null}
      </AuthScaffold>
    );
  }

  if (step === "verifyEmail") {
    return (
      <AuthScaffold
        title="Verify your email"
        subtitle={`Enter the code we sent to ${email.trim()}`}
        onBack={backToSignIn}
      >
        <OtpField value={code} onChangeText={setCode} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <AuthButton label="Verify" onPress={onVerifyEmail} loading={loading} />
        <TouchableOpacity style={styles.linkBtn} onPress={onResendEmail}>
          <Text style={styles.linkText}>Resend code</Text>
        </TouchableOpacity>
      </AuthScaffold>
    );
  }

  if (step === "clientTrust") {
    return (
      <AuthScaffold
        title="Verify this device"
        subtitle={`For your security, enter the code we sent to ${ctLabel ?? email.trim()}`}
        onBack={backToSignIn}
      >
        <OtpField value={code} onChangeText={setCode} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <AuthButton label="Verify" onPress={onVerifyClientTrust} loading={loading} />
        <TouchableOpacity style={styles.linkBtn} onPress={onResendClientTrust}>
          <Text style={styles.linkText}>Resend code</Text>
        </TouchableOpacity>
      </AuthScaffold>
    );
  }

  if (step === "newPassword") {
    return (
      <AuthScaffold
        title="Set a new password"
        subtitle="Your current password needs to be updated to continue."
        onBack={backToSignIn}
      >
        <PasswordField
          label="New password"
          value={newPassword}
          onChangeText={setNewPassword}
          placeholder="At least 8 characters"
          textContentType="newPassword"
          showStrength
          autoFocus
        />
        <PasswordField
          label="Confirm new password"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholder="Re-enter password"
          textContentType="newPassword"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <AuthButton
          label="Update password"
          onPress={onSetNewPassword}
          loading={loading}
        />
      </AuthScaffold>
    );
  }

  // step === "signIn"
  return (
    <AuthScaffold title="Welcome back" subtitle="Sign in to continue to Tranzit">
      {__DEV__ ? (
        <TouchableOpacity
          style={[styles.primaryBtn, { backgroundColor: theme.colors.danger }]}
          onPress={() => {
            setAuthBypass(true);
            router.replace("/(tabs)/map");
          }}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryBtnText}>Skip login (debug)</Text>
        </TouchableOpacity>
      ) : null}

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
        placeholder="••••••••"
      />

      <TouchableOpacity
        style={styles.linkBtnEnd}
        onPress={() => router.push("/(auth)/forgot-password")}
      >
        <Text style={styles.linkText}>Forgot password?</Text>
      </TouchableOpacity>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <AuthButton label="Sign in" onPress={onSignIn} loading={loading} />

      <View style={styles.divider}>
        <View style={styles.dividerLine} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.dividerLine} />
      </View>

      <SocialButtons />

      <View style={styles.footer}>
        <Text style={styles.footerText}>Don&apos;t have an account? </Text>
        <Link href="/(auth)/sign-up" style={styles.footerLink}>
          Sign up
        </Link>
      </View>
    </AuthScaffold>
  );
}
