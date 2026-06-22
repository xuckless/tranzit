import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Link } from "expo-router";
import { useSignIn } from "@clerk/expo";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { SocialButtons } from "@/components/auth/SocialButtons";
import { authErrorMessage } from "@/components/auth/authError";

export default function SignInScreen() {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const { colors } = theme;
  const { signIn } = useSignIn();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    if (!signIn || loading) return;
    setError("");
    setLoading(true);
    try {
      const { error: pwError } = await signIn.password({
        emailAddress: email.trim(),
        password,
      });
      if (pwError) {
        setError(authErrorMessage(pwError));
        return;
      }
      if (signIn.status === "complete") {
        // Sets the active session; the (auth) layout guard then redirects in.
        await signIn.finalize();
      }
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.logoMark}>
          <Ionicons name="bus" size={28} color={colors.onPrimary} />
        </View>
        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>Sign in to continue to Tranzit</Text>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.fieldLabel}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={colors.ink3}
            secureTextEntry
            textContentType="password"
          />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.primaryBtn, loading && styles.primaryBtnDisabled]}
          onPress={onSubmit}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <Text style={styles.primaryBtnText}>Sign in</Text>
          )}
        </TouchableOpacity>

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
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function makeStyles(t: AppTheme) {
  const { colors, typography, radii, spacing } = t;
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.surface,
    },
    scroll: {
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: spacing.screen + 6,
      paddingVertical: 48,
    },
    logoMark: {
      width: 56,
      height: 56,
      borderRadius: 18,
      backgroundColor: colors.primary,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 20,
    },
    title: {
      ...typography.titleXl,
      color: colors.ink,
    },
    subtitle: {
      ...typography.body,
      color: colors.ink2,
      marginTop: 4,
      marginBottom: 28,
    },
    field: {
      marginBottom: 16,
    },
    fieldLabel: {
      ...typography.caption,
      fontWeight: "700",
      color: colors.ink3,
      marginBottom: 6,
      textTransform: "uppercase",
      letterSpacing: 0.6,
    },
    input: {
      ...typography.body,
      color: colors.ink,
      backgroundColor: colors.card,
      borderRadius: radii.button,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 16,
      height: 52,
    },
    error: {
      ...typography.caption,
      color: colors.danger,
      marginBottom: 12,
    },
    primaryBtn: {
      height: 50,
      borderRadius: radii.button,
      backgroundColor: colors.primary,
      justifyContent: "center",
      alignItems: "center",
      marginTop: 8,
    },
    primaryBtnDisabled: {
      opacity: 0.6,
    },
    primaryBtnText: {
      ...typography.buttonLg,
      color: colors.onPrimary,
    },
    divider: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginVertical: 24,
    },
    dividerLine: {
      flex: 1,
      height: 1,
      backgroundColor: colors.divider,
    },
    dividerText: {
      ...typography.caption,
      color: colors.ink3,
    },
    footer: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      marginTop: 28,
    },
    footerText: {
      ...typography.body,
      color: colors.ink2,
    },
    footerLink: {
      ...typography.bodyStrong,
      color: colors.primary,
      fontWeight: "700",
    },
  });
}
