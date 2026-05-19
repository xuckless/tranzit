import { Tabs } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { theme } from "@/styles/theme";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// Tranzit logo mark — bus body with wheels
function TranzitLogoMark({ size = 18 }: { size?: number }) {
  return (
    <View
      style={{
        width: size + 12,
        height: size + 12,
        borderRadius: (size + 12) * 0.33,
        backgroundColor: theme.colors.primary,
        justifyContent: "center",
        alignItems: "center",
        shadowColor: theme.colors.primary,
        shadowOffset: { width: 0, height: 3 },
        shadowOpacity: 0.3,
        shadowRadius: 6,
        elevation: 4,
      }}
    >
      <Ionicons name="bus" size={size} color="#fff" />
    </View>
  );
}

function HeaderBar() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.headerContainer, { paddingTop: insets.top + 8 }]}>
      <View style={styles.headerLeft}>
        <TranzitLogoMark size={18} />
        <Text style={styles.appName}>Tranzit</Text>
      </View>
      <TouchableOpacity
        style={styles.settingsButton}
        onPress={() => navigation.navigate("settings" as never)}
      >
        <Ionicons name="settings-outline" size={20} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

export default function RootLayout() {
  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: true,
        header: () => <HeaderBar />,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.ink3,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabBarLabel,
        tabBarItemStyle: styles.tabBarItem,
        sceneContainerStyle: { backgroundColor: theme.colors.surface },
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
        name="report"
        options={{
          title: "Report",
          tabBarIcon: ({ color, focused }) => (
            <View
              style={[styles.tabIconWrap, focused && styles.tabIconWrapActive]}
            >
              <Ionicons
                name={focused ? "warning" : "warning-outline"}
                size={22}
                color={color}
              />
            </View>
          ),
        }}
      />
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

const styles = StyleSheet.create({
  headerContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingBottom: 10,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.divider,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  appName: {
    fontSize: 22,
    fontWeight: "800",
    color: theme.colors.primary,
    letterSpacing: -0.5,
  },
  settingsButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: theme.colors.primary,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },

  // Tab bar
  tabBar: {
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
    height: 68,
    paddingBottom: 6,
    paddingHorizontal: 8,
    shadowColor: "rgba(20,30,80,0.06)",
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
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.1,
    marginTop: -2,
  },
  tabIconWrap: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "transparent",
  },
  tabIconWrapActive: {
    backgroundColor: theme.colors.primaryDim,
  },
});
