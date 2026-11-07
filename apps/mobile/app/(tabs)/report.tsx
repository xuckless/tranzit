import { useState, useMemo, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useTheme } from "@/contexts/ThemeContext";
import { routeStore } from "@/lib/routeStore";
import { getLastLocationFix } from "@/lib/tripWebSocket";
import {
  submitReport,
  fetchReportSummary,
  fetchRecentReports,
  summaryThanksText,
  newReportId,
  isReportKind,
  type RecentReport,
  type ReportSeverity,
} from "@/lib/reports";
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

// Severity 1..3 as stored in route_reports.
const SEVERITY_LABELS = ["A little", "Pretty bad", "Critical"];

function timeAgo(iso: string, nowMs: number): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "";
  const mins = Math.max(0, Math.round((nowMs - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

/** Transit route names of the active journey (if any), for the route picker. */
function activeRouteIds(): string[] {
  if (!routeStore.getTripSession()) return [];
  const r = routeStore.getSelectedRoute();
  const ids = (r?.legs ?? [])
    .flatMap((l) => l.steps ?? [])
    .filter((st) => st.travelMode === "TRANSIT")
    .map(
      (st) =>
        st.transitDetails?.transitLine?.nameShort ||
        st.transitDetails?.transitLine?.name,
    )
    .filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}

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

function ThankYou({ text, onReset }: { text: string; onReset: () => void }) {
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
      <Text style={styles.thankYouBody}>{text}</Text>
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
  const { colors, semantic } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [selected, setSelected] = useState<string | null>(null);
  const [severity, setSeverity] = useState(1);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanks, setThanks] = useState<string | null>(null);
  // Kept across a failed attempt so a retry upserts the same row.
  const reportIdRef = useRef<string | null>(null);

  const [routeOptions, setRouteOptions] = useState<string[]>([]);
  const [routeId, setRouteId] = useState<string | null>(null);

  const [recent, setRecent] = useState<RecentReport[] | null>(null);
  const [recentError, setRecentError] = useState(false);
  const [loadedAt, setLoadedAt] = useState(() => Date.now());

  const loadRecent = useCallback(async () => {
    try {
      const rows = await fetchRecentReports({ limit: 20 });
      setRecent(rows);
      setRecentError(false);
    } catch (e) {
      console.warn("[report] recent reports failed:", e);
      setRecentError(true);
    } finally {
      setLoadedAt(Date.now());
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ids = activeRouteIds();
      setRouteOptions(ids);
      setRouteId((cur) => (cur && ids.includes(cur) ? cur : (ids[0] ?? null)));
      void loadRecent();
    }, [loadRecent]),
  );

  const handleSend = useCallback(async () => {
    if (!selected || !isReportKind(selected) || sending) return;
    setSending(true);
    setError(null);
    try {
      if (!reportIdRef.current) reportIdRef.current = newReportId();
      const fix = getLastLocationFix();
      await submitReport({
        reportId: reportIdRef.current,
        kind: selected,
        severity: severity as ReportSeverity,
        routeId,
        lat: fix?.lat,
        lng: fix?.lng,
      });
      reportIdRef.current = null;
      let text = "Thanks — your report was sent.";
      try {
        const summary = await fetchReportSummary({ routeId, minutes: 60 });
        text = summaryThanksText(summary, routeId ? `Route ${routeId}` : null);
      } catch (e) {
        console.warn("[report] summary failed:", e);
      }
      setThanks(text);
      void loadRecent();
    } catch (e) {
      console.warn("[report] submit failed:", e);
      setError(
        e instanceof Error && /sign in/i.test(e.message)
          ? e.message
          : "Couldn't send your report. Check your connection and try again.",
      );
    } finally {
      setSending(false);
    }
  }, [selected, severity, sending, routeId, loadRecent]);

  if (thanks) {
    return (
      <ThankYou
        text={thanks}
        onReset={() => {
          setThanks(null);
          setSelected(null);
          setSeverity(1);
          setError(null);
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
            Reports are shared with other riders on the same route.
          </Text>
        </View>

        {/* Optional route — only offered while a journey is active */}
        {routeOptions.length > 0 && (
          <View style={styles.routeRow}>
            {[...routeOptions, null].map((id) => {
              const active = routeId === id;
              return (
                <TouchableOpacity
                  key={id ?? "__none__"}
                  onPress={() => setRouteId(id)}
                  activeOpacity={0.8}
                  style={[styles.severityChip, styles.routeChip, active && styles.severityChipActive]}
                >
                  <Text
                    style={[
                      styles.severityChipText,
                      active && styles.severityChipTextActive,
                    ]}
                  >
                    {id ? `Route ${id}` : "No route"}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

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

        {/* Recent reports */}
        <View style={styles.recentCard}>
          <Text style={styles.severityHeading}>Recent reports</Text>
          {recent == null && !recentError ? (
            <ActivityIndicator color={colors.ink3} />
          ) : recentError && !recent?.length ? (
            <TouchableOpacity onPress={() => void loadRecent()} activeOpacity={0.8}>
              <Text style={styles.recentEmpty}>
                Couldn&apos;t load recent reports. Tap to retry.
              </Text>
            </TouchableOpacity>
          ) : !recent?.length ? (
            <Text style={styles.recentEmpty}>No reports yet.</Text>
          ) : (
            recent.map((r) => {
              const type = REPORT_TYPES.find((t) => t.id === r.kind);
              const p = theme.colors.pastels[type?.pastel ?? "lavender"];
              const sev = SEVERITY_LABELS[Math.min(3, Math.max(1, r.severity)) - 1];
              return (
                <View key={r.report_id} style={styles.recentRow}>
                  <View style={[styles.recentIcon, { backgroundColor: p.bg }]}>
                    <ReportIcon
                      lib={type?.iconLib ?? "ionicons"}
                      name={type?.icon ?? "sparkles"}
                      size={16}
                      color={p.ink}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.recentTitle}>
                      {type?.label ?? r.kind}
                      {r.route_id ? ` · Route ${r.route_id}` : ""}
                    </Text>
                    <Text style={styles.recentMeta}>
                      {sev} · {timeAgo(r.created_at, loadedAt)}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* Send button — pinned to bottom */}
      <View style={styles.bottomBar}>
        {error && (
          <Text style={[styles.errorText, { color: semantic.danger }]}>{error}</Text>
        )}
        <TouchableOpacity
          onPress={() => void handleSend()}
          disabled={!selected || sending}
          activeOpacity={0.85}
          style={[styles.sendBtn, (!selected || sending) && styles.sendBtnDisabled]}
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.onPrimary} />
          ) : (
            <Ionicons name={error ? "refresh" : "send"} size={20} color={colors.onPrimary} />
          )}
          <Text style={styles.sendBtnText}>
            {sending
              ? "Sending…"
              : sel
                ? `${error ? "Retry" : "Send"} "${sel.label}" report`
                : "Pick what you saw"}
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

    // Route picker
    routeRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.element,
      paddingHorizontal: spacing.screen,
      paddingBottom: 14,
    },
    routeChip: { flex: 0, paddingHorizontal: 14 },

    // Recent reports
    recentCard: {
      marginHorizontal: spacing.screen,
      marginTop: 18,
      backgroundColor: colors.card,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.divider,
      padding: spacing.card,
      gap: 12,
    },
    recentEmpty: { ...typography.body, color: colors.ink3 },
    recentRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    recentIcon: {
      width: 32,
      height: 32,
      borderRadius: 10,
      justifyContent: "center",
      alignItems: "center",
    },
    recentTitle: { ...typography.subtitleStrong, color: colors.ink },
    recentMeta: { ...typography.badge, color: colors.ink3 },
    errorText: { ...typography.body, textAlign: "center", marginBottom: 8 },

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
