import { useCallback, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { makeRedirectUri } from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { router } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { supabase } from "@/lib/supabase";
import { completeAuthFromUrl } from "@/lib/authLinking";

// Supabase provider ids. "azure" is Microsoft.
type Provider = "google" | "apple" | "azure";

const PROVIDERS: {
  key: Provider;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: "google", label: "Continue with Google", icon: "logo-google" },
  { key: "apple", label: "Continue with Apple", icon: "logo-apple" },
  { key: "azure", label: "Continue with Microsoft", icon: "logo-microsoft" },
];

/**
 * Google / Apple / Microsoft sign-in via Supabase web OAuth: `signInWithOAuth`
 * builds the provider URL, `expo-web-browser` runs the redirect dance, and we
 * complete the PKCE exchange from the returned URL. On success we route to `/`
 * (the index gate forwards into the app); the `(auth)/_layout` guard is the
 * safety net.
 */
export function SocialButtons() {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const iconColor = theme.colors.ink;
  const [pending, setPending] = useState<Provider | null>(null);

  const onPress = useCallback(
    async (provider: Provider) => {
      if (pending) return;
      setPending(provider);
      try {
        const redirectTo = makeRedirectUri();
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider,
          options: { redirectTo, skipBrowserRedirect: true },
        });
        if (error) throw error;
        if (!data?.url) return;

        const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
        if (result.type === "success") {
          await completeAuthFromUrl(result.url);
          router.replace("/");
        }
      } catch (err) {
        // User-cancelled or provider error — surface in console, leave the
        // screen as-is so they can retry.
        console.warn(`[auth] OAuth ${provider} failed`, err);
      } finally {
        setPending(null);
      }
    },
    [pending],
  );

  return (
    <View style={styles.group}>
      {PROVIDERS.map(({ key, label, icon }) => (
        <SocialButton
          key={key}
          styles={styles}
          icon={icon}
          iconColor={iconColor}
          label={label}
          loading={pending === key}
          disabled={pending !== null}
          onPress={() => onPress(key)}
        />
      ))}
    </View>
  );
}

function SocialButton({
  styles,
  icon,
  iconColor,
  label,
  loading,
  disabled,
  onPress,
}: {
  styles: ReturnType<typeof makeStyles>;
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  label: string;
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.btn, disabled && styles.btnDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
    >
      {loading ? (
        <ActivityIndicator size="small" color={iconColor} />
      ) : (
        <Ionicons name={icon} size={20} color={iconColor} />
      )}
      <Text style={styles.label}>{label}</Text>
    </TouchableOpacity>
  );
}

function makeStyles(t: AppTheme) {
  const { colors, typography, radii, spacing } = t;
  return StyleSheet.create({
    group: {
      gap: spacing.element,
    },
    btn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      height: 50,
      backgroundColor: colors.card,
      borderRadius: radii.button,
      borderWidth: 1,
      borderColor: colors.border,
    },
    btnDisabled: {
      opacity: 0.5,
    },
    label: {
      ...typography.buttonLg,
      color: colors.ink,
    },
  });
}
