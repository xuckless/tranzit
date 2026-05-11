import { Tabs } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { theme } from "@/styles/theme";
// import { SafeAreaView } from "react-native-safe-area-context";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function HeaderBar() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets(); // Hook to get status bar height

  const handleSettings = () => {
    navigation.navigate("settings" as never);
  };

  return (
    <View
      style={[
        styles.headerContainer,
        { paddingTop: insets.top + 8 }, // Dynamically adjust for notch
      ]}
    >
      <View style={styles.headerLeft}>
        <View style={styles.logoCircle}>
          <Ionicons name="train" size={20} color="white" />
        </View>
        <Text style={styles.appName}>RoutesLink</Text>
      </View>
      <TouchableOpacity style={styles.settingsButton} onPress={handleSettings}>
        <Ionicons
          name="settings-outline"
          size={24}
          color="white" // Neutral color on primary background
        />
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
        // Active tab Styling
        tabBarActiveTintColor: theme.colors.selected,
        tabBarActiveBackgroundColor: theme.colors.secondary,

        tabBarInactiveTintColor: theme.colors.text,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabBarLabel,

        tabBarItemStyle: {
          borderRadius: 12,
          marginHorizontal: 4,
          height: 50,
          // backgroundColor: theme.colors.primary,
        },
        tabBarBackground: () => null,
        sceneContainerStyle: {
          backgroundColor: theme.colors.secondary,
        },
      })}
    >
      <Tabs.Screen
        name="map"
        options={{
          title: "Map",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons
              name="map-outline"
              size={size}
              color={color}
              focused={focused}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="routes"
        options={{
          title: "Routes",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name="bus-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="saved"
        options={{
          title: "Saved",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="bookmark-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="report"
        options={{
          title: "Report",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name="warning-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="commute"
        options={{
          title: "Commute",
          tabBarIcon: ({ color, size, focused }) => (
            <MaterialIcons name="route" size={size} color={color} />
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
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: theme.colors.neutral,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.neutral,
  },
  logoCircle: {
    width: 30,
    height: 30,
    borderRadius: 20,
    backgroundColor: "#0070EB",
    justifyContent: "center",
    alignItems: "center",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  appName: {
    fontSize: theme.fontSize.title,
    fontWeight: "800",
    color: theme.colors.primary,
  },
  settingsButton: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: theme.colors.primary,
  },
  tabBar: {
    backgroundColor: theme.colors.background,
    borderTopColor: theme.colors.neutral,
    height: 70,
    paddingBottom: 8,
    paddingHorizontal: 8,
    display: "flex",
    justifyContent: "space-around",
  },
  tabBarLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
});
