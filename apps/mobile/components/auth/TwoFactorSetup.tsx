import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useUser } from "@clerk/expo";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { authErrorMessage } from "@/components/auth/authError";

type Mode = "idle" | "setup" | "backup";

/**
 * Authenticator-app (TOTP) two-factor enrollment for the signed-in user, plus
 * one-time backup codes. Mirrors the row styling of ConnectedAccounts/Settings.
 *
 * Requires MFA (Authenticator application + Backup codes) to be enabled in the
 * Clerk dashboard — until then `createTOTP()` errors and we surface a hint.
 */
export function TwoFactorSetup() {
  const { theme } = useTheme();
  const styles = makeStyles(theme);
  const { user } = useUser();

  const [mode, setMode] = useState<Mode>("idle");
  const [secret, setSecret] = useState("");
  const [uri, setUri] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (!user) return null;

  const startSetup = async () => {
    if (loading) return;
    setError("");
    setLoading(true);
    try {
      const totp = await user.createTOTP();
      setSecret(totp.secret ?? "");
      setUri(totp.uri ?? "");
      setCode("");
      setMode("setup");
    } catch (err) {
      setError(
        authErrorMessage(err) ||
          "Couldn't start setup. Enable Authenticator (TOTP) in your Clerk dashboard.",
      );
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    if (loading) return;
    setError("");
    setLoading(true);
    try {
      await user.verifyTOTP({ code: code.trim() });
      // Generate backup codes once TOTP is confirmed.
      const backup = await user.createBackupCode();
      setBackupCodes(backup.codes ?? []);
      await user.reload();
      setMode("backup");
    } catch (err) {
      setError(authErrorMessage(err) || "That code is incorrect. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const disable = () => {
    Alert.alert(
      "Turn off two-factor?",
      "You'll no longer be asked for an authenticator code when signing in.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Turn off",
          style: "destructive",
          onPress: async () => {
            setError("");
            setLoading(true);
            try {
              await user.disableTOTP();
              await user.reload();
              setMode("idle");
            } catch (err) {
              setError(authErrorMessage(err));
            } finally {
              setLoading(false);
            }
          },
        },
      ],
    );
  };

  // ── Setup: show secret + verify code ────────────────────────────────────────
  if (mode === "setup") {
    return (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Add to your authenticator app</Text>
        <Text style={styles.panelText}>
          Enter this key in Google Authenticator, 1Password, Authy, etc. (long-press
          to copy), then enter the 6-digit code it shows.
        </Text>
        <Text style={styles.codeBlock} selectable>
          {secret || uri}
        </Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          placeholder="123456"
          placeholderTextColor={theme.colors.ink3}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={8}
          autoFocus
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={verify}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading ? (
            <ActivityIndicator color={theme.colors.onPrimary} />
          ) : (
            <Text style={styles.primaryBtnText}>Verify & enable</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.linkBtn}
          onPress={() => {
            setMode("idle");
            setError("");
          }}
        >
          <Text style={styles.linkText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Backup codes (shown once) ───────────────────────────────────────────────
  if (mode === "backup") {
    return (
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>Save your backup codes</Text>
        <Text style={styles.panelText}>
          Store these somewhere safe. Each code can be used once if you lose access
          to your authenticator. They won't be shown again.
        </Text>
        <Text style={styles.codeBlock} selectable>
          {backupCodes.join("\n")}
        </Text>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={() => setMode("idle")}
          activeOpacity={0.85}
        >
          <Text style={styles.primaryBtnText}>I've saved them</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Idle: status row ────────────────────────────────────────────────────────
  return (
    <View>
      <View style={styles.row}>
        <Ionicons
          name="shield-checkmark-outline"
          size={22}
          color={theme.colors.primary}
        />
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Authenticator app</Text>
          <Text style={styles.rowSub}>
            {user.totpEnabled ? "Two-factor is on" : "Add an extra layer of security"}
          </Text>
        </View>
        {user.totpEnabled ? (
          <TouchableOpacity onPress={disable} disabled={loading}>
            <Text style={styles.dangerText}>Turn off</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={startSetup} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color={theme.colors.ink3} />
            ) : (
              <Text style={styles.connectText}>Set up</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function makeStyles(t: AppTheme) {
  const { colors, typography, radii, spacing } = t;
  return StyleSheet.create({
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
    rowText: {
      flex: 1,
    },
    rowLabel: {
      ...typography.buttonLg,
      color: colors.ink,
    },
    rowSub: {
      ...typography.caption,
      color: colors.ink3,
      marginTop: 2,
    },
    connectText: {
      ...typography.bodyStrong,
      color: colors.primary,
      fontWeight: "700",
    },
    dangerText: {
      ...typography.bodyStrong,
      color: colors.danger,
      fontWeight: "700",
    },
    panel: {
      padding: 14,
      backgroundColor: colors.card,
      borderRadius: radii.chip,
      borderWidth: 1,
      borderColor: colors.divider,
      gap: 12,
    },
    panelTitle: {
      ...typography.buttonLg,
      color: colors.ink,
    },
    panelText: {
      ...typography.caption,
      color: colors.ink2,
      lineHeight: 18,
    },
    codeBlock: {
      ...typography.body,
      color: colors.ink,
      fontVariant: ["tabular-nums"],
      backgroundColor: colors.surface,
      borderRadius: radii.button,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 12,
      letterSpacing: 1,
    },
    input: {
      ...typography.body,
      color: colors.ink,
      backgroundColor: colors.surface,
      borderRadius: radii.button,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 16,
      height: 50,
    },
    primaryBtn: {
      height: 48,
      borderRadius: radii.button,
      backgroundColor: colors.primary,
      justifyContent: "center",
      alignItems: "center",
    },
    primaryBtnText: {
      ...typography.buttonLg,
      color: colors.onPrimary,
    },
    linkBtn: {
      alignSelf: "center",
      paddingVertical: 4,
    },
    linkText: {
      ...typography.bodyStrong,
      color: colors.ink3,
    },
    error: {
      ...typography.caption,
      color: colors.danger,
      marginTop: 8,
    },
  });
}
