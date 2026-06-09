import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Animated,
} from "react-native";
import {
  Map,
  Camera,
  UserLocation,
  GeoJSONSource,
  Layer,
  Images,
  type CameraRef,
} from "@maplibre/maplibre-react-native";
import { useVehicles, vehiclesToGeoJSON } from "@/lib/vehicleSSE";
import { useTripWebSocket } from "@/lib/tripWebSocket";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import { useTheme } from "@/contexts/ThemeContext";
import { routeStore } from "@/lib/routeStore";
import { parseRoute } from "@/lib/routeParser";
import { decodePolyline } from "@/utils/decodePolyline";
import { normalizeColor } from "@/components/routes/RoutePickerSheet";
import { scheduleBoarding, cancelBoarding } from "@/lib/boardingNotifications";
import {
  startTripActivity,
  updateTripActivity,
  endTripActivity,
} from "@/lib/liveActivity";
import type { Route } from "@/types/places";
import type {
  ServerStopStatus,
  TripStateMsg,
  TripSnapshotMsg,
} from "@/types/trip";
import type { AppTheme, PastelKey } from "@/styles/themes";

const ROUTE_SAVE_URL = process.env.EXPO_PUBLIC_ROUTE_SAVE_URL ?? "";
const CALGARY_CENTER: [number, number] = [-114.0719, 51.0447];
const MIN_MARKER_ZOOM = 12;

// ─── Types ────────────────────────────────────────────────────────────────────

type ConnectorType = "solid-gray" | "solid-primary" | "dashed" | "none";

interface ReportType {
  id: string;
  label: string;
  pastel: PastelKey;
  iconLib: "ionicons" | "fa5" | "fa6" | "mci";
  icon: string;
}

type CommuteStopStatus =
  | "departed"
  | "current"
  | "upcoming"
  | "destination"
  | "missed"
  | "unsure";

interface CommuteStop {
  id: string;
  name: string;
  time?: string;
  status: CommuteStopStatus;
  coordinate?: { latitude: number; longitude: number };
  mode: "WALK" | "TRANSIT";
  transitName?: string;
  transitColor?: string;
  timeRemaining?: number;
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

const SEVERITY_LABELS = ["A little", "Notable", "Pretty bad", "Critical"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function safeDecodePolyline(
  encoded: string,
): { latitude: number; longitude: number }[] {
  if (!encoded) return [];
  try {
    return decodePolyline(encoded);
  } catch {
    return [];
  }
}

function parseDurationSecs(duration: string): number | null {
  const secs = parseInt(duration?.replace("s", "") ?? "", 10);
  return isNaN(secs) ? null : secs;
}

function serverStatusToLocal(s: ServerStopStatus): CommuteStopStatus {
  switch (s) {
    case "ACTIVE":
      return "current";
    case "COMPLETED":
      return "departed";
    case "UNSURE":
      return "unsure";
    case "MISSED":
      return "missed";
    default:
      return "upcoming";
  }
}

function formatEta(eta: number): string {
  if (eta <= 0) return "";
  return new Date(eta * 1000).toLocaleTimeString("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatTimeDelta(secs: number): string {
  const mins = Math.round(Math.abs(secs) / 60);
  if (secs > 60) return `+${mins} min`;
  if (secs < -60) return `-${mins} min`;
  return "On time";
}

// ─── DashedConnector ─────────────────────────────────────────────────────────

function DashedConnector({ color }: { color: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", marginTop: 3 }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <View
          key={i}
          style={{
            width: 2,
            height: 4,
            backgroundColor: color,
            marginBottom: 3,
            borderRadius: 1,
          }}
        />
      ))}
    </View>
  );
}

// ─── ReportIcon ───────────────────────────────────────────────────────────────

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

// ─── STOP ITEM ────────────────────────────────────────────────────────────────

