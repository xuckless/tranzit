import React, { memo, useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import type { Route, RouteStep } from "@/types/places";
import { useTheme } from "@/contexts/ThemeContext";
import { useRouteLiveStops } from "@/lib/routeSSE";
import { routeArrivalEpoch } from "@/lib/routeRanking";
import type { RouteSSEStop } from "@/lib/routeSSE";
import type { AppTheme } from "@/styles/themes";

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

// A chip is either a walk run (with its summed distance) or a transit step.
type ChipItem =
  | { kind: "walk"; meters: number }
  | { kind: "transit"; step: RouteStep };

// Collapse consecutive WALK steps into one chip, summing their distance so the
// chip row stays compact while still surfacing how far the rider walks.
function condense(steps: RouteStep[]): ChipItem[] {
  const out: ChipItem[] = [];
  for (const step of steps) {
    if (step.travelMode === "WALK") {
      const meters = step.distanceMeters ?? 0;
      const last = out.at(-1);
      if (last && last.kind === "walk") last.meters += meters;
      else out.push({ kind: "walk", meters });
    } else {
      out.push({ kind: "transit", step });
    }
  }
  return out;
}

// ─── Transit chip with live SSE delay ────────────────────────────────────────
// Must be a proper component to call the hook.

const TransitChipLive = memo(function TransitChipLive({
  step,
}: {
  step: RouteStep;
}) {
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
        style={[chipStyles.transitLabel, typography.badge, { color: lineColor }]}
        numberOfLines={1}
      >
        {nameShort}
      </Text>
      {delay && (
        <Text
          style={[chipStyles.chipDelay, typography.chipDelay, { color: delay.color }]}
          numberOfLines={1}
        >
          {delay.label}
        </Text>
      )}
    </View>
  );
});

// ─── Step Chips row ───────────────────────────────────────────────────────────

export const StepChips = memo(function StepChips({
  steps,
}: {
  steps: RouteStep[];
}) {
  const { theme } = useTheme();
  const { colors, semantic, typography } = theme;
  const items = useMemo(() => condense(steps), [steps]);

  return (
    <View style={chipStyles.row}>
      {items.map((item, i) => {
        // Content-based keys so re-renders never remount a chip (which would
        // tear down/reopen its live SSE subscription).
        const key =
          item.kind === "transit"
            ? `t-${item.step.transitDetails?.transitLine?.nameShort ?? ""}-${item.step.transitDetails?.stopDetails?.departureTime ?? i}`
            : `w-${i}`;
        return (
          <React.Fragment key={key}>
          {item.kind === "walk" ? (
            <View style={[chipStyles.walkChip, { backgroundColor: semantic.walkChipBg }]}>
              <FontAwesome5 name="walking" size={10} color={colors.ink3} />
              {item.meters > 0 && (
                <Text
                  style={[chipStyles.walkDist, typography.micro, { color: colors.ink3 }]}
                  numberOfLines={1}
                >
                  {formatDistance(item.meters)}
                </Text>
              )}
            </View>
          ) : (
            <TransitChipLive step={item.step} />
          )}

          {i < items.length - 1 && (
            <Ionicons name="chevron-forward" size={10} color={colors.ink3} />
          )}
        </React.Fragment>
        );
      })}
    </View>
  );
});

const chipStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
  },
  walkChip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    height: 22,
    minWidth: 22,
    borderRadius: 11,
    paddingHorizontal: 7,
  },
  walkDist: {},
  transitChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: "center",
  },
  transitLabel: {},
  chipDelay: {
    marginTop: 1,
  },
});

// ─── Single Route Card ────────────────────────────────────────────────────────

const RouteCard = memo(function RouteCard({
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
  onSelect: (route: Route) => void;
}) {
  const { theme } = useTheme();
  const { colors, typography, semantic, spacing, radii, shadow } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const allSteps = useMemo(() => route.legs.flatMap((l) => l.steps), [route]);
  const transitSteps = useMemo(
    () => allSteps.filter((s) => s.travelMode === "TRANSIT"),
    [allSteps],
  );
  const firstDept = transitSteps[0]?.transitDetails?.stopDetails?.departureTime;
  // Arrival at the destination (incl. the final walk), matching the "Fastest" ranking.
  const lastArr = useMemo(() => {
    if (!transitSteps.at(-1)?.transitDetails?.stopDetails?.arrivalTime) return undefined;
    return new Date(routeArrivalEpoch(route, Date.now() / 1000) * 1000).toISOString();
  }, [route, transitSteps]);

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
      onPress={() => onSelect(route)}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ selected: isSelected }}
      accessibilityHint="Select this route"
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
});

// A route has no server id, but its encoded polyline is always present and
// unique per geometry — a stable identity that survives filtering/reordering so
// cards (and their live SSE subscriptions) aren't remounted on every filter tap.
function routeKey(route: Route): string {
  return (
    route.polyline?.encodedPolyline ||
    `${route.duration}-${route.distanceMeters}`
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
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="git-branch-outline" size={14} color={colors.ink3} />
        <Text style={[styles.headerLabel, { color: colors.ink3 }]}>
          {routes.length} route{routes.length !== 1 ? "s" : ""} available
        </Text>
      </View>

      <BottomSheetScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.list}
      >
        {routes.map((route) => (
          <RouteCard
            key={routeKey(route)}
            route={route}
            isFastest={route === fastestRoute}
            isLeastWalking={route === leastWalkingRoute}
            isSelected={route === selectedRoute}
            onSelect={onSelectRoute}
          />
        ))}
      </BottomSheetScrollView>
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
      paddingBottom: 96,
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
