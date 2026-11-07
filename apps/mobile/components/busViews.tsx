import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { friendlyErrorMessage, middlewareQuery } from "@/lib/middleware";
import { getStopNamesByTelerideNumbers } from "@/lib/db";
import type { StopTimeUpdate, CalgaryTransitRoute } from "@/types/database";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtEpoch(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDelay(
  seconds: number | null,
  typography: AppTheme["typography"],
): { label: string; color: string } {
  if (seconds === null || Math.abs(seconds) < 60)
    return { label: "On Time", color: typography.delayOnTime };
  const mins = Math.round(seconds / 60);
  return {
    label: mins > 0 ? `+${mins} min` : `${Math.abs(mins)} min early`,
    color: mins > 0 ? typography.delayLate : typography.delayEarly,
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
  const { theme } = useTheme();
  const { colors, typography, semantic } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [tripStops, setTripStops] = useState<TripStop[]>([]);
  const [routeName, setRouteName] = useState<string>("");
  // Spinner only on first load; 30s refreshes update rows in place.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hasDataRef = useRef(false);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (!hasDataRef.current) setLoading(true);
    try {
      const now = Math.floor(Date.now() / 1000);

      const [stopTimes, routeRows] = await Promise.all([
        middlewareQuery<StopTimeUpdate>(
          "stop_time_updates",
          {
            trip_id: tripId,
            order_by: "stop_sequence",
            order: "ASC",
          },
          ctrl.signal,
        ),
        middlewareQuery<CalgaryTransitRoute>(
          "calgary_transit_routes",
          {
            route_short_name: routeId,
            limit: 1,
          },
          ctrl.signal,
        ),
      ]);

      if (ctrl.signal.aborted) return;
      if (routeRows[0]?.route_long_name) setRouteName(routeRows[0].route_long_name);

      const numericIds = stopTimes
        .map((s) => parseInt(s.stop_id ?? "", 10))
        .filter((n) => !isNaN(n));

      const nameMap = await getStopNamesByTelerideNumbers(numericIds);
      if (ctrl.signal.aborted) return;

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
      setError(null);
      hasDataRef.current = true;
    } catch (e) {
      if (ctrl.signal.aborted) return;
      console.warn("[bus] trip fetch failed:", e);
      setError(friendlyErrorMessage(e, "trip details"));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [tripId, routeId]);

  useEffect(() => {
    hasDataRef.current = false;
    setTripStops([]);
    setRouteName("");
    setError(null);
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [load]);

  const isEmpty = !loading && !error && tripStops.length === 0;

  return (
    <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[styles.panelHeader, { borderBottomColor: colors.border }]}>
        <View style={styles.panelHeaderLeft}>
          <View style={styles.panelIconBox}>
            <Ionicons name="bus" size={16} color={colors.primary} />
          </View>
          <View style={styles.panelTitleBlock}>
            <Text style={[styles.panelTitle, { color: colors.ink }]}>Bus {routeId}</Text>
            {routeName ? (
              <Text style={[styles.panelSub, { color: colors.ink3 }]} numberOfLines={1}>{routeName}</Text>
            ) : null}
          </View>
        </View>
        <TouchableOpacity
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Close bus details"
        >
          <Ionicons name="close-circle" size={22} color={colors.ink3} />
        </TouchableOpacity>
      </View>

      <View style={styles.panelContent}>
        {loading && tripStops.length === 0 ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : error && tripStops.length === 0 ? (
          <View style={styles.errorRow}>
            <Text style={[styles.empty, { color: colors.ink2 }]}>{error}</Text>
            <TouchableOpacity
              onPress={load}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Retry loading trip details"
            >
              <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : isEmpty ? (
          <Text style={[styles.empty, { color: colors.ink3 }]}>No schedule data</Text>
        ) : (
          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            {error && (
              <TouchableOpacity
                onPress={load}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Couldn't refresh trip. Retry"
              >
                <Text style={[styles.staleText, { color: colors.ink3 }]}>
                  Couldn&apos;t refresh — tap to retry
                </Text>
              </TouchableOpacity>
            )}
            {tripStops.map((stop) => {
              const telerideNum = parseInt(stop.stop_id, 10);
              const tappable = onStopTap && !isNaN(telerideNum);
              const delay = formatDelay(stop.arrival_delay, typography);
              return (
                <TouchableOpacity
                  key={stop.stop_sequence}
                  style={[styles.stopRow, { borderBottomColor: colors.border }, stop.passed && styles.stopRowPassed]}
                  onPress={tappable ? () => onStopTap!(telerideNum, stop.stop_name) : undefined}
                  disabled={!tappable}
                  activeOpacity={tappable ? 0.65 : 1}
                >
                  <View
                    style={[
                      styles.sequenceDot,
                      { backgroundColor: stop.passed ? colors.ink3 : colors.primary },
                    ]}
                  />
                  <View style={styles.stopInfo}>
                    <Text
                      style={[styles.stopName, { color: stop.passed ? colors.ink3 : colors.ink }]}
                      numberOfLines={1}
                    >
                      {stop.stop_name}
                    </Text>
                    <Text style={[styles.stopTime, { color: colors.ink3 }]}>
                      {fmtEpoch(stop.arrival_time)}
                    </Text>
                  </View>
                  {stop.passed ? (
                    <View style={[styles.passedPill, { backgroundColor: colors.surface2 }]}>
                      <Text style={[styles.passedPillText, { color: colors.ink3 }]}>Passed</Text>
                    </View>
                  ) : (
                    <Text style={[styles.delayLabel, { color: delay.color }]} numberOfLines={1}>
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

function makeStyles(t: AppTheme) {
  const { colors, typography, semantic, spacing, radii } = t;
  return StyleSheet.create({
    panel: {
      marginHorizontal: spacing.screen,
      marginBottom: 12,
      backgroundColor: colors.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: "hidden",
    },
    panelHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
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
      backgroundColor: colors.primaryDim,
      justifyContent: "center",
      alignItems: "center",
      flexShrink: 0,
    },
    panelTitleBlock: { flex: 1 },
    panelTitle: {
      ...typography.bodyStrong,
      color: semantic.panelTitle,
    },
    panelSub: {
      ...typography.caption,
      color: colors.ink3,
      marginTop: 1,
    },
    panelContent: {
      height: 180,
      paddingHorizontal: 12,
      paddingVertical: 6,
      justifyContent: "center",
    },

    empty: {
      ...typography.caption,
      color: colors.ink3,
      textAlign: "center",
      paddingVertical: 8,
    },
    scroll: { flex: 1 },
    errorRow: { alignItems: "center", gap: 6 },
    retryText: { ...typography.bodySmallStrong },
    staleText: { ...typography.micro, textAlign: "center", paddingVertical: 4 },

    stopRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 7,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    stopRowPassed: { opacity: 0.45 },
    sequenceDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.primary,
      flexShrink: 0,
    },
    stopInfo: { flex: 1, gap: 1 },
    stopName: {
      ...typography.captionStrong,
      color: semantic.panelTitle,
    },
    stopTime: { ...typography.monoBody, color: colors.ink3 },
    passedPill: {
      backgroundColor: colors.muted,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    passedPillText: {
      ...typography.micro,
      fontWeight: "600",
      color: colors.ink3,
    },
    delayLabel: {
      ...typography.micro,
      flexShrink: 0,
      textAlign: "right",
    },
  });
}
