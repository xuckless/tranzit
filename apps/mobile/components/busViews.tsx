import React, { useState, useCallback, useEffect, useRef, memo } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from "react-native";
import Svg, { Circle as SvgCircle, Path, Text as SvgText } from "react-native-svg";
import { Marker, Callout } from "react-native-maps";
import { supabase } from "@/lib/supabase";
import type {
  StopTimeUpdate,
  CalgaryTransitRoute,
  CalgaryTransitStop,
} from "@/types/database";
import { theme } from "@/styles/theme";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

  // tracksViewChanges starts false. Setting it to true (even briefly) re-creates
  // the native marker view and dismisses any open callout. We only flip it to
  // update the SVG bearing arrow, and only when the callout is NOT open.
  const [tracksViewChanges, setTracksViewChanges] = useState(false);
  const prevBearingRef = useRef(bearing);
  const calloutOpenRef = useRef(false);

  useEffect(() => {
    // Skip update if callout is showing — avoids dismissing it
    if (calloutOpenRef.current) return;
    if (prevBearingRef.current === bearing) return;
    prevBearingRef.current = bearing;
    setTracksViewChanges(true);
    const t = setTimeout(() => setTracksViewChanges(false), 150);
    return () => clearTimeout(t);
  }, [bearing]);

  // ── Fetch ─────────────────────────────────────────────────────────────────
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

    // stop_id TEXT → calgary_transit_stops.teleride_number INTEGER
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

  // 30s real-time refresh — starts after first press, keeps running while
  // component is mounted so the callout always shows fresh schedule data.
  useEffect(() => {
    if (!hasFetched) return;
    const id = setInterval(fetchTripDetails, 30_000);
    return () => clearInterval(id);
  }, [hasFetched, fetchTripDetails]);

  return (
    <Marker
      coordinate={{ latitude, longitude }}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
      onPress={() => {
        calloutOpenRef.current = true;
        fetchTripDetails();
      }}
      onDeselect={() => {
        calloutOpenRef.current = false;
      }}
    >
      {/*
        Three absolute layers so only the arrow rotates while the circle
        and route label stay upright. tracksViewChanges briefly flips true
        on bearing change so the native marker image regenerates.
      */}
      <View style={s.markerContainer}>
        {/* Background circle */}
        <Svg width={36} height={36} viewBox="0 0 36 36" style={StyleSheet.absoluteFill}>
          <SvgCircle cx="18" cy="18" r="16" fill="#0058BC" stroke="white" strokeWidth="2" />
        </Svg>
        {/* Directional arrow — rotates with bearing */}
        <View style={[StyleSheet.absoluteFill, { transform: [{ rotate: `${bearing}deg` }] }]}>
          <Svg width={36} height={36} viewBox="0 0 36 36">
            <Path d="M18 4 L13 15 L18 12 L23 15 Z" fill="white" opacity={0.9} />
          </Svg>
        </View>
        {/* Route label — always upright */}
        <Svg width={36} height={36} viewBox="0 0 36 36" style={StyleSheet.absoluteFill}>
          <SvgText x="18" y="26" textAnchor="middle" fill="white" fontSize="9" fontWeight="bold">
            {route_id}
          </SvgText>
        </Svg>
      </View>

      <Callout tooltip>
        <View style={s.callout}>
          <Text style={s.calloutTitle}>Bus {route_id}</Text>
          {routeName ? (
            <Text style={s.destination} numberOfLines={1}>
              {routeName}
            </Text>
          ) : null}

          {loading ? (
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
                    style={[
                      s.sequenceDot,
                      stop.passed && s.sequenceDotPassed,
                    ]}
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

const s = StyleSheet.create({
  markerContainer: {
    width: 36,
    height: 36,
  },
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
