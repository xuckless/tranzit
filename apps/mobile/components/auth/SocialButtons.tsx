import { useCallback, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useSSO } from "@clerk/expo";
import * as AuthSession from "expo-auth-session";
import { router } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { authDebug, authDebugResult, authDebugError } from "@/lib/authDebug";

type Provider = "google" | "apple";

const STRATEGY = {
  google: "oauth_google",
  apple: "oauth_apple",
} as const;

/**
 * Google / Apple OAuth via Clerk's hosted SSO flow (`useSSO` → expo-web-browser).
 * On success `setActive` flips the Clerk session and we route to `/` (the index
 * gate forwards into the app); the `(auth)/_layout` guard is the safety net.
 */
export function SocialButtons() {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const iconColor = theme.colors.ink;
  const { startSSOFlow } = useSSO();
  const [pending, setPending] = useState<Provider | null>(null);

  const onPress = useCallback(
    async (provider: Provider) => {
      if (pending) return;
      const redirectUrl = AuthSession.makeRedirectUri();
      authDebug(`SSO ${provider} startSSOFlow()`, {
        strategy: STRATEGY[provider],
        redirectUrl,
      });
      setPending(provider);
      try {
        const ssoResult = await startSSOFlow({
          strategy: STRATEGY[provider],
          redirectUrl,
        });
        const { createdSessionId, setActive } = ssoResult;
        authDebugResult(`SSO ${provider} startSSOFlow result`, ssoResult, {
          hasCreatedSessionId: !!createdSessionId,
          hasSetActive: !!setActive,
        });
        if (createdSessionId && setActive) {
          authDebug(`SSO ${provider} → activating session`, createdSessionId);
          await setActive({ session: createdSessionId });
          // Leave the auth stack explicitly; index.tsx forwards to the app.
          router.replace("/");
        } else {
          authDebug(
            `SSO ${provider} → NO session created (guard skipped, goes nowhere)`,
            {
              hasCreatedSessionId: !!createdSessionId,
              hasSetActive: !!setActive,
            },
          );
        }
      } catch (err) {
        // User-cancelled or provider error — surface in console, leave the
        // screen as-is so they can retry.
        authDebugError(`SSO ${provider} startSSOFlow`, err);
      } finally {
        setPending(null);
      }
    },
    [pending, startSSOFlow],
  );

  return (
    <View style={styles.group}>
      <SocialButton
        styles={styles}
        icon="logo-google"
        iconColor={iconColor}
        label="Continue with Google"
        loading={pending === "google"}
        disabled={pending !== null}
        onPress={() => onPress("google")}
      />
      <SocialButton
        styles={styles}
        icon="logo-apple"
        iconColor={iconColor}
        label="Continue with Apple"
        loading={pending === "apple"}
        disabled={pending !== null}
        onPress={() => onPress("apple")}
      />
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
