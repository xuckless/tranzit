import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Switch,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "@/styles/theme";
import { useTheme } from "@/contexts/ThemeContext";
import { router } from "expo-router";

export default function SettingsScreen() {
  const { isDark, toggle, colors } = useTheme();
  const styles = makeStyles(colors);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.back()}>
          <Ionicons name="close" size={24} color={colors.primaryInk} />
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Preferences</Text>

        <View style={styles.settingItem}>
          <Ionicons
            name="moon-outline"
            size={22}
            color={theme.colors.primary}
          />
          <Text style={styles.settingText}>Dark Mode</Text>
          <Switch
            value={isDark}
            onValueChange={toggle}
            trackColor={{ false: colors.divider, true: theme.colors.primary }}
            thumbColor={isDark ? "#fff" : colors.ink3}
            style={styles.switch}
          />
        </View>

        <TouchableOpacity style={styles.settingItem}>
          <Ionicons
            name="color-palette-outline"
            size={22}
            color={theme.colors.primary}
          />
          <Text style={styles.settingText}>Choose your theme</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.ink3} />
        </TouchableOpacity>

        <TouchableOpacity style={styles.settingItem}>
          <Ionicons
            name="notifications-outline"
            size={22}
            color={theme.colors.primary}
          />
          <Text style={styles.settingText}>Notifications</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.ink3} />
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>

        <TouchableOpacity style={styles.settingItem}>
          <Ionicons
            name="person-outline"
            size={22}
            color={theme.colors.primary}
          />
          <Text style={styles.settingText}>Profile</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.ink3} />
        </TouchableOpacity>

        <TouchableOpacity style={styles.settingItem}>
          <Ionicons
            name="help-circle-outline"
            size={22}
            color={theme.colors.primary}
          />
          <Text style={styles.settingText}>Help & Support</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.ink3} />
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>["colors"]) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.surface,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 18,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.divider,
    },
    headerTitle: {
      fontSize: theme.fontSize.title,
      fontWeight: "800",
      color: colors.ink,
      letterSpacing: -0.5,
    },
    closeBtn: {
      width: 40,
      height: 40,
      borderRadius: 9999,
      borderColor: `${colors.primaryInk}40`,
      borderWidth: 2,
      backgroundColor: colors.primaryDim,
      justifyContent: "center",
      alignItems: "center",
    },
    section: {
      marginTop: 20,
      paddingHorizontal: 16,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: "700",
      color: colors.ink3,
      marginBottom: 10,
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    settingItem: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 13,
      paddingHorizontal: 14,
      backgroundColor: colors.card,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.divider,
      marginBottom: 8,
      gap: 12,
    },
    settingText: {
      fontSize: 15,
      fontWeight: "600",
      color: colors.ink,
      flex: 1,
    },
    switch: {
      marginLeft: "auto",
    },
  });
}
