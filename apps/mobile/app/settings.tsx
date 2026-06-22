import {
  View,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Switch,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useUser, useClerk } from "@clerk/expo";
import { useTheme } from "@/contexts/ThemeContext";
import { THEMES, THEME_IDS } from "@/styles/themes";
import type { AppTheme, ThemeId } from "@/styles/themes";
import { router } from "expo-router";
import { ConnectedAccounts } from "@/components/auth/ConnectedAccounts";
import { TwoFactorSetup } from "@/components/auth/TwoFactorSetup";

export default function SettingsScreen() {
  const { theme, themeId, setThemeId } = useTheme();
  const { colors, typography, semantic, spacing, radii } = theme;
  const styles = makeStyles(theme);
  const isDark = theme.isDark;

  const { user } = useUser();
  const { signOut } = useClerk();
  const displayName =
    user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Profile";
  const displayEmail = user?.primaryEmailAddress?.emailAddress;

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
          <Ionicons name="close" size={24} color={colors.primaryInk} />
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Appearance</Text>

        {/* ── Theme picker ── */}
        <View style={styles.themeGroup}>
          {THEME_IDS.map((id) => {
            const preset = THEMES[id];
            const active = id === themeId;
            return (
              <TouchableOpacity
                key={id}
                style={[
                  styles.themeChip,
                  active && styles.themeChipActive,
                ]}
                onPress={() => setThemeId(id as ThemeId)}
                activeOpacity={0.8}
              >
                <View style={styles.themeSwatches}>
                  <View
                    style={[
                      styles.themeSwatch,
                      { backgroundColor: preset.colors.primary },
                    ]}
                  />
                  <View
                    style={[
                      styles.themeSwatch,
                      { backgroundColor: preset.colors.secondary },
                    ]}
                  />
                  <View
                    style={[
                      styles.themeSwatch,
                      {
                        backgroundColor: preset.colors.surface,
                        borderColor: preset.colors.border,
                      },
                    ]}
                  />
                  <View
                    style={[
                      styles.themeSwatch,
                      { backgroundColor: preset.colors.ink },
                    ]}
                  />
                </View>
                <Text
                  style={[
                    styles.themeLabel,
                    active && styles.themeLabelActive,
                  ]}
                >
                  {formatThemeName(id)}
                </Text>
                {active && (
                  <Ionicons
                    name="checkmark-circle"
                    size={18}
                    color={colors.primary}
                  />
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Quick dark-mode toggle (still useful for power users) ── */}
        <View style={styles.settingItem}>
          <Ionicons name="moon-outline" size={22} color={colors.primary} />
          <Text style={styles.settingText}>Dark Mode</Text>
          <Switch
            value={isDark}
            onValueChange={() =>
              setThemeId(isDark ? "classic-light" : "classic-dark")
            }
            trackColor={{ false: colors.divider, true: colors.primary }}
            thumbColor={isDark ? semantic.thumbColor : colors.ink3}
            style={styles.switch}
          />
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Preferences</Text>

        <TouchableOpacity style={styles.settingItem}>
          <Ionicons
            name="notifications-outline"
            size={22}
            color={colors.primary}
          />
          <Text style={styles.settingText}>Notifications</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.ink3} />
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>

        <View style={styles.profileRow}>
          {user?.imageUrl ? (
            <Image source={{ uri: user.imageUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Ionicons name="person" size={20} color={colors.onPrimary} />
            </View>
          )}
          <View style={styles.profileText}>
            <Text style={styles.profileName} numberOfLines={1}>
              {displayName}
            </Text>
            {displayEmail ? (
              <Text style={styles.profileEmail} numberOfLines={1}>
                {displayEmail}
              </Text>
            ) : null}
          </View>
        </View>

        <Text style={[styles.sectionTitle, styles.subSectionTitle]}>
          Two-factor authentication
        </Text>
        <TwoFactorSetup />

        <Text style={[styles.sectionTitle, styles.subSectionTitle]}>
          Connected accounts
        </Text>
        <ConnectedAccounts />

        <TouchableOpacity style={[styles.settingItem, styles.settingItemSpaced]}>
          <Ionicons
            name="help-circle-outline"
            size={22}
            color={colors.primary}
          />
          <Text style={styles.settingText}>Help & Support</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.ink3} />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.settingItem}
          onPress={() => signOut()}
          activeOpacity={0.8}
        >
          <Ionicons name="log-out-outline" size={22} color={colors.danger} />
          <Text style={[styles.settingText, { color: colors.danger }]}>
            Sign out
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function formatThemeName(id: string): string {
  return id
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function makeStyles(t: AppTheme) {
  const { colors, typography, semantic, spacing, radii } = t;
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.surface,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: spacing.screen,
      paddingTop: 60,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.divider,
    },
    headerTitle: {
      ...typography.title,
      fontWeight: "800",
      letterSpacing: -0.5,
      color: colors.ink,
    },
    closeBtn: {
      width: 40,
      height: 40,
      borderRadius: radii.pill,
      borderColor: `${colors.primaryInk}40`,
      borderWidth: 2,
      backgroundColor: colors.primaryDim,
      justifyContent: "center",
      alignItems: "center",
    },
    section: {
      marginTop: 20,
      paddingHorizontal: spacing.card,
    },
    sectionTitle: {
      ...typography.caption,
      fontWeight: "700",
      color: colors.ink3,
      marginBottom: 10,
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    subSectionTitle: {
      marginTop: spacing.element,
    },
    settingItemSpaced: {
      marginTop: spacing.card,
    },
    themeGroup: {
      gap: spacing.element,
      marginBottom: spacing.card,
    },
    themeChip: {
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
    themeChipActive: {
      borderColor: colors.primary,
      borderWidth: 2,
    },
    themeSwatches: {
      flexDirection: "row",
      gap: 4,
    },
    themeSwatch: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 0.5,
    },
    themeLabel: {
      flex: 1,
      ...typography.buttonLg,
      color: colors.ink,
    },
    themeLabelActive: {
      color: colors.primary,
      fontWeight: "700",
    },
    settingItem: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 13,
      paddingHorizontal: 14,
      backgroundColor: colors.card,
      borderRadius: radii.chip,
      borderWidth: 1,
      borderColor: colors.divider,
      marginBottom: spacing.element,
      gap: 12,
    },
    settingText: {
      ...typography.buttonLg,
      color: colors.ink,
      flex: 1,
    },
    profileRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 13,
      paddingHorizontal: 14,
      backgroundColor: colors.card,
      borderRadius: radii.chip,
      borderWidth: 1,
      borderColor: colors.divider,
      marginBottom: spacing.element,
      gap: 12,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.primaryDim,
    },
    avatarFallback: {
      backgroundColor: colors.primary,
      justifyContent: "center",
      alignItems: "center",
    },
    profileText: {
      flex: 1,
    },
    profileName: {
      ...typography.buttonLg,
      color: colors.ink,
    },
    profileEmail: {
      ...typography.caption,
      color: colors.ink3,
      marginTop: 2,
    },
    switch: {
      marginLeft: "auto",
    },
  });
}
