import { useState } from "react";
import { ActivityIndicator, View, Text, TouchableOpacity } from "react-native";
import { Link, router } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";
import { AuthScaffold } from "@/components/auth/AuthScaffold";
import { AuthField } from "@/components/auth/AuthField";
import { PasswordField } from "@/components/auth/PasswordField";
import { AuthButton } from "@/components/auth/AuthButton";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { authErrorMessage } from "@/components/auth/authError";
import { supabase } from "@/lib/supabase";

export default function SignInScreen() {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [guestLoading, setGuestLoading] = useState(false);

  const onSignIn = async () => {
    if (loading) return;
    setError("");
    setLoading(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        setError(authErrorMessage(signInError));
        return;
      }
      // onAuthStateChange flips the session; leave the auth stack via the index gate.
      router.replace("/");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const onGuest = async () => {
    if (loading || guestLoading) return;
    setError("");
    setGuestLoading(true);
    try {
      // Anonymous sign-in must be enabled in the Supabase dashboard. Creates a
      // real user.id + session; UserSync mirrors it into user_info (is_guest=true).
      const { error: anonError } = await supabase.auth.signInAnonymously();
      if (anonError) {
        setError(authErrorMessage(anonError));
        return;
      }
      router.replace("/");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setGuestLoading(false);
    }
  };

  return (
    <AuthScaffold title="Welcome back" subtitle="Sign in to continue to Tranzit">
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

      <TouchableOpacity
        style={styles.secondaryBtn}
        onPress={onGuest}
        disabled={loading || guestLoading}
        activeOpacity={0.85}
      >
        {guestLoading ? (
          <ActivityIndicator color={theme.colors.ink} />
        ) : (
          <Text style={styles.secondaryBtnText}>Continue as guest</Text>
        )}
      </TouchableOpacity>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Don&apos;t have an account? </Text>
        <Link href="/(auth)/sign-up" style={styles.footerLink}>
          Sign up
        </Link>
      </View>
    </AuthScaffold>
  );
}
