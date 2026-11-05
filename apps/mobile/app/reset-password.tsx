import { useState } from "react";
import { Text } from "react-native";
import { router } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";
import { AuthScaffold } from "@/components/auth/AuthScaffold";
import { PasswordField } from "@/components/auth/PasswordField";
import { AuthButton } from "@/components/auth/AuthButton";
import { authErrorMessage } from "@/components/auth/authError";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";

/**
 * Set-new-password screen, reached after a password-recovery deep link
 * establishes a (recovery) session. Lives at the top level — outside the
 * signed-in/out gated groups — so the recovery session doesn't get bounced.
 */
export default function ResetPasswordScreen() {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);
  const { clearRecoveryMode, signOut } = useAuth();

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    if (loading) return;
    if (newPassword !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (updateError) {
        setError(authErrorMessage(updateError));
        return;
      }
      clearRecoveryMode();
      router.replace("/");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthScaffold
      title="Set a new password"
      subtitle="Choose a new password to finish resetting your account."
      onBack={async () => {
        // Abandoning mid-reset: drop the recovery session so the user isn't
        // left signed in with a password they don't know. SIGNED_OUT clears
        // recoveryMode in AuthContext.
        await signOut();
        router.replace("/(auth)/sign-in");
      }}
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
      <AuthButton label="Update password" onPress={onSubmit} loading={loading} />
    </AuthScaffold>
  );
}
