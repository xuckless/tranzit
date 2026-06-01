import { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { middlewareQuery } from "@/lib/middleware";
import { getStopNamesByTelerideNumbers } from "@/lib/db";
import type { StopTimeUpdate, CalgaryTransitRoute } from "@/types/database";
import { theme } from "@/styles/theme";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtEpoch(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDelay(seconds: number | null): { label: string; color: string } {
  if (seconds === null || Math.abs(seconds) < 60)
    return { label: "On Time", color: "#2E7D32" };
  const mins = Math.round(seconds / 60);
  return {
    label: mins > 0 ? `+${mins} min` : `${Math.abs(mins)} min early`,
    color: mins > 0 ? theme.colors.error : "#1565C0",
  };
}

interface TripStop {
  stop_sequence: number;
  stop_id: string;
  stop_name: string;
  arrival_time: number;
  arrival_delay: number | null;
  passed: boolean;
}

// ─── BusDetailsPanel ─────────────────────────────────────────────────────────
// Rendered as a normal React View in map.tsx's bottom sheet, triggered by a
// MapLibre ShapeSource onPress event that hands us vehicleId, routeId, tripId.

interface BusDetailsPanelProps {
  vehicleId: string;
  routeId: string;
  tripId: string;
  onClose: () => void;
  onStopTap?: (telerideNumber: number, stopName: string) => void;
}

export function BusDetailsPanel({
  routeId,
  tripId,
  onClose,
  onStopTap,
}: BusDetailsPanelProps) {
  const [tripStops, setTripStops] = useState<TripStop[]>([]);
  const [routeName, setRouteName] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      const now = Math.floor(Date.now() / 1000);

      const [stopTimes, routeRows] = await Promise.all([
        middlewareQuery<StopTimeUpdate>("stop_time_updates", {
          trip_id: tripId,
          order_by: "stop_sequence",
          order: "ASC",
        }),
        middlewareQuery<CalgaryTransitRoute>("calgary_transit_routes", {
          route_short_name: routeId,
          limit: 1,
        }),
      ]);

      if (cancelled) return;
      if (routeRows[0]?.route_long_name) setRouteName(routeRows[0].route_long_name);

      const numericIds = stopTimes
        .map((s) => parseInt(s.stop_id ?? "", 10))
        .filter((n) => !isNaN(n));

      const nameMap = await getStopNamesByTelerideNumbers(numericIds);
      if (cancelled) return;

      setTripStops(
        stopTimes.map((s) => ({
          stop_sequence: s.stop_sequence,
          stop_id: s.stop_id ?? "",
          stop_name: nameMap.get(s.stop_id ?? "") ?? `Stop ${s.stop_id}`,
          arrival_time: s.arrival_time ?? 0,
          arrival_delay: s.arrival_delay ?? null,
          passed: (s.arrival_time ?? 0) < now,
        })),
      );
      setLoading(false);
    })();

    return () => { cancelled = true; };
  }, [tripId, routeId]);

  const isEmpty = !loading && tripStops.length === 0;

  return (
    <View style={s.panel}>
      <View style={s.panelHeader}>
        <View style={s.panelHeaderLeft}>
          <View style={s.panelIconBox}>
            <Ionicons name="bus" size={16} color={theme.colors.primary} />
          </View>
          <View style={s.panelTitleBlock}>
            <Text style={s.panelTitle}>Bus {routeId}</Text>
            {routeName ? (
              <Text style={s.panelSub} numberOfLines={1}>{routeName}</Text>
            ) : null}
          </View>
        </View>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="close-circle" size={22} color={theme.colors.text} />
        </TouchableOpacity>
      </View>

      <View style={s.panelContent}>
        {loading ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : isEmpty ? (
          <Text style={s.empty}>No schedule data</Text>
        ) : (
          <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>
            {tripStops.map((stop) => {
              const telerideNum = parseInt(stop.stop_id, 10);
              const tappable = onStopTap && !isNaN(telerideNum);
              const delay = fmtDelay(stop.arrival_delay);
              return (
                <TouchableOpacity
                  key={stop.stop_sequence}
                  style={[s.stopRow, stop.passed && s.stopRowPassed]}
                  onPress={tappable ? () => onStopTap!(telerideNum, stop.stop_name) : undefined}
                  disabled={!tappable}
                  activeOpacity={tappable ? 0.65 : 1}
                >
                  <View style={[s.sequenceDot, stop.passed && s.sequenceDotPassed]} />
                  <View style={s.stopInfo}>
                    <Text style={[s.stopName, stop.passed && s.passedText]} numberOfLines={1}>
                      {stop.stop_name}
                    </Text>
                    <Text style={[s.stopTime, stop.passed && s.passedText]}>
                      {fmtEpoch(stop.arrival_time)}
                    </Text>
                  </View>
                  {stop.passed ? (
                    <View style={s.passedPill}>
                      <Text style={s.passedPillText}>Passed</Text>
                    </View>
                  ) : (
                    <Text style={[s.delayLabel, { color: delay.color }]} numberOfLines={1}>
                      {delay.label}
                    </Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  panel: {
    marginHorizontal: theme.spacing.screen,
    marginBottom: 12,
    backgroundColor: "white",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  panelHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  panelIconBox: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: theme.colors.primary + "15",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  panelTitleBlock: { flex: 1 },
  panelTitle: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  panelSub: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    marginTop: 1,
  },
  panelContent: {
    height: 180,
    paddingHorizontal: 12,
    paddingVertical: 6,
    justifyContent: "center",
  },

  empty: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    textAlign: "center",
    paddingVertical: 8,
  },
  scroll: { flex: 1 },

  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  stopRowPassed: { opacity: 0.45 },
  sequenceDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.primary,
    flexShrink: 0,
  },
  sequenceDotPassed: { backgroundColor: theme.colors.text },
  stopInfo: { flex: 1, gap: 1 },
  stopName: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: "#1A1C1F",
  },
  stopTime: { fontSize: 11, color: theme.colors.text },
  passedText: { color: theme.colors.text },
  passedPill: {
    backgroundColor: theme.colors.muted,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  passedPillText: {
    fontSize: 10,
    fontWeight: "600",
    color: theme.colors.text,
  },
  delayLabel: {
    fontSize: 10,
    fontWeight: "700",
    flexShrink: 0,
    textAlign: "right",
  },
});
