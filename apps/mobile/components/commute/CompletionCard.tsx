import { useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";

/** "You've arrived" card shown when Route Save reports the trip COMPLETED. */
export function CompletionCard({
  destination,
  durationMin,
  arrivedAt,
  onDone,
}: {
  destination: string;
  /** Null when the start time isn't known (trip restored after a cold start). */
  durationMin: number | null;
  arrivedAt: string;
  onDone: () => void;
}) {
  const { theme } = useTheme();
  const { colors } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <View style={styles.iconWrap}>
          <Ionicons name="flag" size={36} color={colors.primary} />
        </View>
        <Text style={styles.title}>You&apos;ve arrived</Text>
        <Text style={styles.destination} numberOfLines={2}>
          {destination}
        </Text>
        <View style={styles.statsRow}>
          {durationMin != null && (
            <View style={styles.stat}>
              <Text style={styles.statValue}>{durationMin} min</Text>
              <Text style={styles.statLabel}>Trip time</Text>
            </View>
          )}
          <View style={styles.stat}>
            <Text style={styles.statValue}>{arrivedAt}</Text>
            <Text style={styles.statLabel}>Arrived</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.doneBtn} onPress={onDone} activeOpacity={0.85}>
          <Text style={styles.doneBtnText}>Done</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function makeStyles(t: AppTheme) {
  const { colors, typography, shadow } = t;
  return StyleSheet.create({
    screen: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 24,
      backgroundColor: colors.surface,
    },
    card: {
      width: "100%",
      alignItems: "center",
      gap: 10,
      padding: 24,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: colors.divider,
      backgroundColor: colors.card,
      ...shadow.soft,
    },
    iconWrap: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface2,
      marginBottom: 4,
    },
    title: { ...typography.title, fontWeight: "700", color: colors.ink },
    destination: { ...typography.body, color: colors.ink2, textAlign: "center" },
    statsRow: { flexDirection: "row", gap: 32, marginVertical: 8 },
    stat: { alignItems: "center", gap: 2 },
    statValue: { ...typography.title, fontWeight: "700", color: colors.ink },
    statLabel: { ...typography.body, color: colors.ink3 },
    doneBtn: {
      alignSelf: "stretch",
      alignItems: "center",
      paddingVertical: 14,
      borderRadius: 16,
      marginTop: 6,
      backgroundColor: colors.primary,
    },
    doneBtnText: { ...typography.body, fontWeight: "700", color: colors.onPrimary },
  });
}
