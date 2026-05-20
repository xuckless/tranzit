import React, { useState, useCallback, useEffect, useRef, memo } from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import Svg, { Circle as SvgCircle, Path, Text as SvgText } from "react-native-svg";
import { Marker, Callout } from "react-native-maps";
import { supabase } from "@/lib/supabase";
import type {
  StopTimeUpdate,
  CalgaryTransitRoute,
  CalgaryTransitStop,
  VehiclePosition,
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

export interface PooledBusMarkerProps {
  vehicle: VehiclePosition | null;
}

// Inactive slots park here — off-screen enough to never clutter the map,
// but a valid coordinate so the native layer doesn't choke.
const DUMMY_COORD = { latitude: 51.070664, longitude: -114.059263 };

// ─── Component ────────────────────────────────────────────────────────────────

function PooledBusMarkerComponent({ vehicle }: PooledBusMarkerProps) {
  const [tripStops, setTripStops] = useState<TripStop[]>([]);
  const [routeName, setRouteName] = useState<string>("");
  const [loading, setLoading] = useState(false);
  // tracksViewChanges is only briefly true when bearing changes so the arrow redraws.
  const [tracksViewChanges, setTracksViewChanges] = useState(false);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const calloutOpenRef = useRef(false);
  const prevBearingRef = useRef(vehicle?.bearing ?? 0);

  const vehicleId = vehicle?.vehicle_id ?? null;
  const tripId    = vehicle?.trip_id    ?? null;
  const routeId   = vehicle?.route_id   ?? null;
  const bearing   = vehicle?.bearing    ?? 0;
  const latitude  = vehicle?.latitude   ?? DUMMY_COORD.latitude;
  const longitude = vehicle?.longitude  ?? DUMMY_COORD.longitude;

  // When this slot is reassigned to a different vehicle, wipe stale state
  // and stop any open polling so the old trip data doesn't bleed through.
  useEffect(() => {
    setTripStops([]);
    setRouteName("");
    setLoading(false);
    calloutOpenRef.current = false;
    if (pollingRef.current !== null) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, [vehicleId]);

  // Briefly flip tracksViewChanges to let the native layer re-snapshot
  // the bearing arrow — only when the callout is not open (re-snapshotting
  // while the callout is open forces it to close).
  useEffect(() => {
    if (!vehicle || calloutOpenRef.current) return;
    if (prevBearingRef.current === bearing) return;
    prevBearingRef.current = bearing;
    setTracksViewChanges(true);
    const t = setTimeout(() => setTracksViewChanges(false), 150);
    return () => clearTimeout(t);
  }, [bearing, vehicle]);

  // Stop polling on unmount
  useEffect(
    () => () => {
      if (pollingRef.current !== null) clearInterval(pollingRef.current);
    },
    [],
  );

  // ── Trip fetch ────────────────────────────────────────────────────────────
  const fetchTripDetails = useCallback(async () => {
    if (!tripId || !routeId) return;
    setLoading(true);
    const now = Math.floor(Date.now() / 1000);

    const [{ data: rawStopTimes }, { data: rawRouteRow }] = await Promise.all([
      supabase
        .from("stop_time_updates")
        .select("*")
        .eq("trip_id", tripId)
        .order("stop_sequence"),
      supabase
        .from("calgary_transit_routes")
        .select("*")
        .eq("route_short_name", routeId)
        .limit(1)
        .maybeSingle(),
    ]);
    const stopTimes = rawStopTimes as StopTimeUpdate[] | null;
    const routeRow  = rawRouteRow  as CalgaryTransitRoute | null;

    if (routeRow?.route_long_name) setRouteName(routeRow.route_long_name);

    if (!stopTimes?.length) {
      setLoading(false);
      return;
    }

    const numericIds = stopTimes
      .map((s) => parseInt(s.stop_id ?? "", 10))
      .filter((n) => !isNaN(n));

    const { data: rawStopRows } = await supabase
      .from("calgary_transit_stops")
      .select("*")
      .in("teleride_number", numericIds);
    const stopRows = rawStopRows as CalgaryTransitStop[] | null;

    const nameMap = new Map(
      stopRows?.map((r) => [String(r.teleride_number), r.stop_name]) ?? [],
    );

    setTripStops(
      stopTimes.map((s) => ({
        stop_sequence: s.stop_sequence,
        stop_id:       s.stop_id ?? "",
        stop_name:     nameMap.get(s.stop_id ?? "") ?? `Stop ${s.stop_id}`,
        arrival_time:  s.arrival_time ?? 0,
        passed:        (s.arrival_time ?? 0) < now,
      })),
    );
    setLoading(false);
  }, [tripId, routeId]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Marker
      coordinate={{ latitude, longitude }}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracksViewChanges}
      opacity={vehicle ? 1 : 0}
      onPress={
        vehicle
          ? () => {
              calloutOpenRef.current = true;
              fetchTripDetails();
              if (pollingRef.current === null) {
                pollingRef.current = setInterval(fetchTripDetails, 60_000);
              }
            }
          : undefined
      }
      onDeselect={() => {
        calloutOpenRef.current = false;
        if (pollingRef.current !== null) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }}
    >
      {/* Three layered SVGs so arrow rotates while route label stays upright */}
      <View style={s.markerContainer}>
        <Svg width={36} height={36} viewBox="0 0 36 36" style={StyleSheet.absoluteFill}>
          <SvgCircle cx="18" cy="18" r="16" fill="#0058BC" stroke="white" strokeWidth="2" />
        </Svg>
        <View
          style={[
            StyleSheet.absoluteFill,
            { transform: [{ rotate: `${bearing}deg` }] },
          ]}
        >
          <Svg width={36} height={36} viewBox="0 0 36 36">
            <Path d="M18 4 L13 15 L18 12 L23 15 Z" fill="white" opacity={0.9} />
          </Svg>
        </View>
        <Svg width={36} height={36} viewBox="0 0 36 36" style={StyleSheet.absoluteFill}>
          <SvgText
            x="18"
            y="26"
            textAnchor="middle"
            fill="white"
            fontSize="9"
            fontWeight="bold"
          >
            {routeId ?? ""}
          </SvgText>
        </Svg>
      </View>

      {/*
        Callout is ALWAYS present as a child of this Marker — removing it would
        change the Marker's child count and risk another AIRMap index crash.
        For inactive slots the callout body is a zero-size view.
      */}
      <Callout tooltip>
        {vehicle ? (
          <View style={s.callout}>
            <Text style={s.calloutTitle}>Bus {routeId}</Text>
            {routeName ? (
              <Text style={s.destination} numberOfLines={1}>
                {routeName}
              </Text>
            ) : null}

            <View style={s.contentArea}>
            {loading ? (
              <ActivityIndicator
                size="small"
                color={theme.colors.primary}
              />
            ) : tripStops.length === 0 ? (
              <Text style={s.empty}>No schedule data</Text>
            ) : (
              <ScrollView
                style={s.scroll}
                showsVerticalScrollIndicator={false}
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
          </View>
        ) : (
          // Zero-size placeholder keeps the Callout child stable in the tree
          <View style={{ width: 0, height: 0 }} />
        )}
      </Callout>
    </Marker>
  );
}

export const PooledBusMarker = memo(PooledBusMarkerComponent);

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
  empty: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    textAlign: "center",
    paddingVertical: 8,
  },
  contentArea: {
    height: 180,
    justifyContent: "center" as const,
    marginTop: 4,
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
