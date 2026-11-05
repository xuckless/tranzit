import { useState, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme, PastelKey } from "@/styles/themes";

// ─── Data ─────────────────────────────────────────────────────────────────────

interface ReportType {
  id: string;
  label: string;
  pastel: PastelKey;
  iconLib: "ionicons" | "fa5" | "mci";
  icon: string;
}

const REPORT_TYPES: ReportType[] = [
  {
    id: "crowd",
    label: "Crowded",
    pastel: "sky",
    iconLib: "ionicons",
    icon: "people",
  },
  {
    id: "delay",
    label: "Delay",
    pastel: "butter",
    iconLib: "ionicons",
    icon: "time",
  },
  {
    id: "safety",
    label: "Safety",
    pastel: "rose",
    iconLib: "ionicons",
    icon: "shield",
  },
  {
    id: "vandal",
    label: "Vandalism",
    pastel: "peach",
    iconLib: "fa5",
    icon: "spray-can",
  },
  {
    id: "cons",
    label: "Construction",
    pastel: "mint",
    iconLib: "mci",
    icon: "traffic-cone",
  },
  {
    id: "other",
    label: "Other",
    pastel: "lavender",
    iconLib: "ionicons",
    icon: "sparkles",
  },
];

const SEVERITY_LABELS = ["A little", "Notable", "Pretty bad", "Critical"];

// ─── Icon helper ──────────────────────────────────────────────────────────────

function ReportIcon({
  lib,
  name,
  size,
  color,
}: {
  lib: "ionicons" | "fa5" | "fa6" | "mci";
  name: string;
  size: number;
  color: string;
}) {
  if (lib === "fa5")
    return <FontAwesome5 name={name as any} size={size} color={color} />;
  if (lib === "fa6")
    return <FontAwesome6 name={name as any} size={size} color={color} />;
  if (lib === "mci")
    return (
      <MaterialCommunityIcons name={name as any} size={size} color={color} />
    );
  return <Ionicons name={name as any} size={size} color={color} />;
}

// ─── Thank-you state ──────────────────────────────────────────────────────────

