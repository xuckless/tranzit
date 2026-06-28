import {
  View,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useUserProfile } from "@/hooks/useUserProfile";
import type { AppTheme, ColorSchemePreference } from "@/styles/themes";
import { router } from "expo-router";

const MODES: {
  key: ColorSchemePreference;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: "system", label: "System", icon: "phone-portrait-outline" },
  { key: "light", label: "Light", icon: "sunny-outline" },
  { key: "dark", label: "Dark", icon: "moon-outline" },
];

export default function SettingsScreen() {
  const {
    theme,
    packId,
    schemePreference,
    setPackId,
    setSchemePreference,
    availablePacks,
  } = useTheme();
  const { colors } = theme;
  const styles = makeStyles(theme);

  const { signOut, isGuest } = useAuth();
  const { profile, loading: profileLoading, error: profileError } =
    useUserProfile();

  const displayName = profile?.name || profile?.username || "Profile";
  const avatarUrl: string | null = profile?.avatar ?? null;

  // Profile is read-only for now; the pen buttons are placeholders to wire later.
  const profileFields: { key: string; label: string; value: string | null }[] =
    [
      { key: "name", label: "Name", value: profile?.name ?? null },
      { key: "username", label: "Username", value: profile?.username ?? null },
      { key: "email", label: "Email", value: profile?.email ?? null },
      { key: "dob", label: "Date of birth", value: profile?.date_of_birth ?? null },
      { key: "city", label: "City", value: profile?.city ?? null },
      { key: "country", label: "Country", value: profile?.country ?? null },
      { key: "plan", label: "Plan", value: profile?.subscription_status ?? null },
    ];

  const onEditField = (label: string) =>
    Alert.alert(
      "Coming soon",
      `Editing your ${label.toLowerCase()} isn't available yet.`,
    );

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

        {/* ── Mode: System / Light / Dark ── */}
        <Text style={styles.fieldLabel}>Mode</Text>
        <View style={styles.modeRow}>
          {MODES.map((m) => {
            const active = schemePreference === m.key;
            return (
              <TouchableOpacity
                key={m.key}
                style={[styles.modeSegment, active && styles.modeSegmentActive]}
                onPress={() => setSchemePreference(m.key)}
                activeOpacity={0.85}
              >
                <Ionicons
                  name={m.icon}
                  size={16}
                  color={active ? colors.onPrimary : colors.ink3}
                />
                <Text
                  style={[styles.modeText, active && styles.modeTextActive]}
                >
                  {m.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Theme pack picker (each pack carries a light + dark variant) ── */}
        <Text style={[styles.fieldLabel, styles.fieldLabelSpaced]}>Theme</Text>
        <View style={styles.themeGroup}>
          {availablePacks.map((pack) => {
            const active = pack.id === packId;
            return (
              <TouchableOpacity
                key={pack.id}
                style={[styles.themeChip, active && styles.themeChipActive]}
                onPress={() => setPackId(pack.id)}
                activeOpacity={0.8}
              >
                <View style={styles.themeSwatches}>
                  <View
                    style={[
                      styles.themeSwatch,
                      { backgroundColor: pack.light.colors.primary },
                    ]}
                  />
                  <View
                    style={[
                      styles.themeSwatch,
                      {
                        backgroundColor: pack.light.colors.surface,
                        borderColor: pack.light.colors.border,
                      },
                    ]}
                  />
                  <View
                    style={[
                      styles.themeSwatch,
                      {
                        backgroundColor: pack.dark.colors.surface,
                        borderColor: pack.dark.colors.border,
                      },
                    ]}
                  />
                  <View
                    style={[
                      styles.themeSwatch,
                      { backgroundColor: pack.dark.colors.primary },
                    ]}
                  />
                </View>
                <Text
                  style={[styles.themeLabel, active && styles.themeLabelActive]}
                >
                  {pack.name}
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

        {/* Profile header */}
        <View style={styles.profileRow}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Ionicons name="person" size={20} color={colors.onPrimary} />
            </View>
          )}
          <View style={styles.profileText}>
            <Text style={styles.profileName} numberOfLines={1}>
              {displayName}
            </Text>
            <Text style={styles.profileEmail} numberOfLines={1}>
              {isGuest ? "Guest" : (profile?.email ?? "—")}
            </Text>
          </View>
        </View>

        {/* Profile details — read from user_info only */}
        {profileLoading && !profile ? (
          <View style={styles.profileLoading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : profileError && !profile ? (
          <Text style={styles.profileErrorText}>{profileError}</Text>
        ) : (
          <View style={styles.profileTable}>
            {profileFields.map((f, i) => (
              <View
                key={f.key}
                style={[
                  styles.profileFieldRow,
                  i > 0 && styles.profileFieldDivider,
                ]}
              >
                <Text style={styles.profileFieldLabel}>{f.label}</Text>
                <Text style={styles.profileFieldValue} numberOfLines={1}>
                  {f.value || "—"}
                </Text>
                <TouchableOpacity
                  style={styles.editBtn}
                  onPress={() => onEditField(f.label)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="pencil" size={15} color={colors.ink3} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

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
    fieldLabel: {
      ...typography.fieldLabel,
      color: colors.ink3,
      marginBottom: spacing.element,
    },
    fieldLabelSpaced: {
      marginTop: spacing.element,
    },
    modeRow: {
      flexDirection: "row",
      backgroundColor: colors.surface2,
      borderRadius: radii.chip,
      borderWidth: 1,
      borderColor: colors.divider,
      padding: 4,
      gap: 4,
      marginBottom: spacing.card,
    },
    modeSegment: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 9,
      borderRadius: radii.element,
    },
    modeSegmentActive: {
      backgroundColor: colors.primary,
    },
    modeText: {
      ...typography.buttonMd,
      color: colors.ink2,
    },
    modeTextActive: {
      color: colors.onPrimary,
      fontWeight: "700",
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

    // Borderless profile detail table (one card, hairline row dividers).
    profileTable: {
      backgroundColor: colors.card,
      borderRadius: radii.chip,
      borderWidth: 1,
      borderColor: colors.divider,
      paddingHorizontal: 14,
      marginBottom: spacing.element,
    },
    profileFieldRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 12,
      gap: 12,
    },
    profileFieldDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.divider,
    },
    profileFieldLabel: {
      ...typography.body,
      color: colors.ink3,
      width: 110,
    },
    profileFieldValue: {
      ...typography.body,
      color: colors.ink,
      flex: 1,
      textAlign: "right",
    },
    editBtn: {
      padding: 4,
    },
    profileLoading: {
      paddingVertical: 24,
      alignItems: "center",
    },
    profileErrorText: {
      ...typography.body,
      color: colors.ink3,
      paddingVertical: 16,
      marginBottom: spacing.element,
    },
  });
}
