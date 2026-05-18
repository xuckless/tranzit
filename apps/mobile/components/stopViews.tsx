import React, { useState, useCallback, useEffect, useMemo, memo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { Marker, Callout } from "react-native-maps";
import { supabase } from "@/lib/supabase";
import type { StopTimeUpdate, TripUpdate } from "@/types/database";
import { theme } from "@/styles/theme";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// CLAUDE.md specifies: POINT(lat lng) — first value is latitude, second longitude.
function parseWKTPoint(
  wkt: string
): { latitude: number; longitude: number } | null {
  const m = wkt.match(/POINT\s*\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/i);
  if (!m) return null;
  return { latitude: parseFloat(m[1]), longitude: parseFloat(m[2]) };
}

function fmtEpoch(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDelay(seconds: number | null): { label: string; late: boolean } {
  if (seconds === null || Math.abs(seconds) < 60)
    return { label: "On Time", late: false };
  const mins = Math.round(seconds / 60);
  return {
    label: mins > 0 ? `+${mins} min late` : `${Math.abs(mins)} min early`,
    late: mins > 0,
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface UpcomingBus {
  trip_id: string;
  route_id: string;
  arrival_time: number;
  arrival_delay: number | null;
}

export interface StopMarkerProps {
  teleride_number: number;
  stop_name: string;
  point: string; // WKT: POINT(lat lng)
}

// ─── Component ────────────────────────────────────────────────────────────────

function StopMarkerComponent({
  teleride_number,
  stop_name,
  point,
}: StopMarkerProps) {
  const coordinate = useMemo(() => parseWKTPoint(point), [point]);

  const [upcoming, setUpcoming] = useState<UpcomingBus[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  // Briefly enable view tracking on mount so the native layer captures the initial
  // render, then freeze to prevent continuous re-renders while panning the map.
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracksViewChanges(false), 500);
    return () => clearTimeout(t);
  }, []);

  const fetchUpcoming = useCallback(async () => {
    setLoading(true);
    const now = Math.floor(Date.now() / 1000);

    const { data: rawStus } = await supabase
      .from("stop_time_updates")
      .select("*")
      .eq("stop_id", String(teleride_number))
      .gt("arrival_time", now)
      .order("arrival_time")
      .limit(5);
    const stus = rawStus as StopTimeUpdate[] | null;

    if (!stus?.length) {
      setLoading(false);
      setHasFetched(true);
      return;
    }

    const { data: rawTrips } = await supabase
      .from("trip_updates")
      .select("*")
      .in(
        "trip_id",
        stus.map((s) => s.trip_id)
      );
    const trips = rawTrips as TripUpdate[] | null;

    const routeMap = new Map(
      trips?.map((t) => [t.trip_id, t.route_id]) ?? []
    );

    setUpcoming(
      stus
        .filter((s) => s.arrival_time != null)
        .map((s) => ({
          trip_id: s.trip_id,
          route_id: routeMap.get(s.trip_id) ?? "—",
          arrival_time: s.arrival_time as number,
          arrival_delay: s.arrival_delay,
        }))
    );
    setLoading(false);
    setHasFetched(true);
  }, [teleride_number]);

  // Poll every 30s after the callout is first opened (hasFetched acts as the gate).
  useEffect(() => {
    if (!hasFetched) return;
    const id = setInterval(fetchUpcoming, 30_000);
    return () => clearInterval(id);
  }, [hasFetched, fetchUpcoming]);

  if (!coordinate) return null;

  return (
    <Marker
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
      onPress={fetchUpcoming}
    >
      <View style={s.dot} />

      <Callout tooltip>
        <View style={s.callout}>
          <Text style={s.calloutTitle} numberOfLines={2}>
            {stop_name}
          </Text>
          <Text style={s.calloutSub}>Stop #{teleride_number}</Text>

          {loading && !hasFetched ? (
            <ActivityIndicator
              size="small"
              color={theme.colors.primary}
              style={s.loader}
            />
          ) : upcoming.length === 0 ? (
            <Text style={s.empty}>No upcoming buses</Text>
          ) : (
            <ScrollView
              style={s.scroll}
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
              onStartShouldSetResponder={() => true}
            >
              {upcoming.map((bus) => {
                const delay = fmtDelay(bus.arrival_delay);
                return (
                  <View key={bus.trip_id} style={s.busRow}>
                    <View style={s.routeBadge}>
                      <Text style={s.routeLabel}>Bus {bus.route_id}</Text>
                    </View>
                    <Text style={s.arrivalTime}>
                      {fmtEpoch(bus.arrival_time)}
                    </Text>
                    <Text style={[s.delayLabel, delay.late && s.late]}>
                      {delay.label}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Callout>
    </Marker>
  );
}

export const StopMarker = memo(StopMarkerComponent);

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.primary,
    borderWidth: 2,
    borderColor: "white",
  },

  // Callout container
  callout: {
    width: 260,
    padding: 12,
    backgroundColor: "white",
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  calloutTitle: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: "#1A1C1F",
    marginBottom: 2,
  },
  calloutSub: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    marginBottom: 10,
  },
  loader: {
    marginVertical: 12,
  },
  empty: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    textAlign: "center",
    paddingVertical: 8,
  },

  // Bus rows inside the callout
  scroll: {
    maxHeight: 180,
  },
  busRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  routeBadge: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    minWidth: 60,
    alignItems: "center",
  },
  routeLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "white",
  },
  arrivalTime: {
    flex: 1,
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: "#1A1C1F",
  },
  delayLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#2E7D32",
  },
  late: {
    color: theme.colors.error,
  },
});