function StopItem({
  stop,
  connectorType,
}: {
  stop: CommuteStop;
  connectorType: ConnectorType;
}) {
  const { theme } = useTheme();
  const { colors, typography, semantic, mapPaint } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const isDeparted = stop.status === "departed";
  const isCurrent = stop.status === "current";
  const isDestination = stop.status === "destination";
  const isMissed = stop.status === "missed";
  const isUnsure = stop.status === "unsure";

  const pulseScale = useRef(new Animated.Value(0.85)).current;
  const pulseOpacity = useRef(new Animated.Value(0.7)).current;

  useEffect(() => {
    if (!isCurrent && !isUnsure) return;
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(pulseScale, {
            toValue: 1.6,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseScale, {
            toValue: 0.85,
            duration: 1000,
            useNativeDriver: true,
          }),
        ]),
        Animated.sequence([
          Animated.timing(pulseOpacity, {
            toValue: 0,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseOpacity, {
            toValue: 0.7,
            duration: 1000,
            useNativeDriver: true,
          }),
        ]),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isCurrent, isUnsure, pulseScale, pulseOpacity]);

  // Semantic colors carry meaning — pulled from theme.semantic.
  const dotRingColor = isUnsure ? semantic.warning : colors.primary;
  const dotColor = isUnsure ? semantic.warning : colors.primary;
  const connectorMuted = colors.divider;

  return (
    <View style={styles.stopRow}>
      <View style={styles.stopTimelineCol}>
        {isCurrent || isUnsure ? (
          <View style={styles.currentDotContainer}>
            <Animated.View
              style={[
                styles.currentDotRing,
                {
                  transform: [{ scale: pulseScale }],
                  opacity: pulseOpacity,
                  backgroundColor: dotRingColor,
                },
              ]}
            />
            <View
              style={[
                styles.currentDot,
                { backgroundColor: dotColor, borderColor: colors.card },
              ]}
            >
              <View
                style={[
                  styles.currentDotCore,
                  { backgroundColor: colors.card },
                ]}
              />
            </View>
          </View>
        ) : isDeparted || isMissed ? (
          <View
            style={[
              styles.departedDot,
              { backgroundColor: colors.surface2, borderColor: connectorMuted },
              isMissed && {
                borderColor: semantic.danger,
                backgroundColor: semantic.warningBg,
              },
            ]}
          >
            {isMissed ? (
              <Ionicons name="close" size={11} color={semantic.danger} />
            ) : (
              <Ionicons name="checkmark" size={11} color={colors.ink2} />
            )}
          </View>
        ) : isDestination ? (
          <View
            style={[
              styles.destinationDot,
              { backgroundColor: colors.card, borderColor: connectorMuted },
            ]}
          >
            <View
              style={[
                styles.destinationDotCore,
                { backgroundColor: connectorMuted },
              ]}
            />
          </View>
        ) : (
          <View
            style={[
              styles.upcomingDot,
              { backgroundColor: colors.card, borderColor: connectorMuted },
            ]}
          />
        )}

        {connectorType !== "none" &&
          (connectorType === "dashed" ? (
            <DashedConnector color={semantic.neutralLine} />
          ) : (
            <View
              style={[
                styles.connectorSolid,
                {
                  backgroundColor:
                    connectorType === "solid-primary"
                      ? colors.primary
                      : connectorMuted,
                },
              ]}
            />
          ))}
      </View>

      <View
        style={[
          styles.stopContentOuter,
          isCurrent && [
            styles.stopContentOuterCurrent,
            {
              backgroundColor: colors.primaryDim + "55",
              borderLeftColor: colors.primary,
            },
          ],
          isUnsure && {
            backgroundColor: semantic.warningBg + "55",
            borderLeftColor: semantic.warning,
          },
        ]}
      >
        {isCurrent || isUnsure ? (
          <>
            <View style={styles.stopRowInner}>
              <Text
                style={[
                  styles.currentStopName,
                  { color: isUnsure ? semantic.warningInk : colors.primary },
                ]}
                numberOfLines={1}
              >
                {stop.name}
              </Text>
              {stop.time && (
                <Text
                  style={[
                    styles.stopTimeText,
                    { color: isUnsure ? semantic.warningInk : colors.primary },
                  ]}
                >
                  {stop.time}
                </Text>
              )}
            </View>
            <View
              style={[styles.currentStopChip, isUnsure && styles.unsureChip]}
            >
              <Text
                style={[
                  styles.currentStopChipText,
                  { color: isUnsure ? semantic.warningInk : colors.ink2 },
                ]}
              >
                {isUnsure
                  ? `${stop.transitName ? `${stop.transitName} · ` : ""}Confirm Boarding?`
                  : `${stop.transitName ? `${stop.transitName} · ` : ""}Current Stop`}
              </Text>
            </View>
            {stop.timeRemaining !== undefined && (
              <View style={styles.stopMetaRow}>
                <Text
                  style={[
                    styles.stopTimeDelta,
                    {
                      color:
                        stop.timeRemaining > 60
                          ? colors.primary
                          : stop.timeRemaining < -60
                            ? colors.ink2
                            : semantic.success,
                    },
                  ]}
                >
                  {formatTimeDelta(stop.timeRemaining)}
                </Text>
              </View>
            )}
          </>
        ) : (
          <>
            <View style={styles.stopRowInner}>
              <Text
                style={[
                  styles.stopName,
                  { color: colors.ink2 },
                  (isDeparted || isMissed) && { opacity: 0.6 },
                  isMissed && { color: semantic.danger, opacity: 1 },
                  isDestination && styles.stopNameDestination,
                  isDestination && { color: colors.ink },
                ]}
                numberOfLines={1}
              >
                {stop.name}
              </Text>
              {stop.time && (
                <Text
                  style={[
                    styles.stopTimeText,
                    { color: colors.ink2 },
                    (isDeparted || isMissed) && { opacity: 0.5 },
                  ]}
                >
                  {stop.time}
                </Text>
              )}
            </View>
            {isDestination && (
              <Text
                style={[
                  styles.destinationLabel,
                  { color: colors.ink3, opacity: 0.6 },
                ]}
              >
                Final Destination
              </Text>
            )}
            {isMissed && (
              <Text style={[styles.missedLabel, { color: semantic.danger }]}>
                Missed
              </Text>
            )}
            {stop.mode === "TRANSIT" &&
              (stop.transitName || stop.timeRemaining !== undefined) && (
                <View style={styles.stopMetaRow}>
                  {stop.transitName && (
                    <View
                      style={[
                        styles.stopRouteBadge,
                        {
                          backgroundColor: colors.surface2,
                          borderColor: colors.divider,
                        },
                      ]}
                    >
                      <Ionicons
                        name="bus-outline"
                        size={10}
                        color={colors.ink2}
                      />
                      <Text
                        style={[
                          styles.stopRouteBadgeText,
                          { color: colors.ink2 },
                        ]}
                      >
                        {stop.transitName}
                      </Text>
                    </View>
                  )}
                  {stop.timeRemaining !== undefined && (
                    <Text
                      style={[
                        styles.stopTimeDelta,
                        {
                          color:
                            stop.timeRemaining > 60
                              ? colors.primary
                              : stop.timeRemaining < -60
                                ? colors.ink2
                                : semantic.success,
                        },
                      ]}
                    >
                      {formatTimeDelta(stop.timeRemaining)}
                    </Text>
                  )}
                </View>
              )}
          </>
        )}
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function CommuteScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { colors, typography, semantic, spacing, radii, shadow, mapPaint } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [reportSelected, setReportSelected] = useState<string | null>(null);
  const [reportSeverity, setReportSeverity] = useState(1);
  const [reportSent, setReportSent] = useState(false);
  const cameraRef = useRef<CameraRef>(null);

  const [route, setRoute] = useState<Route | null>(null);
  const [destinationInfo, setDestinationInfo] = useState<{
    label: string;
    lat: number;
    lng: number;
  } | null>(null);
  const [originInfo, setOriginInfo] = useState<{
    label: string;
    lat: number;
    lng: number;
  } | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [wsPath, setWsPath] = useState<string | null>(null);

  const [notifyBanner, setNotifyBanner] = useState<string | null>(null);
  const [boardingConfirmStop, setBoardingConfirmStop] = useState<string | null>(
    null,
  );
  const [boardingConfirmMsg, setBoardingConfirmMsg] = useState<string | null>(
    null,
  );
  const [pendingReroute, setPendingReroute] = useState(false);

  const [userLocation, setUserLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);

  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  const lastLocationSentRef = useRef<number>(0);

  const boardingConfirmStopRef = useRef<string | null>(null);
  const tripStateRef = useRef<TripStateMsg | null>(null);
  const activityStartedRef = useRef(false);

  const allVehicles = useVehicles();

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const {
    tripState,
    lastReroute,
    lastNotify,
    isConnected,
    sendLocation,
    sendUnsureResponse,
    disconnect,
  } = useTripWebSocket(wsPath);

  // ── Load from routeStore on focus ─────────────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      const storedRoute = routeStore.getSelectedRoute();
      const storedDest = routeStore.getDestination();
      const storedOrigin = routeStore.getOrigin();
      const storedSession = routeStore.getTripSession();

      setRoute(storedRoute);
      if (storedDest) setDestinationInfo(storedDest);
      if (storedOrigin) setOriginInfo(storedOrigin);
      if (storedSession) {
        setSessionId(storedSession.sessionId);
        setWsPath(storedSession.wsUrl);
      }
      if (storedRoute) {
        setReportSelected(null);
        setReportSeverity(1);
        setReportSent(false);
        activityStartedRef.current = false;
      }
    }, []),
  );

  useEffect(() => {
    boardingConfirmStopRef.current = boardingConfirmStop;
  }, [boardingConfirmStop]);
  useEffect(() => {
    tripStateRef.current = tripState;
    if (tripState)
      console.log(
        "[routeSave] STATE response:",
        JSON.stringify(tripState, null, 2),
      );
  }, [tripState]);

  useEffect(() => {
    if (!lastNotify) return;
    if (lastNotify.requires_response) {
      const matchingStop = tripStateRef.current?.stops.find(
        (s) => s.stop_id === lastNotify.stop_id,
      );
      const stopName = matchingStop?.stop_name ?? lastNotify.stop_id;
      setBoardingConfirmStop(lastNotify.stop_id);
      setBoardingConfirmMsg(
        lastNotify.message || `Did you board at ${stopName}?`,
      );
      if (sessionId) {
        scheduleBoarding(lastNotify.stop_id, stopName, sessionId);
      }
    } else {
      setNotifyBanner(lastNotify.message);
    }
  }, [lastNotify, sessionId]);

  useEffect(() => {
    if (!tripState || boardingConfirmStopRef.current) return;
    const unsure = tripState.stops.find((s) => s.status === "UNSURE");
    if (!unsure) return;
    setBoardingConfirmStop(unsure.stop_id);
    setBoardingConfirmMsg(`Did you board at ${unsure.stop_name}?`);
    if (sessionId) {
      scheduleBoarding(unsure.stop_id, unsure.stop_name, sessionId);
    }
  }, [tripState, sessionId]);

  useEffect(() => {
    if (!lastReroute) return;
    setPendingReroute(true);
  }, [lastReroute]);

  useEffect(() => {
    if (!boardingConfirmStop || !tripState) return;
    const stop = tripState.stops.find((s) => s.stop_id === boardingConfirmStop);
    if (!stop || stop.status !== "UNSURE") {
      cancelBoarding(boardingConfirmStop);
      setBoardingConfirmStop(null);
      setBoardingConfirmMsg(null);
    }
  }, [tripState, boardingConfirmStop]);

  useEffect(() => {
    if (!route) return;
    let cancelled = false;

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled || status !== "granted") return;

        const sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            distanceInterval: 10,
            timeInterval: 3000,
          },
          ({ coords }) => {
            setUserLocation({
              latitude: coords.latitude,
              longitude: coords.longitude,
            });
            if (coords.speed != null && coords.speed >= 0) {
              setCurrentSpeed(Math.round(coords.speed * 3.6));
            }

            const now = Date.now();
            if (now - lastLocationSentRef.current >= 5000) {
              lastLocationSentRef.current = now;
              sendLocation(
                coords.latitude,
                coords.longitude,
                coords.speed ?? 0,
                coords.heading ?? 0,
              );
            }
          },
        );

        if (cancelled) {
          sub.remove();
          return;
        }
        locationSubRef.current = sub;
      } catch (e) {
        console.error("[commute] GPS subscription failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      locationSubRef.current?.remove();
      locationSubRef.current = null;
    };
  }, [route, sendLocation]);

  const transitRouteIds = useMemo(() => {
    if (tripState?.stops?.length) {
      const ids = tripState.stops.map((s) => s.route_id).filter(Boolean);
      return [...new Set(ids)];
    }
    if (!route) return [];
    const ids = (route.legs ?? [])
      .flatMap((l) => l.steps ?? [])
      .filter((s) => s.travelMode === "TRANSIT")
      .map(
        (s) =>
          s.transitDetails?.transitLine?.nameShort ||
          s.transitDetails?.transitLine?.name,
      )
      .filter((id): id is string => Boolean(id));
    return [...new Set(ids)];
  }, [tripState, route]);

  const routeVehicles = useMemo(
    () =>
      transitRouteIds.length === 0
        ? []
        : allVehicles.filter(
            (v) => v.route_id != null && transitRouteIds.includes(v.route_id),
          ),
    [allVehicles, transitRouteIds],
  );

  const vehiclesGeoJSON = useMemo(
    () => vehiclesToGeoJSON(routeVehicles),
    [routeVehicles],
  );

  const routeStopsGeoJSON = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: (tripState?.stops ?? []).map((s) => ({
        type: "Feature" as const,
        properties: { stop_id: s.stop_id, status: s.status },
        geometry: {
          type: "Point" as const,
          coordinates: [s.lng, s.lat] as [number, number],
        },
      })),
    }),
    [tripState],
  );

  const stops = useMemo((): CommuteStop[] => {
    const originLabel = originInfo?.label ?? "Your Location";
    const destLabel = destinationInfo?.label ?? "Destination";

    if (!tripState?.stops?.length) {
      return [
        { id: "origin", name: originLabel, status: "departed", mode: "WALK" },
        {
          id: "destination",
          name: destLabel,
          status: "destination",
          mode: "WALK",
        },
      ];
    }

    const serverStops: CommuteStop[] = tripState.stops.map((s) => ({
      id: s.stop_id,
      name: s.stop_name,
      status: serverStatusToLocal(s.status),
      time: formatEta(s.eta),
      coordinate: { latitude: s.lat, longitude: s.lng },
      mode: "TRANSIT",
      transitName: s.route_id || undefined,
      timeRemaining: s.eta > 0 ? s.time_remaining_s : undefined,
    }));

    return [
      { id: "origin", name: originLabel, status: "departed", mode: "WALK" },
      ...serverStops,
      {
        id: "destination",
        name: destLabel,
        status: "destination",
        mode: "WALK",
      },
    ];
  }, [tripState, originInfo, destinationInfo]);

  useEffect(() => {
    if (!route?.polyline?.encodedPolyline) return;
    const coords = safeDecodePolyline(route.polyline.encodedPolyline);
    if (coords.length === 0) return;

    const lats = coords.map((c) => c.latitude);
    const lngs = coords.map((c) => c.longitude);
    const bounds: [number, number, number, number] = [
      Math.min(...lngs),
      Math.min(...lats),
      Math.max(...lngs),
      Math.max(...lats),
    ];

    setTimeout(() => {
      cameraRef.current?.fitBounds(bounds, {
        duration: 800,
        padding: { top: 20, right: 20, bottom: 20, left: 20 },
      });
    }, 400);
  }, [route]);

  const routePolylinesGeoJSON = useMemo(() => {
    if (!route?.polyline?.encodedPolyline) {
      return { type: "FeatureCollection" as const, features: [] };
    }
    const allCoords = safeDecodePolyline(route.polyline.encodedPolyline);
    if (allCoords.length === 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }

    const currentStop = stops.find((s) => s.status === "current");
    let splitIdx = 0;

    if (currentStop?.coordinate) {
      let minDist = Infinity;
      allCoords.forEach((c, i) => {
        const d = haversineMeters(
          currentStop.coordinate!.latitude,
          currentStop.coordinate!.longitude,
          c.latitude,
          c.longitude,
        );
        if (d < minDist) {
          minDist = d;
          splitIdx = i;
        }
      });
    }

    const transitStep = (route.legs ?? [])
      .flatMap((l) => l.steps ?? [])
      .find((s) => s.travelMode === "TRANSIT");
    const lineColor = normalizeColor(
      transitStep?.transitDetails?.transitLine?.color,
      colors.primary,
    );

    const completed = allCoords.slice(0, splitIdx + 1);
    const remaining = allCoords.slice(splitIdx);

    const features: Array<{
      type: "Feature";
      properties: { color: string };
      geometry: { type: "LineString"; coordinates: [number, number][] };
    }> = [];

    if (completed.length > 1) {
      features.push({
        type: "Feature",
        properties: { color: mapPaint.polyline.completed },
        geometry: {
          type: "LineString",
          coordinates: completed.map((c) => [c.longitude, c.latitude]),
        },
      });
    }
    if (remaining.length > 1) {
      features.push({
        type: "Feature",
        properties: { color: lineColor },
        geometry: {
          type: "LineString",
          coordinates: remaining.map((c) => [c.longitude, c.latitude]),
        },
      });
    }

    return { type: "FeatureCollection" as const, features };
  }, [route, stops, mapPaint.polyline.completed, colors.primary]);

  const timelineStopsGeoJSON = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: stops
        .filter((s) => s.coordinate)
        .map((s) => ({
          type: "Feature" as const,
          properties: { status: s.status },
          geometry: {
            type: "Point" as const,
            coordinates: [s.coordinate!.longitude, s.coordinate!.latitude] as [
              number,
              number,
            ],
          },
        })),
    }),
    [stops],
  );

  useEffect(() => {
    if (!tripState?.stops?.length) return;

    const activeIdx = tripState.stops.findIndex(
      (s) => s.status === "ACTIVE" || s.status === "UNSURE",
    );
    const currentStop =
      activeIdx >= 0 ? tripState.stops[activeIdx] : tripState.stops[0];
    const nextStop =
      activeIdx >= 0 ? (tripState.stops[activeIdx + 1] ?? null) : null;
    const lastStop = tripState.stops[tripState.stops.length - 1];
    const etaMin = lastStop
      ? Math.max(0, Math.round(lastStop.time_remaining_s / 60))
      : 0;

    const completedCount = tripState.stops.filter(
      (s) => s.status === "COMPLETED" || s.status === "MISSED",
    ).length;
    const journeyFraction =
      tripState.stops.length > 0 ? completedCount / tripState.stops.length : 0;

    const windowStart = Math.max(0, activeIdx - 2);
    const windowEnd = Math.min(
      tripState.stops.length,
      activeIdx < 0 ? 5 : activeIdx + 3,
    );
    const dotWindow = tripState.stops.slice(windowStart, windowEnd);
    const progressDots = dotWindow.map(
      (s): "departed" | "current" | "upcoming" => {
        if (s.status === "COMPLETED" || s.status === "MISSED")
          return "departed";
        if (s.status === "ACTIVE" || s.status === "UNSURE") return "current";
        return "upcoming";
      },
    );

    const routeName =
      currentStop?.route_id ||
      tripState.stops.find((s) => s.route_id)?.route_id ||
      "Transit";

    const input = {
      routeName,
      destination: destinationInfo?.label ?? "Destination",
      currentStopName: currentStop?.stop_name ?? "—",
      nextStopName: nextStop?.stop_name ?? destinationInfo?.label ?? "—",
      etaMinutes: etaMin,
      progressDots,
      journeyFraction,
    };

    if (!activityStartedRef.current) {
      activityStartedRef.current = true;
      startTripActivity(input);
    } else {
      updateTripActivity(input);
    }
  }, [tripState, destinationInfo]);

  const etaMinutes = useMemo(() => {
    const serverStops = tripState?.stops;
    if (serverStops?.length) {
      const last = serverStops[serverStops.length - 1];
      return Math.max(0, Math.round(last.time_remaining_s / 60));
    }
    if (!route) return null;
    const secs = parseDurationSecs(route.duration);
    return secs != null ? Math.round(secs / 60) : null;
  }, [tripState, route]);

  const arrivalTime = useMemo(() => {
    const serverStops = tripState?.stops;
    if (serverStops?.length) {
      const last = serverStops[serverStops.length - 1];
      return new Date(last.eta * 1000).toLocaleTimeString("en-CA", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    }
    if (!route) return null;
    const secs = parseDurationSecs(route.duration);
    if (secs == null) return null;
    return new Date(Date.now() + secs * 1000).toLocaleTimeString("en-CA", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }, [tripState, route]);

  const progressLabels = useMemo(() => {
    if (!route) return ["Walking", "Riding"];
    const allSteps = (route.legs ?? []).flatMap((l) => l.steps ?? []);
    const labels: string[] = [];
    for (const step of allSteps) {
      const label =
        step.travelMode === "WALK"
          ? "Walk"
          : step.transitDetails?.transitLine?.nameShort ||
            step.transitDetails?.transitLine?.name ||
            "Transit";
      if (labels[labels.length - 1] !== label) labels.push(label);
    }
    return labels.length > 0 ? labels : ["Walking", "Riding"];
  }, [route]);

  const completedStopCount = useMemo(
    () => stops.filter((s) => s.status === "departed").length,
    [stops],
  );

  const completedProgressSteps = useMemo(() => {
    return Math.floor(
      (completedStopCount / Math.max(1, stops.length - 1)) *
        progressLabels.length,
    );
  }, [completedStopCount, stops.length, progressLabels.length]);

  const serverStopTotal = tripState?.stops?.length ?? 0;
  const serverStopCompleted = useMemo(
    () =>
      (tripState?.stops ?? []).filter((s) => s.status === "COMPLETED").length,
    [tripState],
  );
  const progressFillPct =
    serverStopTotal > 1 ? serverStopCompleted / (serverStopTotal - 1) : 0;

  const boardingStep = useMemo(() => {
    if (!route) return null;
    const allSteps = (route.legs ?? []).flatMap((l) => l.steps ?? []);
    const transitSteps = allSteps.filter((s) => s.travelMode === "TRANSIT");
    const currentIdx = stops.findIndex(
      (s) => s.status === "current" || s.status === "unsure",
    );
    const completedFrac =
      currentIdx >= 0 ? currentIdx / Math.max(1, stops.length - 1) : 0;
    const completedStepIdx = Math.floor(completedFrac * allSteps.length);
    const active = allSteps
      .map((s, i) => ({ step: s, i }))
      .filter((x) => x.step.travelMode === "TRANSIT")
      .find((x) => x.i >= completedStepIdx);
    return active?.step ?? transitSteps[0] ?? null;
  }, [route, stops]);

  const co2Saved = useMemo(() => {
    if (!route?.distanceMeters) return null;
    return ((route.distanceMeters / 1000) * 0.16).toFixed(1);
  }, [route]);

  const activeTransitName =
    stops.find((s) => s.status === "current" || s.status === "unsure")
      ?.transitName ||
    boardingStep?.transitDetails?.transitLine?.nameShort ||
    boardingStep?.transitDetails?.transitLine?.name ||
    "Transit";

  const heroNextStop = useMemo(
    () =>
      stops.find((s) => s.status === "current" || s.status === "unsure") ??
      stops.find((s) => s.status === "upcoming"),
    [stops],
  );

  const hasFlag = useMemo(
    () =>
      (tripState?.stops ?? []).some(
        (s) => s.status === "MISSED" || s.status === "UNSURE",
      ),
    [tripState],
  );

  const hasMissed = useMemo(
    () =>
      tripState?.overall === "MISSED" ||
      (tripState?.stops ?? []).some((s) => s.status === "MISSED"),
    [tripState],
  );
  const missedFetchedRef = useRef(false);

  useEffect(() => {
    if (!hasMissed) {
      missedFetchedRef.current = false;
      return;
    }
    if (missedFetchedRef.current || !sessionId || !ROUTE_SAVE_URL) return;
    missedFetchedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${ROUTE_SAVE_URL}/trips/${sessionId}`);
        if (resp.status === 404) {
          console.warn("[commute] trip snapshot 404 — session unknown/closed");
          return;
        }
        if (!resp.ok) throw new Error(`snapshot ${resp.status}`);
        const snapshot = (await resp.json()) as TripSnapshotMsg;
        if (cancelled) return;

        const parsed = parseRoute(snapshot.route);
        if (parsed) {
          setRoute(parsed);
          setPendingReroute(false);
        }
      } catch (e) {
        console.error("[commute] trip snapshot fetch failed:", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasMissed, sessionId]);

  const handleRefresh = useCallback(() => {
    if (lastReroute) {
      const parsed = parseRoute(lastReroute.route);
      if (parsed) setRoute(parsed);
    }
    setPendingReroute(false);
  }, [lastReroute]);

  const handleExit = useCallback(async () => {
    endTripActivity();
    activityStartedRef.current = false;
    disconnect();
    if (sessionId && ROUTE_SAVE_URL) {
      fetch(`${ROUTE_SAVE_URL}/trips/${sessionId}`, { method: "DELETE" }).catch(
        () => {},
      );
    }
    routeStore.clearJourney();
    router.navigate("/(tabs)/routes" as never);
  }, [disconnect, sessionId, router]);

  if (!route) {
    return (
      <View style={[styles.emptyScreen, { backgroundColor: colors.surface }]}>
        <Ionicons name="navigate-outline" size={48} color={colors.ink2} />
        <Text style={[styles.emptyTitle, { color: colors.ink }]}>
          No Active Journey
        </Text>
        <Text style={[styles.emptySubtitle, { color: colors.ink2 }]}>
          Go to Routes, select a route, and tap &ldquo;Start Journey&rdquo;.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.surface }]}>
      {(hasFlag || pendingReroute) && (
        <TouchableOpacity
          style={styles.refreshButton}
          onPress={handleRefresh}
          activeOpacity={0.85}
        >
          <Ionicons name="refresh" size={18} color={colors.onPrimary} />
          <Text style={styles.refreshButtonText}>
            {pendingReroute
              ? "Route changed — tap to refresh"
              : "Refresh route"}
          </Text>
        </TouchableOpacity>
      )}

      {notifyBanner && (
        <TouchableOpacity
          style={styles.notifyBanner}
          onPress={() => setNotifyBanner(null)}
          activeOpacity={0.85}
        >
          <Ionicons
            name="information-circle"
            size={18}
            color={colors.primaryInk}
          />
          <Text
            style={[styles.notifyBannerText, { color: colors.ink2 }]}
            numberOfLines={2}
          >
            {notifyBanner}
          </Text>
          <Ionicons name="close" size={16} color={colors.primaryInk} />
        </TouchableOpacity>
      )}

      {boardingConfirmStop && (
        <View style={styles.boardingConfirmOverlay}>
          <View
            style={[
              styles.boardingConfirmCard,
              { backgroundColor: colors.card },
            ]}
          >
            <Text style={[styles.boardingConfirmTitle, { color: colors.ink }]}>
              Did you board?
            </Text>
            <Text style={[styles.boardingConfirmSub, { color: colors.ink2 }]}>
              {boardingConfirmMsg ??
                "Confirm whether you boarded the bus at this stop."}
            </Text>
            <View style={styles.boardingConfirmBtns}>
              <TouchableOpacity
                style={[styles.boardingConfirmBtn, styles.boardingConfirmYes]}
                onPress={() => {
                  sendUnsureResponse(boardingConfirmStop, true);
                  cancelBoarding(boardingConfirmStop);
                  setBoardingConfirmStop(null);
                  setBoardingConfirmMsg(null);
                }}
                activeOpacity={0.85}
              >
                <Text style={styles.boardingConfirmBtnText}>
                  Yes, I boarded
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.boardingConfirmBtn, styles.boardingConfirmNo]}
                onPress={() => {
                  sendUnsureResponse(boardingConfirmStop, false);
                  cancelBoarding(boardingConfirmStop);
                  setBoardingConfirmStop(null);
                  setBoardingConfirmMsg(null);
                }}
                activeOpacity={0.85}
              >
                <Text
                  style={[
                    styles.boardingConfirmBtnText,
                    { color: colors.ink },
                  ]}
                >
                  I missed it
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      <ScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
      >
        <View style={styles.mapContainer}>
          <Map
            style={styles.map}
            mapStyle={mapPaint.baseStyle}
            compass={false}
            logo={false}
            attribution={true}
          >
            <Camera
              ref={cameraRef}
              initialViewState={{ center: CALGARY_CENTER, zoom: 13 }}
            />
            <UserLocation heading={true} animated={true} />
            <Images
              images={{
                tranzitBus: require("@/assets/images/tranzit_busView.png"),
              }}
            />

            <GeoJSONSource
              id="commute-route-source"
              data={routePolylinesGeoJSON}
            >
              <Layer
                id="commute-route-line"
                type="line"
                paint={{ "line-color": ["get", "color"], "line-width": mapPaint.polyline.width }}
                layout={{ "line-cap": "round", "line-join": "round" }}
              />
            </GeoJSONSource>

            <GeoJSONSource id="commute-stops-source" data={routeStopsGeoJSON}>
              <Layer
                id="commute-stops-circle"
                type="circle"
                minzoom={MIN_MARKER_ZOOM}
                paint={{
                  "circle-radius": [
                    "match",
                    ["get", "status"],
                    "ACTIVE",
                    mapPaint.stopCircle.activeRadius,
                    "UNSURE",
                    mapPaint.stopCircle.activeRadius,
                    mapPaint.stopCircle.upcomingRadius,
                  ],
                  "circle-color": [
                    "match",
                    ["get", "status"],
                    "COMPLETED", mapPaint.stopMatch.departed,
                    "ACTIVE", mapPaint.stopMatch.active,
                    "UNSURE", mapPaint.stopMatch.unsure,
                    "MISSED", mapPaint.stopMatch.missed,
                    mapPaint.stopMatch.upcoming,
                  ],
                  "circle-stroke-color": mapPaint.stopCircle.stroke,
                  "circle-stroke-width": mapPaint.stopCircle.strokeWidth,
                  "circle-opacity": mapPaint.stopCircle.opacity,
                }}
              />
            </GeoJSONSource>

            <GeoJSONSource
              id="commute-timeline-source"
              data={timelineStopsGeoJSON}
            >
              <Layer
                id="commute-timeline-circle"
                type="circle"
                paint={{
                  "circle-radius": [
                    "match",
                    ["get", "status"],
                    "current", 9,
                    "unsure", 9,
                    6,
                  ],
                  "circle-color": [
                    "match",
                    ["get", "status"],
                    "departed",   mapPaint.timelineMatch.departed,
                    "current",    mapPaint.timelineMatch.current,
                    "unsure",     mapPaint.timelineMatch.unsure,
                    "missed",     mapPaint.timelineMatch.missed,
                    "destination",mapPaint.timelineMatch.destination,
                    mapPaint.timelineMatch.upcoming,
                  ],
                  "circle-stroke-color": mapPaint.stopCircle.stroke,
                  "circle-stroke-width": [
                    "match",
                    ["get", "status"],
                    "current", 4,
                    "unsure", 4,
                    2,
                  ],
                }}
              />
            </GeoJSONSource>

            <GeoJSONSource id="commute-vehicles-source" data={vehiclesGeoJSON}>
              <Layer
                id="commute-vehicles-icon"
                type="symbol"
                minzoom={MIN_MARKER_ZOOM}
                layout={{
                  "icon-image": "tranzitBus",
                  "icon-size": mapPaint.busSymbol.iconSize,
                  "icon-rotate": ["get", "bearing"],
                  "icon-rotation-alignment": "map",
                  "icon-allow-overlap": true,
                  "icon-ignore-placement": true,
                  "symbol-z-order": "source",
                }}
              />
              <Layer
                id="commute-vehicles-label"
                type="symbol"
                minzoom={MIN_MARKER_ZOOM}
                layout={{
                  "text-field": ["get", "route_id"],
                  "text-size": mapPaint.busSymbol.textSize,
                  "text-font": ["Noto Sans Regular"],
                  "text-rotation-alignment": "viewport",
                  "text-allow-overlap": true,
                  "text-ignore-placement": true,
                }}
                paint={{
                  "text-color": mapPaint.busSymbol.textColor,
                  "text-halo-color": mapPaint.busSymbol.haloColor,
                  "text-halo-width": mapPaint.busSymbol.haloWidth,
                }}
              />
            </GeoJSONSource>
          </Map>

          <View style={styles.liveBadge}>
            <View
              style={[
                styles.liveBadgeDot,
                !isConnected && styles.liveBadgeDotOffline,
              ]}
            />
            <Text style={styles.liveBadgeText}>
              {isConnected ? "LIVE" : "CONNECTING"}
            </Text>
          </View>
        </View>

        {/* ── Hero Section ── */}
        <View style={[styles.hero, { backgroundColor: colors.surface }]}>
          {(boardingStep || co2Saved != null) && (
            <View style={styles.heroBadgeRow}>
              {boardingStep ? (
                <View style={styles.lineBadge}>
                  <Ionicons
                    name="bus-outline"
                    size={13}
                    color={colors.primaryInk}
                  />
                  <Text style={styles.lineBadgeText}>
                    {boardingStep.transitDetails?.transitLine?.nameShort ||
                      boardingStep.transitDetails?.transitLine?.name ||
                      "Transit"}
                    {boardingStep.transitDetails?.headsign
                      ? ` · ${boardingStep.transitDetails.headsign}`
                      : ""}
                  </Text>
                </View>
              ) : (
                <View />
              )}
              {co2Saved != null ? (
                <View style={styles.heroCo2Row}>
                  <MaterialCommunityIcons
                    name="leaf"
                    size={14}
                    color={colors.primaryInk}
                  />
                  <Text style={styles.heroCo2Text}>
                    {co2Saved} kg CO₂ saved
                  </Text>
                </View>
              ) : (
                <View />
              )}
            </View>
          )}

          <View style={styles.heroEtaLabelRow}>
            <Text style={[styles.heroEtaLabel, { color: colors.ink }]}>
              Arriving in
            </Text>
            <View
              style={[
                styles.heroSpeedBadge,
                { backgroundColor: colors.surface },
              ]}
            >
              <Ionicons
                name="speedometer-outline"
                size={15}
                color={colors.ink3}
              />
              <Text style={[styles.heroSpeedText, { color: colors.ink2 }]}>
                {currentSpeed != null ? `${currentSpeed} km/h` : "-- km/h"}
              </Text>
            </View>
          </View>
          <Text style={[styles.heroEtaNum, { color: colors.text }]}>
            {etaMinutes ?? "--"}
            <Text style={[styles.heroEtaUnit, { color: colors.ink2 }]}>
              {" "}
              min
            </Text>
          </Text>

          <Text style={[styles.heroNextStop, { color: colors.ink2 }]}>
            Next stop:{" "}
            <Text style={[styles.heroNextStopName, { color: colors.ink }]}>
              {heroNextStop?.name ?? destinationInfo?.label ?? "Destination"}
            </Text>
          </Text>
        </View>

        <View style={[styles.content]}>
          <View style={[styles.journeyCard, { backgroundColor: colors.card }]}>
            <View style={styles.journeyCardTop}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text
                  style={[styles.journeyDestination, { color: colors.ink }]}
                  numberOfLines={1}
                >
                  To: {destinationInfo?.label ?? "Destination"}
                </Text>
                <Text style={[styles.journeyEta, { color: colors.ink2 }]}>
                  Arriving around {arrivalTime ?? "--:--"}
                </Text>
              </View>
              <View
                style={[styles.arrivalBadge, { backgroundColor: colors.surface2 }]}
              >
                <Text style={[styles.arrivalBadgeText, { color: colors.primary }]}>
                  {arrivalTime ?? "--:--"}
                </Text>
              </View>
            </View>

            <View
              style={[
                styles.progressBarTrack,
                { backgroundColor: colors.surface2 },
              ]}
            >
              <View
                style={[
                  styles.progressBarFill,
                  { width: `${progressFillPct * 100}%` as any },
                ]}
              />
              {progressFillPct > 0 && progressFillPct < 1 && (
                <View
                  style={[
                    styles.progressThumb,
                    { left: `${progressFillPct * 100}%` as any },
                  ]}
                />
              )}
              {serverStopTotal > 1 &&
                Array.from({ length: serverStopTotal }).map((_, i) => (
                  <View
                    key={i}
                    style={[
                      styles.progressTick,
                      { left: `${(i / (serverStopTotal - 1)) * 100}%` as any },
                      i < serverStopCompleted
                        ? styles.progressTickDone
                        : undefined,
                    ]}
                  />
                ))}
            </View>

            <View style={styles.progressLabels}>
              {progressLabels.map((label, i) => (
                <Text
                  key={i}
                  style={[
                    styles.progressLabel,
                    i < completedProgressSteps && {
                      color: colors.primary,
                    },
                  ]}
                >
                  {label}
                </Text>
              ))}
            </View>
          </View>

          <View
            style={[
              styles.timelineCard,
              { backgroundColor: colors.surface2, borderColor: colors.divider },
            ]}
          >
            <View style={styles.sectionLabelRow}>
              <Ionicons
                name="navigate"
                size={15}
                color={colors.primary}
              />
              <Text style={[styles.sectionLabel, { color: colors.ink2 }]}>
                ROUTE PROGRESS
              </Text>
            </View>

            <View style={[styles.stopList]}>
              {stops.map((stop, i) => {
                const isLast = i === stops.length - 1;
                let connectorType: ConnectorType = "none";
                if (!isLast) {
                  const next = stops[i + 1];
                  if (
                    stop.status === "departed" &&
                    (next?.status === "departed" || next?.status === "missed")
                  ) {
                    connectorType = "solid-gray";
                  } else if (
                    stop.status === "departed" &&
                    (next?.status === "current" || next?.status === "unsure")
                  ) {
                    connectorType = "solid-primary";
                  } else {
                    connectorType = "dashed";
                  }
                }
                return (
                  <StopItem
                    key={`${stop.id}-${i}`}
                    stop={stop}
                    connectorType={connectorType}
                  />
                );
              })}
            </View>
          </View>

          {boardingStep && (
            <View style={styles.boardingCard}>
              <View style={styles.boardingIcon}>
                <Ionicons
                  name={
                    boardingStep.transitDetails?.transitLine?.name
                      ?.toLowerCase()
                      .includes("ctrain") ||
                    boardingStep.transitDetails?.transitLine?.nameShort
                      ?.toLowerCase()
                      .includes("ctrain")
                      ? "train"
                      : "bus"
                  }
                  size={28}
                  color={colors.primary}
                />
              </View>
              <View style={styles.boardingContent}>
                <Text style={styles.boardingCategory}>
                  BOARDING INSTRUCTION
                </Text>
                <Text style={styles.boardingTitle}>
                  {`Board the ${boardingStep.transitDetails?.transitLine?.name || "Transit"}\ntowards ${boardingStep.transitDetails?.headsign || "destination"}`}
                </Text>
                <Text style={styles.boardingTip}>
                  {`From: ${boardingStep.transitDetails?.stopDetails?.departureStop?.name || "current stop"}`}
                </Text>
              </View>
            </View>
          )}

          <View
            style={[
              styles.communityCard,
              { backgroundColor: colors.surface2, borderColor: colors.divider },
            ]}
          >
            <View style={styles.communityHeader}>
              <MaterialCommunityIcons
                name="account-group"
                size={22}
                color={colors.selected}
              />
              <Text style={[styles.communityTitle, { color: colors.ink }]}>
                Community Reports
              </Text>
            </View>

            {reportSent ? (
              <View style={styles.reportThanks}>
                <View style={styles.reportThanksIcon}>
                  <Ionicons
                    name="checkmark"
                    size={32}
                    color={colors.primary}
                  />
                </View>
                <Text
                  style={[styles.reportThanksTitle, { color: colors.ink }]}
                >
                  Thanks for the heads up!
                </Text>
                <Text style={[styles.reportThanksBody, { color: colors.ink2 }]}>
                  We just told{" "}
                  <Text style={{ fontWeight: "800", color: colors.ink }}>
                    1,240 commuters
                  </Text>{" "}
                  on this line. You&apos;re a real one.
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    setReportSelected(null);
                    setReportSeverity(1);
                    setReportSent(false);
                  }}
                  activeOpacity={0.8}
                  style={styles.reportAgainBtn}
                >
                  <Text style={styles.reportAgainBtnText}>
                    Report something else
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text
                  style={[styles.communityQuestion, { color: colors.ink2 }]}
                >
                  What&apos;s happening on the{" "}
                  <Text style={{ fontWeight: "700" }}>{activeTransitName}</Text>
                  ?
                </Text>

                <View style={styles.reportGrid}>
                  {REPORT_TYPES.map((r) => {
                    const p = theme.colors.pastels[r.pastel];
                    const active = reportSelected === r.id;
                    return (
                      <TouchableOpacity
                        key={r.id}
                        onPress={() => setReportSelected(r.id)}
                        activeOpacity={0.85}
                        style={[
                          styles.reportGridCard,
                          active && styles.reportGridCardActive,
                          { backgroundColor: colors.card },
                        ]}
                      >
                        <View
                          style={[
                            styles.reportGridIcon,
                            { backgroundColor: p.bg },
                          ]}
                        >
                          <ReportIcon
                            lib={r.iconLib}
                            name={r.icon}
                            size={20}
                            color={p.ink}
                          />
                        </View>
                        <Text
                          style={[
                            styles.reportGridLabel,
                            active && styles.reportGridLabelActive,
                            { color: colors.ink },
                          ]}
                        >
                          {r.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {reportSelected && (
                  <View
                    style={[
                      styles.severityCard,
                      { backgroundColor: colors.surface },
                    ]}
                  >
                    <Text style={styles.severityHeading}>
                      How {reportSelected === "safety" ? "urgent" : "bad"}?
                    </Text>
                    <View style={styles.severityRow}>
                      {SEVERITY_LABELS.map((label, i) => {
                        const active = reportSeverity === i + 1;
                        return (
                          <TouchableOpacity
                            key={i}
                            onPress={() => setReportSeverity(i + 1)}
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

                <TouchableOpacity
                  onPress={() => reportSelected && setReportSent(true)}
                  activeOpacity={0.85}
                  style={[
                    styles.reportSendBtn,
                    !reportSelected && styles.reportSendBtnDisabled,
                  ]}
                >
                  <Ionicons name="send" size={18} color={colors.onPrimary} />
                  <Text style={styles.reportSendBtnText}>
                    {reportSelected
                      ? `Send "${REPORT_TYPES.find((r) => r.id === reportSelected)?.label}" report`
                      : "Pick what you saw"}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity style={styles.thankButton} activeOpacity={0.85}>
              <FontAwesome5
                name="thumbs-up"
                size={16}
                color={colors.selected}
              />
              <Text style={styles.thankButtonText}>Thank a Driver</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      <View
        style={[
          styles.exitBar,
          { backgroundColor: colors.surface, borderTopColor: colors.divider },
        ]}
      >
        <TouchableOpacity
          style={styles.exitBtn}
          onPress={handleExit}
          activeOpacity={0.85}
        >
          <Ionicons name="stop-circle-outline" size={20} color={colors.onPrimary} />
          <Text style={styles.exitBtnText}>End Journey</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: AppTheme) {
  const { colors, typography, semantic, spacing, radii, shadow, mapPaint } = t;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface },
    container: { flex: 1 },
    content: {
      paddingHorizontal: spacing.screen,
      paddingTop: spacing.card,
      gap: spacing.card,
      flexDirection: "column",
    },

    // ── Banners ──
    refreshButton: {
      backgroundColor: colors.primary,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.element,
      paddingVertical: 12,
      paddingHorizontal: spacing.screen,
      zIndex: 10,
    },
    refreshButtonText: {
      color: colors.onPrimary,
      ...typography.buttonMd,
    },
    notifyBanner: {
      backgroundColor: colors.primaryDim,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.element,
      paddingVertical: 10,
      paddingHorizontal: spacing.screen,
      zIndex: 10,
    },
    notifyBannerText: {
      flex: 1,
      ...typography.bodyStrong,
      color: colors.primaryInk,
      lineHeight: 20,
    },

    // ── Boarding confirm ──
    boardingConfirmOverlay: {
      position: "absolute",
      bottom: 90,
      left: spacing.screen,
      right: spacing.screen,
      zIndex: 20,
    },
    boardingConfirmCard: {
      backgroundColor: colors.card,
      borderRadius: 20,
      padding: spacing.card + 8,
      gap: 12,
      ...shadow.floating,
      borderWidth: 1.5,
      borderColor: semantic.warning,
    },
    boardingConfirmTitle: {
      ...typography.title,
      fontWeight: "800",
      color: colors.ink,
    },
    boardingConfirmSub: {
      ...typography.body,
      color: colors.ink2,
      lineHeight: 20,
    },
    boardingConfirmBtns: { flexDirection: "row", gap: 10 },
    boardingConfirmBtn: {
      flex: 1,
      paddingVertical: 14,
      borderRadius: radii.button,
      alignItems: "center",
    },
    boardingConfirmYes: { backgroundColor: colors.primary },
    boardingConfirmNo: {
      backgroundColor: colors.surface2,
      borderWidth: 1,
      borderColor: colors.divider,
    },
    boardingConfirmBtnText: {
      ...typography.buttonLg,
      color: colors.onPrimary,
    },

    // ── Empty state ──
    emptyScreen: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 32,
      backgroundColor: colors.surface,
    },
    emptyTitle: {
      ...typography.title,
      fontWeight: "700",
      color: colors.ink,
    },
    emptySubtitle: {
      ...typography.body,
      color: colors.ink2,
      textAlign: "center",
      lineHeight: 22,
    },

    // ── Map ──
    mapContainer: {
      height: 240,
      backgroundColor: colors.muted,
      position: "relative",
    },
    map: { ...StyleSheet.absoluteFillObject },
    liveBadge: {
      position: "absolute",
      top: 14,
      right: 14,
      backgroundColor: colors.danger,
      borderRadius: radii.pill,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 10,
      paddingVertical: 5,
      gap: 6,
      ...shadow.liveBadge,
    },
    liveBadgeDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.onPrimary,
    },
    liveBadgeDotOffline: { backgroundColor: semantic.warningBg },
    liveBadgeText: {
      color: colors.onPrimary,
      ...typography.badge,
      letterSpacing: 0.5,
    },

    // ── Hero ──
    hero: {
      paddingHorizontal: spacing.screen,
      paddingTop: 22,
      paddingBottom: 18,
      backgroundColor: colors.surface,
    },
    heroBadgeRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 10,
    },
    lineBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.primaryDim,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: radii.pill,
      alignSelf: "flex-start",
    },
    lineBadgeText: {
      ...typography.badgeLg,
      color: colors.primaryInk,
    },
    heroCo2Row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: colors.primaryDim,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: radii.pill,
      alignSelf: "flex-start",
    },
    heroCo2Text: {
      ...typography.captionStrong,
      color: colors.primaryInk,
    },
    heroEtaLabelRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    heroEtaLabel: {
      ...typography.subtitle,
      color: colors.ink2,
      lineHeight: 22,
    },
    heroSpeedBadge: { flexDirection: "row", alignItems: "center", gap: 5 },
    heroSpeedText: { ...typography.bodyStrong, color: colors.ink2 },
    heroEtaNum: {
      ...typography.hero,
      color: colors.ink,
      marginBottom: 6,
    },
    heroEtaUnit: { ...typography.heroUnit },
    heroNextStop: {
      ...typography.subtitle,
      color: colors.ink2,
      lineHeight: 24,
    },
    heroNextStopName: { fontWeight: "700", color: colors.ink },

    // ── Journey summary card ──
    journeyCard: {
      backgroundColor: colors.card,
      borderRadius: radii.card,
      borderLeftWidth: 5,
      borderLeftColor: colors.secondary,
      padding: spacing.card,
      ...shadow.card,
    },
    journeyCardTop: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      marginBottom: 18,
    },
    journeyDestination: {
      ...typography.metaLg,
      color: colors.ink,
    },
    journeyEta: {
      ...typography.bodyItalic,
      color: colors.ink2,
      marginTop: 3,
    },
    arrivalBadge: {
      backgroundColor: colors.surface2,
      borderRadius: radii.pill,
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    arrivalBadgeText: {
      ...typography.arrival,
      color: colors.primary,
    },
    progressBarTrack: {
      height: 10,
      backgroundColor: colors.surface2,
      borderRadius: radii.pill,
      position: "relative",
      justifyContent: "center",
      marginBottom: 8,
      overflow: "visible",
    },
    progressBarFill: {
      height: 10,
      backgroundColor: colors.primary,
      borderRadius: radii.pill,
      position: "absolute",
      left: 0,
    },
    progressTick: {
      position: "absolute",
      width: 2,
      height: 14,
      marginLeft: -1,
      backgroundColor: colors.surface,
      borderRadius: 1,
    },
    progressTickDone: { backgroundColor: colors.primary },
    progressThumb: {
      position: "absolute",
      marginLeft: -9,
      width: 18,
      height: 18,
      borderRadius: 9,
      backgroundColor: colors.primary,
      borderWidth: 4,
      borderColor: colors.onPrimary,
      zIndex: 1,
      shadowColor: semantic.shadow,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.15,
      shadowRadius: 2,
      elevation: 3,
    },
    progressLabels: { flexDirection: "row", justifyContent: "space-between" },
    progressLabel: {
      flex: 1,
      ...typography.captionStrong,
      color: colors.ink2,
    },

    // ── Timeline card ──
    timelineCard: {
      backgroundColor: colors.surface2,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.divider,
      padding: spacing.card + 8,
      gap: 20,
    },
    sectionLabelRow: { flexDirection: "row", alignItems: "center", gap: spacing.element },
    sectionLabel: {
      ...typography.captionStrong,
      color: colors.ink2,
      letterSpacing: 1.2,
      textTransform: "uppercase",
    },
    stopList: { gap: 0 },

    // ── Stop row ──
    stopRow: { flexDirection: "row", gap: 12, minHeight: 72 },
    stopTimelineCol: { width: 32, alignItems: "center", alignSelf: "stretch" },

    currentDotContainer: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 6,
    },
    currentDotRing: {
      position: "absolute",
      width: 32,
      height: 32,
      borderRadius: 16,
    },
    currentDot: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 3,
      alignItems: "center",
      justifyContent: "center",
      zIndex: 1,
    },
    currentDotCore: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.onPrimary,
    },

    departedDot: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.surface2,
      borderWidth: 2,
      borderColor: semantic.neutralLine,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 6,
    },

    destinationDot: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.card,
      borderWidth: 2,
      borderColor: semantic.neutralLine,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 6,
    },
    destinationDotCore: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: semantic.neutralLine,
    },

    upcomingDot: {
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: colors.card,
      borderWidth: 2,
      borderColor: semantic.neutralLine,
      marginTop: 10,
    },

    connectorSolid: { flex: 1, width: 2, marginTop: 3, borderRadius: 1 },

    stopContentOuter: { flex: 1, paddingBottom: 20, paddingTop: 6, gap: 3 },
    stopContentOuterCurrent: {
      backgroundColor: colors.primaryDim + "55",
      borderRadius: 12,
      borderLeftWidth: 3,
      borderLeftColor: colors.primary,
      paddingLeft: 12,
      paddingRight: 10,
      paddingTop: 8,
      paddingBottom: 10,
      marginBottom: 4,
    },
    stopRowInner: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "baseline",
      gap: spacing.element,
    },
    stopName: {
      flex: 1,
      ...typography.subtitle,
      color: colors.ink2,
      lineHeight: 22,
    },
    stopNameDestination: {
      ...typography.subtitleStrong,
      color: colors.ink,
    },
    currentStopName: {
      flex: 1,
      ...typography.subtitleStrong,
      color: colors.primary,
      lineHeight: 22,
    },
    stopTimeText: {
      ...typography.bodySmallStrong,
      color: colors.ink2,
    },
    currentStopChip: {
      backgroundColor: colors.surface,
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      alignSelf: "flex-start",
    },
    unsureChip: { backgroundColor: semantic.warningBg },
    currentStopChipText: {
      ...typography.badge,
      color: colors.ink2,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    destinationLabel: {
      ...typography.caption,
      color: colors.ink3,
      fontStyle: "italic",
    },
    missedLabel: { ...typography.caption, color: semantic.danger, fontWeight: "700" },

    stopMetaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 3,
    },
    stopRouteBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      backgroundColor: colors.surface2,
      borderRadius: radii.pill,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderWidth: 1,
      borderColor: colors.divider,
    },
    stopRouteBadgeText: {
      ...typography.micro,
      color: colors.ink2,
      letterSpacing: 0.2,
    },
    stopTimeDelta: { ...typography.monoBody, fontWeight: "600" },

    // ── Boarding card ──
    boardingCard: {
      backgroundColor: colors.primary,
      borderRadius: radii.card,
      padding: spacing.card + 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 16,
      shadowColor: colors.primaryInk,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 12,
      elevation: 6,
    },
    boardingIcon: {
      width: 64,
      height: 64,
      borderRadius: 16,
      backgroundColor: colors.onPrimary,
      justifyContent: "center",
      alignItems: "center",
      flexShrink: 0,
    },
    boardingContent: { flex: 1, gap: 4 },
    boardingCategory: {
      ...typography.badge,
      color: semantic.offWhite,
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },
    boardingTitle: {
      ...typography.title,
      color: colors.onPrimary,
      lineHeight: 26,
    },
    boardingTip: {
      ...typography.subtitle,
      color: semantic.offWhiteStrong,
      lineHeight: 22,
      marginTop: 2,
    },

    // ── Community card ──
    communityCard: {
      backgroundColor: colors.surface2,
      borderRadius: radii.card,
      borderWidth: 2,
      borderColor: colors.divider,
      padding: spacing.card + 8,
      gap: 14,
    },
    communityHeader: { flexDirection: "row", alignItems: "center", gap: spacing.element },
    communityTitle: {
      ...typography.title,
      fontWeight: "700",
      color: colors.ink,
    },
    communityQuestion: {
      ...typography.subtitle,
      color: colors.ink2,
      lineHeight: 24,
    },

    reportGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    reportGridCard: {
      width: "47.5%",
      backgroundColor: colors.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.divider,
      padding: 14,
      gap: 10,
    },
    reportGridCardActive: {
      borderWidth: 2,
      borderColor: colors.primary,
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 10,
      elevation: 4,
    },
    reportGridIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      justifyContent: "center",
      alignItems: "center",
    },
    reportGridLabel: {
      ...typography.subtitle,
      fontWeight: "700",
      color: colors.ink,
    },
    reportGridLabelActive: { color: colors.primary },

    severityCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.divider,
      padding: 14,
      gap: 10,
    },
    severityHeading: {
      ...typography.microStrong,
      color: colors.ink3,
      letterSpacing: 1.4,
      textTransform: "uppercase",
    },
    severityRow: { flexDirection: "row", gap: 6 },
    severityChip: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 12,
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
    severityChipTextActive: { color: colors.primaryInk },

    reportSendBtn: {
      backgroundColor: colors.primary,
      borderRadius: radii.button,
      height: 50,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.element,
      ...shadow.button,
    },
    reportSendBtnDisabled: { opacity: 0.4, shadowOpacity: 0, elevation: 0 },
    reportSendBtnText: {
      color: colors.onPrimary,
      ...typography.subtitleStrong,
      letterSpacing: -0.2,
    },

    reportThanks: { alignItems: "center", gap: 10, paddingVertical: 8 },
    reportThanksIcon: {
      width: 72,
      height: 72,
      borderRadius: 22,
      backgroundColor: colors.primaryDim,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 4,
    },
    reportThanksTitle: {
      ...typography.titleLarge,
      color: colors.ink,
      textAlign: "center",
    },
    reportThanksBody: {
      ...typography.body,
      color: colors.ink2,
      textAlign: "center",
      lineHeight: 22,
    },
    reportAgainBtn: {
      height: 44,
      paddingHorizontal: 20,
      borderRadius: radii.button,
      borderWidth: 1.5,
      borderColor: colors.divider,
      backgroundColor: colors.card,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 4,
    },
    reportAgainBtnText: {
      ...typography.subtitle,
      color: colors.ink,
    },

    thankButton: {
      backgroundColor: colors.secondary,
      borderRadius: radii.pill,
      paddingVertical: 18,
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: 10,
      shadowColor: semantic.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.08,
      shadowRadius: 4,
      elevation: 3,
    },
    thankButtonText: {
      ...typography.subtitleStrong,
      color: colors.accentInk,
    },

    // ── Exit bar ──
    exitBar: {
      backgroundColor: colors.surface,
      paddingHorizontal: spacing.screen,
      paddingTop: 12,
      paddingBottom: 16,
      borderTopWidth: 1,
      borderTopColor: colors.divider,
      shadowColor: semantic.shadow,
      shadowOffset: { width: 0, height: -2 },
      shadowOpacity: 0.06,
      shadowRadius: 6,
      elevation: 8,
    },
    exitBtn: {
      backgroundColor: colors.tertiary,
      borderRadius: radii.button,
      paddingVertical: 16,
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: 10,
    },
    exitBtnText: {
      ...typography.subtitleStrong,
      color: colors.onPrimary,
    },
  });
}
