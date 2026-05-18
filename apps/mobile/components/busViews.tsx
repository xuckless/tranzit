import React, { useState, useCallback, useEffect, useRef, memo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { Marker, Callout } from "react-native-maps";
import { supabase } from "@/lib/supabase";
import type {
  StopTimeUpdate,
  CalgaryTransitRoute,
  CalgaryTransitStop,
} from "@/types/database";
import { theme } from "@/styles/theme";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtEpoch(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TripStop {
  stop_sequence: number;
  stop_id: string;
  stop_name: string;
  arrival_time: number;
  passed: boolean;
}

export interface BusMarkerProps {
  vehicle_id: string;
  trip_id: string;
  route_id: string;
  latitude: number;
  longitude: number;
  bearing: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

function BusMarkerComponent({
  vehicle_id: _vehicle_id,
  trip_id,
  route_id,
  latitude,
  longitude,
  bearing,
}: BusMarkerProps) {
  const [tripStops, setTripStops] = useState<TripStop[]>([]);
  const [routeName, setRouteName] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  // Briefly enable view tracking on mount so the native layer captures the badge,
  // then freeze. Bearing changes are handled by Marker's rotation prop natively
  // and do not require tracksViewChanges to be true.
  const [tracksViewChanges, setTracksViewChanges] = useState(true);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    const t = setTimeout(() => setTracksViewChanges(false), 500);
    return () => clearTimeout(t);
  }, []);

  const fetchTripDetails = useCallback(async () => {
    setLoading(true);
    const now = Math.floor(Date.now() / 1000);

    const [{ data: rawStopTimes }, { data: rawRouteRow }] = await Promise.all([
      supabase
        .from("stop_time_updates")
        .select("*")
        .eq("trip_id", trip_id)
        .order("stop_sequence"),
      supabase
        .from("calgary_transit_routes")
        .select("*")
        .eq("route_short_name", route_id)
        .limit(1)
        .maybeSingle(),
    ]);
    const stopTimes = rawStopTimes as StopTimeUpdate[] | null;
    const routeRow = rawRouteRow as CalgaryTransitRoute | null;

    if (routeRow?.route_long_name) setRouteName(routeRow.route_long_name);

    if (!stopTimes?.length) {
      setLoading(false);
      setHasFetched(true);
      return;
    }

    // stop_id (TEXT) maps to calgary_transit_stops.teleride_number (INTEGER)
    const numericIds = stopTimes
      .map((s) => parseInt(s.stop_id ?? "", 10))
      .filter((n) => !isNaN(n));

    const { data: rawStopRows } = await supabase
      .from("calgary_transit_stops")
      .select("*")
      .in("teleride_number", numericIds);
    const stopRows = rawStopRows as CalgaryTransitStop[] | null;

    const nameMap = new Map(
      stopRows?.map((r) => [String(r.teleride_number), r.stop_name]) ?? []
    );

    setTripStops(
      stopTimes.map((s) => ({
        stop_sequence: s.stop_sequence,
        stop_id: s.stop_id ?? "",
        stop_name: nameMap.get(s.stop_id ?? "") ?? `Stop ${s.stop_id}`,
        arrival_time: s.arrival_time ?? 0,
        passed: (s.arrival_time ?? 0) < now,
      }))
    );
    setLoading(false);
    setHasFetched(true);
  }, [trip_id, route_id]);

  // Poll trip details every 30s after the callout is first opened.
  useEffect(() => {
    if (!hasFetched) return;
    const id = setInterval(fetchTripDetails, 30_000);
    return () => clearInterval(id);
  }, [hasFetched, fetchTripDetails]);

  return (
    // rotation prop rotates the entire marker (badge + arrow tip) natively —
    // no JS re-render required, so tracksViewChanges stays false after mount.
    <Marker
      coordinate={{ latitude, longitude }}
      anchor={{ x: 0.5, y: 0.7 }}
      rotation={bearing}
      tracksViewChanges={tracksViewChanges}
      onPress={fetchTripDetails}
    >
      {/* Badge — upward arrow rotates with the Marker to show travel direction */}
      <View style={s.markerWrap}>
        <View style={s.badge}>
          <Text style={s.badgeText} numberOfLines={1}>
            {route_id}
          </Text>
        </View>
        {/* Triangle arrow tip pointing up (north at bearing=0) */}
        <View style={s.arrowTip} />
      </View>

      <Callout tooltip>
        <View style={s.callout}>
          <Text style={s.calloutTitle}>Bus {route_id}</Text>
          {routeName ? (
            <Text style={s.destination} numberOfLines={1}>
              {routeName}
            </Text>
          ) : null}

          {loading && !hasFetched ? (
            <ActivityIndicator
              size="small"
              color={theme.colors.primary}
              style={s.loader}
            />
          ) : tripStops.length === 0 ? (
            <Text style={s.empty}>No schedule data</Text>
          ) : (
            <ScrollView
              style={s.scroll}
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
              onStartShouldSetResponder={() => true}
            >
              {tripStops.map((stop) => (
                <View
                  key={stop.stop_sequence}
                  style={[s.stopRow, stop.passed && s.stopRowPassed]}
                >
                  <View
                    style={[s.sequenceDot, stop.passed && s.sequenceDotPassed]}
                  />
                  <View style={s.stopInfo}>
                    <Text
                      style={[s.stopName, stop.passed && s.passedText]}
                      numberOfLines={1}
                    >
                      {stop.stop_name}
                    </Text>
                    <Text style={[s.stopTime, stop.passed && s.passedText]}>
                      {fmtEpoch(stop.arrival_time)}
                    </Text>
                  </View>
                  {stop.passed && (
                    <View style={s.passedPill}>
                      <Text style={s.passedPillText}>Passed</Text>
                    </View>
                  )}
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </Callout>
    </Marker>
  );
}

export const BusMarker = memo(BusMarkerComponent);

// ─── Styles ───────────────────────────────────────────────────────────────────

const BADGE_W = 44;

const s = StyleSheet.create({
  markerWrap: {
    alignItems: "center",
  },
  badge: {
    width: BADGE_W,
    paddingVertical: 5,
    backgroundColor: theme.colors.primary,
    borderRadius: 8,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 3,
    elevation: 4,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "800",
    color: "white",
    letterSpacing: 0.3,
  },
  // Upward-pointing triangle; Marker rotation={bearing} rotates this too
  arrowTip: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderBottomWidth: 9,
    borderStyle: "solid",
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderBottomColor: theme.colors.primary,
    transform: [{ rotate: "180deg" }], // points downward to "pin" the marker
    marginTop: -1,
  },

  // Callout
  callout: {
    width: 270,
    padding: 13,
    backgroundColor: "white",
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  calloutTitle: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  destination: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    marginTop: 2,
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

  // Stop sequence list
  scroll: {
    maxHeight: 200,
    marginTop: 4,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  stopRowPassed: {
    opacity: 0.45,
  },
  sequenceDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.primary,
    flexShrink: 0,
  },
  sequenceDotPassed: {
    backgroundColor: theme.colors.text,
  },
  stopInfo: {
    flex: 1,
    gap: 1,
  },
  stopName: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: "#1A1C1F",
  },
  stopTime: {
    fontSize: 11,
    color: theme.colors.text,
  },
  passedText: {
    color: theme.colors.text,
  },
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
});
