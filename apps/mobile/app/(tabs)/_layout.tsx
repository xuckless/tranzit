import { Tabs, useRouter, Redirect } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useAuth } from "@/contexts/AuthContext";
import { useAuthBypass } from "@/lib/devAuthBypass";
import { useTheme } from "@/contexts/ThemeContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AppTheme } from "@/styles/themes";

function TranzitLogoMark({ size = 18 }: { size?: number }) {
  const { theme } = useTheme();
  const { colors, typography } = theme;
  return (
    <View
      style={{
        width: size + 12,
        height: size + 12,
        borderRadius: (size + 12) * 0.33,
        backgroundColor: colors.primary,
        justifyContent: "center",
        alignItems: "center",
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.3,
        shadowRadius: 6,
        elevation: 4,
      }}
    >
      <Ionicons name="bus" size={size} color={colors.onPrimary} />
    </View>
  );
}

function HeaderBar() {
  const navigation = useNavigation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { theme } = useTheme();
  const { colors, typography } = theme;
  const styles = makeStyles(theme);

  return (
    <View style={styles.headerContainer}>
      <View style={styles.headerLeft}>
        <TranzitLogoMark size={18} />
      </View>
      <Text style={styles.appName}>Tranzit</Text>
      <TouchableOpacity
        style={styles.settingsButton}
        onPress={() => router.push("/settings")}
      >
        <Ionicons name="settings-outline" size={20} color={colors.onPrimary} />
      </TouchableOpacity>
    </View>
  );
}

export default function RootLayout() {
  const { theme } = useTheme();
  const { colors, typography, semantic, radii, spacing } = theme;
  const styles = makeStyles(theme);

  // Hard auth gate: no tab is reachable until Supabase reports a session. Also
  // covers the top-level settings/add-trip stack routes, which are only
  // navigable from within the tabs.
  const { isLoaded, isSignedIn } = useAuth();
  const bypass = useAuthBypass();
  if (!isLoaded) return null;
  if (!isSignedIn && !bypass) return <Redirect href="/(auth)/sign-in" />;

  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: true,
        header: () => <HeaderBar />,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.ink3,
        tabBarStyle: [
          styles.tabBar,
          { backgroundColor: colors.card, borderTopColor: colors.divider },
        ],
        tabBarLabelStyle: styles.tabBarLabel,
        tabBarItemStyle: styles.tabBarItem,
        sceneContainerStyle: { backgroundColor: colors.surface },
      })}
    >
      <Tabs.Screen
        name="map"
        options={{
          title: "Map",
          tabBarIcon: ({ color, focused }) => (
            <View
              style={[styles.tabIconWrap, focused && styles.tabIconWrapActive]}
            >
              <Ionicons
                name={focused ? "map" : "map-outline"}
                size={22}
                color={color}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="routes"
        options={{
          title: "Routes",
          tabBarIcon: ({ color, focused }) => (
            <View
              style={[styles.tabIconWrap, focused && styles.tabIconWrapActive]}
            >
              <Ionicons
                name={focused ? "bus" : "bus-outline"}
                size={22}
                color={color}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="saved"
        options={{
          title: "Saved",
          tabBarIcon: ({ color, focused }) => (
            <View
              style={[styles.tabIconWrap, focused && styles.tabIconWrapActive]}
            >
              <Ionicons
                name={focused ? "bookmark" : "bookmark-outline"}
                size={22}
                color={color}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="planner"
        options={{
          title: "Planner",
          tabBarIcon: ({ color, focused }) => (
            <View
              style={[styles.tabIconWrap, focused && styles.tabIconWrapActive]}
            >
              <Ionicons
                name={focused ? "calendar" : "calendar-outline"}
                size={22}
                color={color}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen name="report" options={{ href: null }} />
      <Tabs.Screen
        name="commute"
        options={{
          title: "Commute",
          tabBarIcon: ({ color, focused }) => (
            <View
              style={[styles.tabIconWrap, focused && styles.tabIconWrapActive]}
            >
              <MaterialIcons name="route" size={22} color={color} />
            </View>
          ),
        }}
      />
    </Tabs>
  );
}

function makeStyles(t: AppTheme) {
  const { colors, typography, semantic, spacing, radii, shadow } = t;
  return StyleSheet.create({
    headerContainer: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingTop: 60,
      paddingHorizontal: spacing.screen,
      paddingBottom: 10,
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.divider,
    },
    headerLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    appName: {
      ...typography.titleXl,
      color: colors.primary,
    },
    settingsButton: {
      width: 40,
      height: 40,
      borderRadius: radii.chip,
      backgroundColor: colors.primary,
      justifyContent: "center",
      alignItems: "center",
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 8,
      elevation: 4,
    },

    // Tab bar
    tabBar: {
      backgroundColor: colors.card,
      borderTopWidth: 1,
      borderTopColor: colors.divider,
      height: 68,
      paddingBottom: 6,
      paddingHorizontal: 8,
      ...shadow.soft,
      shadowColor: semantic.shadowCardOverlay,
      shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 1,
      shadowRadius: 16,
      elevation: 8,
    },
    tabBarItem: {
      marginHorizontal: 2,
      height: 56,
    },
    tabBarLabel: {
      ...typography.tabLabel,
      marginTop: -2,
    },
    tabIconWrap: {
      paddingHorizontal: 4,
      paddingVertical: 4,
      borderRadius: 999,
      backgroundColor: "transparent",
    },
    tabIconWrapActive: {
      backgroundColor: colors.primaryDim,
    },
  });
}
