import React from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import type { Route, RouteStep } from "@/types/places";
import { useTheme } from "@/contexts/ThemeContext";
import { useRouteLiveStops } from "@/lib/routeSSE";
import type { RouteSSEStop } from "@/lib/routeSSE";
import type { AppTheme } from "@/styles/themes";
import { ClassicLight } from "@/styles/themes";

// ─── Helpers (exported so map.tsx can reuse them) ─────────────────────────────

export function normalizeColor(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  return c.startsWith("#") ? c : `#${c}`;
}

export function formatDuration(dur: string): string {
  const secs = parseInt(dur.replace("s", ""), 10);
  if (isNaN(secs)) return dur;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDelay(
  seconds: number,
  typography: AppTheme["typography"],
): { label: string; color: string } | null {
  if (Math.abs(seconds) < 60) return { label: "On time", color: typography.delayOnTime };
  const mins = Math.round(seconds / 60);
  return {
    label: mins > 0 ? `+${mins} min` : `${Math.abs(mins)} min early`,
    color: mins > 0 ? typography.delayLate : typography.delayEarly,
  };
}

// Collapse consecutive WALK steps into one icon so the chip row stays compact
function condense(steps: RouteStep[]): RouteStep[] {
  const out: RouteStep[] = [];
  for (const step of steps) {
    if (step.travelMode === "WALK" && out.at(-1)?.travelMode === "WALK") continue;
    out.push(step);
  }
  return out;
}

// ─── Transit chip with live SSE delay ────────────────────────────────────────
// Must be a proper component to call the hook.

function TransitChipLive({ step }: { step: RouteStep }) {
  const { theme } = useTheme();
  const { typography } = theme;
  const nameShort =
    step.transitDetails?.transitLine?.nameShort ??
    step.transitDetails?.transitLine?.name ??
    "Transit";
  const lineColor = normalizeColor(
    step.transitDetails?.transitLine?.color,
    theme.colors.primary,
  );

  const deptTimeStr = step.transitDetails?.stopDetails?.departureTime;
  const deptEpoch = deptTimeStr
    ? Math.floor(new Date(deptTimeStr).getTime() / 1000)
    : undefined;
  const deptLat =
    step.transitDetails?.stopDetails?.departureStop?.location?.latLng?.latitude;
  const deptLng =
    step.transitDetails?.stopDetails?.departureStop?.location?.latLng?.longitude;

  const liveStops = useRouteLiveStops(nameShort, deptEpoch);

  let delay: { label: string; color: string } | null = null;
  if (liveStops.size > 0 && deptLat != null && deptEpoch != null) {
    let closest: RouteSSEStop | undefined;
    let minDist = Infinity;
    for (const s of liveStops.values()) {
      const d =
        Math.abs(s.stop_lat - deptLat) +
        Math.abs(s.stop_lng - (deptLng ?? 0));
      if (d < minDist) {
        minDist = d;
        closest = s;
      }
    }
    if (closest?.departure_delay != null) {
      delay = fmtDelay(closest.departure_delay, typography);
    } else if (closest?.arrival_delay != null) {
      delay = fmtDelay(closest.arrival_delay, typography);
    } else if (closest?.departure_time != null && closest.departure_time > 0) {
      delay = fmtDelay(closest.departure_time - deptEpoch, typography);
    }
  }

  return (
    <View
      style={[
        chipStyles.transitChip,
        { backgroundColor: lineColor + "20", borderColor: lineColor },
      ]}
    >
      <Text
        style={[chipStyles.transitLabel, { color: lineColor }]}
        numberOfLines={1}
      >
        {nameShort}
      </Text>
      {delay && (
        <Text
          style={[chipStyles.chipDelay, { color: delay.color }]}
          numberOfLines={1}
        >
          {delay.label}
        </Text>
      )}
    </View>
  );
}

// ─── Step Chips row ───────────────────────────────────────────────────────────

export function StepChips({ steps }: { steps: RouteStep[] }) {
  const { theme } = useTheme();
  const { colors, semantic } = theme;
  const condensed = condense(steps);

  return (
    <View style={chipStyles.row}>
      {condensed.map((step, i) => (
        <React.Fragment key={i}>
          {step.travelMode === "WALK" ? (
            <View style={[chipStyles.walkChip, { backgroundColor: semantic.walkChipBg }]}>
              <FontAwesome5 name="walking" size={10} color={colors.ink3} />
            </View>
          ) : (
            <TransitChipLive step={step} />
          )}

          {i < condensed.length - 1 && (
            <Ionicons name="chevron-forward" size={10} color={colors.ink3} />
          )}
        </React.Fragment>
      ))}
    </View>
  );
}

const chipStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
  },
  walkChip: {
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: "center",
    alignItems: "center",
  },
  transitChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
  },
  transitLabel: {
    ...ClassicLight.typography.badge,
  },
  chipDelay: {
    ...ClassicLight.typography.chipDelay,
    marginTop: 1,
  },
});

// ─── Single Route Card ────────────────────────────────────────────────────────

