import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { theme } from "@/styles/theme";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";

export default function ReportScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.textWrapper}>
        <Text style={styles.title}>What's happening?</Text>
        <Text style={styles.text}>
          Your real-time report helps 1,240 commuters on this line.
        </Text>
      </View>

      <View style={styles.grid}>
        <TouchableOpacity style={styles.gridCard}>
          <View
            style={[styles.icon, { backgroundColor: theme.colors.primary }]}
          >
            <Ionicons
              name="people-outline"
              size={24}
              color={theme.colors.neutral}
            />
          </View>

          <Text style={styles.btnText}>Crowded</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.gridCard}>
          <View
            style={[styles.icon, { backgroundColor: theme.colors.secondary }]}
          >
            <Ionicons
              name="time-outline"
              size={24}
              color={theme.colors.selected}
            />
          </View>

          <Text style={styles.btnText}>Delay</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.gridCard}>
          <View style={[styles.icon, { backgroundColor: "#FFDAD6" }]}>
            <Ionicons
              name="shield-outline"
              size={24}
              color={theme.colors.error}
            />
          </View>

          <Text style={styles.btnText}>Safety</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.gridCard}>
          <View
            style={[styles.icon, { backgroundColor: theme.colors.tertiary }]}
          >
            <FontAwesome5 name="brush" size={24} color={theme.colors.neutral} />
          </View>

          <Text style={styles.btnText}>Vandalism</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  textWrapper: {
    flexDirection: "column",
    padding: theme.spacing.screen,
    gap: theme.spacing.element,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
  },
  text: {
    fontSize: theme.fontSize.subtitle,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: theme.spacing.screen,
    justifyContent: "space-between",
    // borderWidth: 1,
    rowGap: 16,
  },
  gridCard: {
    backgroundColor: theme.colors.muted,
    width: "48%",
    paddingHorizontal: theme.spacing.screen,
    paddingVertical: 20,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    borderRadius: theme.borderRadius.card,
    borderWidth: 2,
  },
  icon: {
    width: 50,
    height: 50,
    borderRadius: 50,
    justifyContent: "center",
    alignItems: "center",
  },
  btnText: {
    fontSize: theme.fontSize.body,
    fontWeight: "600",
  },
});
