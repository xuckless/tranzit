import { useCallback, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useUser } from "@clerk/expo";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";

type Provider = "google" | "apple" | "microsoft";

const PROVIDERS: {
  key: Provider;
  strategy: `oauth_${Provider}`;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: "google", strategy: "oauth_google", label: "Google", icon: "logo-google" },
  { key: "apple", strategy: "oauth_apple", label: "Apple", icon: "logo-apple" },
  {
    key: "microsoft",
    strategy: "oauth_microsoft",
    label: "Microsoft",
    icon: "logo-microsoft",
  },
];

// Read-only Google Calendar access, requested when linking Google.
const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
];

/**
 * Lets a signed-in user link additional external OAuth accounts (and grant Google
 * Calendar read access). Mirrors the SSO redirect dance in `SocialButtons.tsx`,
 * but uses `user.createExternalAccount` since there's already an active session —
 * no `setActive` needed. After the browser flow succeeds we `user.reload()` so the
 * connected state re-renders.
 */
export function ConnectedAccounts() {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const { user } = useUser();
  const [pending, setPending] = useState<Provider | null>(null);

  const onConnect = useCallback(
    async (provider: Provider, strategy: `oauth_${Provider}`) => {
      if (!user || pending) return;
      setPending(provider);
      try {
        const redirectUrl = AuthSession.makeRedirectUri();
        const externalAccount = await user.createExternalAccount({
          strategy,
          redirectUrl,
          additionalScopes:
            provider === "google" ? GOOGLE_CALENDAR_SCOPES : undefined,
        });

        const url =
          externalAccount.verification?.externalVerificationRedirectURL;
        if (!url) return;

        const result = await WebBrowser.openAuthSessionAsync(
          url.toString(),
          redirectUrl,
        );
        if (result.type === "success") {
          await user.reload();
        }
      } catch (err) {
        // User-cancelled or provider error — surface in console, leave the row
        // as-is so they can retry.
        console.warn(`[auth] connect ${provider} failed`, err);
      } finally {
        setPending(null);
      }
    },
    [user, pending],
  );

  if (!user) return null;

  return (
    <View style={styles.group}>
      {PROVIDERS.map(({ key, strategy, label, icon }) => {
        const connected = user.externalAccounts.some(
          (a) => a.provider === key,
        );
        return (
          <TouchableOpacity
            key={key}
            style={styles.row}
            onPress={() => onConnect(key, strategy)}
            disabled={connected || pending !== null}
            activeOpacity={0.8}
          >
            <Ionicons name={icon} size={22} color={theme.colors.primary} />
            <Text style={styles.label}>{label}</Text>
            {pending === key ? (
              <ActivityIndicator size="small" color={theme.colors.ink3} />
            ) : connected ? (
              <View style={styles.connectedPill}>
                <Ionicons
                  name="checkmark-circle"
                  size={16}
                  color={theme.colors.primary}
                />
                <Text style={styles.connectedText}>Connected</Text>
              </View>
            ) : (
              <Text style={styles.connectText}>Connect</Text>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function makeStyles(t: AppTheme) {
  const { colors, typography, radii, spacing } = t;
  return StyleSheet.create({
    group: {
      gap: spacing.element,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 13,
      paddingHorizontal: 14,
      backgroundColor: colors.card,
      borderRadius: radii.chip,
      borderWidth: 1,
      borderColor: colors.divider,
      gap: 12,
    },
    label: {
      ...typography.buttonLg,
      color: colors.ink,
      flex: 1,
    },
    connectText: {
      ...typography.bodyStrong,
      color: colors.primary,
      fontWeight: "700",
    },
    connectedPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    connectedText: {
      ...typography.caption,
      color: colors.ink3,
    },
  });
}