function RouteCard({
  route,
  isFastest,
  isLeastWalking,
  isSelected,
  onSelect,
}: {
  route: Route;
  isFastest: boolean;
  isLeastWalking: boolean;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { theme } = useTheme();
  const { colors, typography, semantic, spacing, radii, shadow } = theme;
  const styles = makeStyles(theme);
  const allSteps = route.legs.flatMap((l) => l.steps);
  const transitSteps = allSteps.filter((s) => s.travelMode === "TRANSIT");
  const firstDept = transitSteps[0]?.transitDetails?.stopDetails?.departureTime;
  const lastArr = transitSteps.at(-1)?.transitDetails?.stopDetails?.arrivalTime;

  return (
    <TouchableOpacity
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
        isSelected && [
          styles.cardSelected,
          { backgroundColor: semantic.cardSelectedBg },
        ],
      ]}
      onPress={onSelect}
      activeOpacity={0.85}
    >
      {isFastest && (
        <View style={[styles.fastestBadge, { backgroundColor: colors.primaryDim }]}>
          <Text style={[styles.fastestText, { color: colors.primary }]}>Earliest Arrival</Text>
        </View>
      )}

      {isLeastWalking && (
        <View style={[styles.leastWalkBadge, { backgroundColor: semantic.primaryChipBlueBg }]}>
          <FontAwesome5 name="walking" size={10} color={semantic.primaryChipBlue} />
          <Text style={[styles.leastWalkText, { color: semantic.primaryChipBlue }]}>
            Least Walking
          </Text>
        </View>
      )}

      <View style={styles.cardHeader}>
        <Text
          style={[
            styles.duration,
            { color: colors.ink },
            isSelected && { color: colors.primary },
          ]}
        >
          {formatDuration(route.duration)}
        </Text>
        <Text style={[styles.distance, { color: colors.ink3 }]}>
          {formatDistance(route.distanceMeters)}
        </Text>
      </View>

      {(firstDept || lastArr) && (
        <View style={styles.timeRow}>
          {firstDept && (
            <Text style={[styles.timeText, { color: colors.ink2 }]}>{fmtTime(firstDept)}</Text>
          )}
          {firstDept && lastArr && (
            <Ionicons
              name="arrow-forward"
              size={11}
              color={colors.ink3}
            />
          )}
          {lastArr && (
            <Text style={[styles.timeText, { color: colors.ink2 }]}>{fmtTime(lastArr)}</Text>
          )}
        </View>
      )}

      <StepChips steps={allSteps} />
    </TouchableOpacity>
  );
}

// ─── Sheet ────────────────────────────────────────────────────────────────────

interface Props {
  routes: Route[];
  selectedRoute?: Route | null;
  /** The earliest-arrival route across ALL fetched routes (not just this list). */
  fastestRoute?: Route | null;
  /** The route with the minimum total walking distance across ALL fetched routes. */
  leastWalkingRoute?: Route | null;
  onSelectRoute: (route: Route) => void;
}

export function RoutePickerSheet({
  routes,
  selectedRoute,
  fastestRoute,
  leastWalkingRoute,
  onSelectRoute,
}: Props) {
  const { theme } = useTheme();
  const { colors, typography, semantic, spacing } = theme;
  const styles = makeStyles(theme);
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="git-branch-outline" size={14} color={colors.ink3} />
        <Text style={[styles.headerLabel, { color: colors.ink3 }]}>
          {routes.length} route{routes.length !== 1 ? "s" : ""} available
        </Text>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.list}
      >
        {routes.map((route, i) => (
          <RouteCard
            key={i}
            route={route}
            isFastest={route === fastestRoute}
            isLeastWalking={route === leastWalkingRoute}
            isSelected={route === selectedRoute}
            onSelect={() => onSelectRoute(route)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: AppTheme) {
  const { colors, typography, semantic, spacing, radii, shadow } = t;
  return StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: spacing.screen,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginBottom: 12,
    },
    headerLabel: {
      ...typography.captionStrong,
      color: colors.ink3,
      textTransform: "uppercase",
      letterSpacing: 0.8,
    },
    list: {
      gap: spacing.element - 2,
      paddingBottom: 12,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      paddingVertical: spacing.element + 2,
      paddingHorizontal: spacing.card - 4,
      gap: 6,
      ...shadow.card,
      shadowOpacity: 0.06,
      shadowRadius: 8,
      shadowColor: semantic.shadow,
      elevation: 2,
      borderWidth: 1.5,
      borderColor: colors.border,
    },
    cardSelected: {
      borderColor: colors.primary,
      borderWidth: 2,
      shadowColor: colors.primary,
      shadowOpacity: 0.15,
      shadowRadius: 12,
      elevation: 4,
    },
    fastestBadge: {
      alignSelf: "flex-start",
      backgroundColor: colors.primaryDim,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    fastestText: {
      ...typography.micro,
      color: colors.primary,
      letterSpacing: 0.4,
      textTransform: "uppercase",
    },
    leastWalkBadge: {
      alignSelf: "flex-start",
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    leastWalkText: {
      ...typography.micro,
      letterSpacing: 0.4,
      textTransform: "uppercase",
    },
    cardHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "baseline",
    },
    duration: {
      ...typography.cardTitle,
      color: semantic.panelTitle,
    },
    distance: {
      ...typography.bodyStrong,
      color: colors.ink3,
    },
    timeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: -4,
    },
    timeText: {
      ...typography.captionStrong,
      color: colors.ink2,
    },
  });
}
