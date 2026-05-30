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
import { theme } from "@/styles/theme";
import { useRouteLiveStops } from "@/lib/routeSSE";
import type { RouteSSEStop } from "@/lib/routeSSE";

// ─── Helpers (exported so map.tsx can reuse them) ─────────────────────────────

export function normalizeColor(c: string | undefined): string {
  if (!c) return theme.colors.primary;
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

function fmtDelay(seconds: number): { label: string; color: string } | null {
  if (Math.abs(seconds) < 60) return { label: "On time", color: "#2E7D32" };
  const mins = Math.round(seconds / 60);
  return {
    label: mins > 0 ? `+${mins} min` : `${Math.abs(mins)} min early`,
    color: mins > 0 ? "#C62828" : "#1565C0",
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
  const nameShort =
    step.transitDetails?.transitLine?.nameShort ??
    step.transitDetails?.transitLine?.name ??
    "Transit";
  const lineColor = normalizeColor(step.transitDetails?.transitLine?.color);

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
    if (closest?.departure_time != null) {
      delay = fmtDelay(closest.departure_time - deptEpoch);
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
  const condensed = condense(steps);

  return (
    <View style={chipStyles.row}>
      {condensed.map((step, i) => (
        <React.Fragment key={i}>
          {step.travelMode === "WALK" ? (
            <View style={chipStyles.walkChip}>
              <FontAwesome5 name="walking" size={10} color="#757575" />
            </View>
          ) : (
            <TransitChipLive step={step} />
          )}

          {i < condensed.length - 1 && (
            <Ionicons name="chevron-forward" size={10} color="#BDBDBD" />
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
    backgroundColor: "#F0F0F0",
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
    fontSize: 11,
    fontWeight: "700",
  },
  chipDelay: {
    fontSize: 9,
    fontWeight: "700",
    marginTop: 1,
  },
});

// ─── Single Route Card ────────────────────────────────────────────────────────

function RouteCard({
  route,
  index,
  isSelected,
  onSelect,
}: {
  route: Route;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const allSteps = route.legs.flatMap((l) => l.steps);
  const transitSteps = allSteps.filter((s) => s.travelMode === "TRANSIT");
  const firstDept = transitSteps[0]?.transitDetails?.stopDetails?.departureTime;
  const lastArr = transitSteps.at(-1)?.transitDetails?.stopDetails?.arrivalTime;
  const isFastest = index === 0;

  return (
    <TouchableOpacity
      style={[styles.card, isSelected && styles.cardSelected]}
      onPress={onSelect}
      activeOpacity={0.85}
    >
      {isFastest && (
        <View style={styles.fastestBadge}>
          <Text style={styles.fastestText}>Fastest</Text>
        </View>
      )}

      <View style={styles.cardHeader}>
        <Text
          style={[styles.duration, isSelected && { color: theme.colors.primary }]}
        >
          {formatDuration(route.duration)}
        </Text>
        <Text style={styles.distance}>
          {formatDistance(route.distanceMeters)}
        </Text>
      </View>

      {(firstDept || lastArr) && (
        <View style={styles.timeRow}>
          {firstDept && (
            <Text style={styles.timeText}>{fmtTime(firstDept)}</Text>
          )}
          {firstDept && lastArr && (
            <Ionicons
              name="arrow-forward"
              size={11}
              color={theme.colors.text}
            />
          )}
          {lastArr && (
            <Text style={styles.timeText}>{fmtTime(lastArr)}</Text>
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
  onSelectRoute: (route: Route) => void;
}

export function RoutePickerSheet({ routes, selectedRoute, onSelectRoute }: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="git-branch-outline" size={14} color={theme.colors.text} />
        <Text style={styles.headerLabel}>
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
            index={i}
            isSelected={route === selectedRoute}
            onSelect={() => onSelectRoute(route)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: theme.spacing.screen,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 12,
  },
  headerLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "700",
    color: theme.colors.text,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  list: {
    gap: theme.spacing.element,
    paddingBottom: 12,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: theme.spacing.card,
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
    borderWidth: 1.5,
    borderColor: theme.colors.border,
  },
  cardSelected: {
    borderColor: theme.colors.primary,
    borderWidth: 2,
    shadowColor: theme.colors.primary,
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 4,
    backgroundColor: "#F5F8FF",
  },
  fastestBadge: {
    alignSelf: "flex-start",
    backgroundColor: theme.colors.primary + "15",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  fastestText: {
    fontSize: 10,
    fontWeight: "700",
    color: theme.colors.primary,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  duration: {
    fontSize: 24,
    fontWeight: "800",
    color: "#1A1C1F",
  },
  distance: {
    fontSize: theme.fontSize.body,
    fontWeight: "600",
    color: theme.colors.text,
  },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: -4,
  },
  timeText: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
  },
});