function ThankYou({ onReset }: { onReset: () => void }) {
  const { theme } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { colors } = theme;
  return (
    <ScrollView
      contentContainerStyle={styles.thankYouContainer}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.thankYouIconWrap}>
        <Ionicons name="checkmark" size={48} color={colors.primary} />
      </View>
      <Text style={styles.thankYouTitle}>Thanks for the heads up!</Text>
      <Text style={styles.thankYouBody}>
        We just told{" "}
        <Text style={{ fontWeight: "800", color: colors.ink }}>
          1,240 commuters
        </Text>{" "}
        on this line. You&apos;re a real one.
      </Text>
      <TouchableOpacity
        style={styles.secondaryBtn}
        onPress={onReset}
        activeOpacity={0.8}
      >
        <Text style={styles.secondaryBtnText}>Report something else</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ReportScreen() {
  const { theme } = useTheme();
  const { colors } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [selected, setSelected] = useState<string | null>(null);
  const [severity, setSeverity] = useState(1);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <ThankYou
        onReset={() => {
          setSent(false);
          setSelected(null);
          setSeverity(1);
        }}
      />
    );
  }

  const sel = REPORT_TYPES.find((r) => r.id === selected);

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header copy */}
        <View style={styles.headerCopy}>
          <Text style={styles.title}>What&apos;s happening?</Text>
          <Text style={styles.subtitle}>
            Your report helps{" "}
            <Text style={{ fontWeight: "800", color: colors.ink }}>
              1,240 commuters
            </Text>{" "}
            on this line right now.
          </Text>
        </View>

        {/* 2-column category grid */}
        <View style={styles.grid}>
          {REPORT_TYPES.map((r) => {
            const p = theme.colors.pastels[r.pastel];
            const active = selected === r.id;
            return (
              <TouchableOpacity
                key={r.id}
                onPress={() => setSelected(r.id)}
                activeOpacity={0.85}
                style={[styles.gridCard, active && styles.gridCardActive]}
              >
                <View style={[styles.gridIcon, { backgroundColor: p.bg }]}>
                  <ReportIcon
                    lib={r.iconLib}
                    name={r.icon}
                    size={22}
                    color={p.ink}
                  />
                </View>
                <Text
                  style={[styles.gridLabel, active && styles.gridLabelActive]}
                >
                  {r.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Severity stepper — only visible after selection */}
        {selected && (
          <View style={styles.severityCard}>
            <Text style={styles.severityHeading}>
              How {selected === "safety" ? "urgent" : "bad"}?
            </Text>
            <View style={styles.severityRow}>
              {SEVERITY_LABELS.map((label, i) => {
                const active = severity === i + 1;
                return (
                  <TouchableOpacity
                    key={i}
                    onPress={() => setSeverity(i + 1)}
                    activeOpacity={0.8}
                    style={[
                      styles.severityChip,
                      active && styles.severityChipActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.severityChipText,
                        active && styles.severityChipTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}
      </ScrollView>

      {/* Send button — pinned to bottom */}
      <View style={styles.bottomBar}>
        <TouchableOpacity
          onPress={() => selected && setSent(true)}
          activeOpacity={0.85}
          style={[styles.sendBtn, !selected && styles.sendBtnDisabled]}
        >
          <Ionicons name="send" size={20} color={colors.onPrimary} />
          <Text style={styles.sendBtnText}>
            {sel ? `Send "${sel.label}" report` : "Pick what you saw"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: AppTheme) {
  const { colors, typography, semantic, spacing, radii, shadow } = t;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface },
    scroll: { flex: 1 },
    scrollContent: { paddingBottom: 28 },

    headerCopy: {
      paddingHorizontal: spacing.screen,
      paddingTop: 8,
      paddingBottom: 20,
    },
    title: {
      ...typography.display,
      color: colors.ink,
      marginBottom: 8,
    },
    subtitle: {
      ...typography.bodyMedium,
      color: colors.ink2,
      lineHeight: 22,
    },

    // Category grid
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      paddingHorizontal: spacing.screen,
      gap: 10,
    },
    gridCard: {
      width: "47.5%",
      backgroundColor: colors.card,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.divider,
      padding: spacing.card,
      gap: 12,
      ...shadow.soft,
    },
    gridCardActive: {
      borderWidth: 2,
      borderColor: colors.primary,
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.12,
      shadowRadius: 16,
      elevation: 4,
    },
    gridIcon: {
      width: 44,
      height: 44,
      borderRadius: 14,
      justifyContent: "center",
      alignItems: "center",
    },
    gridLabel: {
      ...typography.subtitle,
      fontWeight: "800",
      color: colors.ink,
      letterSpacing: -0.2,
    },
    gridLabelActive: {
      color: colors.primary,
    },

    // Severity
    severityCard: {
      marginHorizontal: spacing.screen,
      marginTop: 14,
      backgroundColor: colors.card,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.divider,
      padding: spacing.card,
      gap: 12,
    },
    severityHeading: {
      ...typography.micro,
      color: colors.ink3,
      letterSpacing: 1.4,
      textTransform: "uppercase",
    },
    severityRow: {
      flexDirection: "row",
      gap: spacing.element,
    },
    severityChip: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 14,
      borderWidth: 1.5,
      borderColor: colors.divider,
      backgroundColor: colors.card,
      alignItems: "center",
    },
    severityChipActive: {
      borderColor: colors.primary,
      backgroundColor: colors.primaryDim,
    },
    severityChipText: {
      ...typography.badge,
      color: colors.ink2,
    },
    severityChipTextActive: {
      color: colors.primaryInk,
    },

    // Bottom bar
    bottomBar: {
      paddingHorizontal: spacing.screen,
      paddingTop: 12,
      paddingBottom: 16,
      borderTopWidth: 1,
      borderTopColor: colors.divider,
      backgroundColor: colors.surface,
    },
    sendBtn: {
      backgroundColor: colors.primary,
      borderRadius: radii.button,
      height: 54,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.element,
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.25,
      shadowRadius: 12,
      elevation: 5,
    },
    sendBtnDisabled: {
      opacity: 0.4,
      shadowOpacity: 0,
      elevation: 0,
    },
    sendBtnText: {
      color: colors.onPrimary,
      ...typography.metaLg,
      letterSpacing: -0.2,
    },

    // Thank-you
    thankYouContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 28,
      paddingTop: 60,
      gap: 0,
      backgroundColor: colors.surface,
    },
    thankYouIconWrap: {
      width: 100,
      height: 100,
      borderRadius: 32,
      backgroundColor: colors.primaryDim,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 22,
    },
    thankYouTitle: {
      ...typography.display,
      letterSpacing: -0.6,
      textAlign: "center",
      color: colors.ink,
      marginBottom: 12,
    },
    thankYouBody: {
      ...typography.buttonLg,
      color: colors.ink2,
      textAlign: "center",
      lineHeight: 24,
      maxWidth: 290,
      marginBottom: 28,
    },
    secondaryBtn: {
      height: 50,
      paddingHorizontal: 20,
      borderRadius: radii.button,
      borderWidth: 1.5,
      borderColor: colors.divider,
      backgroundColor: colors.card,
      alignItems: "center",
      justifyContent: "center",
    },
    secondaryBtnText: {
      ...typography.subtitleStrong,
      color: colors.ink,
    },
  });
}
