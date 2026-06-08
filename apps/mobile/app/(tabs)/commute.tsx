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
import { theme, PASTELS } from "@/styles/theme";
import { useTheme } from "@/contexts/ThemeContext";
import { routeStore } from "@/lib/routeStore";
import { decodePolyline } from "@/utils/decodePolyline";
import { normalizeColor } from "@/components/routes/RoutePickerSheet";
import { scheduleBoarding, cancelBoarding } from "@/lib/boardingNotifications";
import { startTripActivity, updateTripActivity, endTripActivity } from "@/lib/liveActivity";
import type { Route } from "@/types/places";
import type { ServerStopStatus, TripStateMsg } from "@/types/trip";

const ROUTE_SAVE_URL = process.env.EXPO_PUBLIC_ROUTE_SAVE_URL ?? "";
const STYLE_URL = `https://api.maptiler.com/maps/positron/style.json?key=${process.env.EXPO_PUBLIC_MAPTILER_KEY}`;
const CALGARY_CENTER: [number, number] = [-114.0719, 51.0447];
const MIN_MARKER_ZOOM = 12;

// ─── Types ────────────────────────────────────────────────────────────────────

type ConnectorType = "solid-gray" | "solid-primary" | "dashed" | "none";

type PastelKey = keyof typeof PASTELS;

interface ReportType {
  id: string;
  label: string;
  pastel: PastelKey;
  iconLib: "ionicons" | "fa5" | "fa6" | "mci";
  icon: string;
}

// "missed" = bus was missed; "unsure" = server waiting for boarding confirmation
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
  { id: "crowd",  label: "Crowded",      pastel: "sky",      iconLib: "ionicons", icon: "people" },
  { id: "delay",  label: "Delay",        pastel: "butter",   iconLib: "ionicons", icon: "time" },
  { id: "safety", label: "Safety",       pastel: "rose",     iconLib: "ionicons", icon: "shield" },
  { id: "vandal", label: "Vandalism",    pastel: "peach",    iconLib: "fa5",      icon: "spray-can" },
  { id: "cons",   label: "Construction", pastel: "mint",     iconLib: "mci",      icon: "traffic-cone" },
  { id: "other",  label: "Other",        pastel: "lavender", iconLib: "ionicons", icon: "sparkles" },
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
    case "ACTIVE":    return "current";
    case "COMPLETED": return "departed";
    case "UNSURE":    return "unsure";
    case "MISSED":    return "missed";
    default:          return "upcoming";
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

function DashedConnector() {
  return (
    <View style={{ flex: 1, alignItems: "center", marginTop: 3 }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <View key={i} style={{ width: 2, height: 4, backgroundColor: "#BBCBB9", marginBottom: 3, borderRadius: 1 }} />
      ))}
    </View>
  );
}

// ─── ReportIcon ───────────────────────────────────────────────────────────────

function ReportIcon({ lib, name, size, color }: { lib: "ionicons" | "fa5" | "fa6" | "mci"; name: string; size: number; color: string }) {
  if (lib === "fa5") return <FontAwesome5 name={name as any} size={size} color={color} />;
  if (lib === "fa6") return <FontAwesome6 name={name as any} size={size} color={color} />;
  if (lib === "mci") return <MaterialCommunityIcons name={name as any} size={size} color={color} />;
  return <Ionicons name={name as any} size={size} color={color} />;
}

// ─── StopItem ─────────────────────────────────────────────────────────────────

function StopItem({
  stop,
  connectorType,
}: {
  stop: CommuteStop;
  connectorType: ConnectorType;
}) {
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
          Animated.timing(pulseScale, { toValue: 1.6, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseScale, { toValue: 0.85, duration: 1000, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(pulseOpacity, { toValue: 0, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseOpacity, { toValue: 0.7, duration: 1000, useNativeDriver: true }),
        ]),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isCurrent, isUnsure]);

  const dotRingColor = isUnsure ? "#F59E0B" : theme.colors.primary;
  const dotColor = isUnsure ? "#F59E0B" : theme.colors.primary;

  return (
    <View style={styles.stopRow}>
      {/* ── Timeline column ── */}
      <View style={styles.stopTimelineCol}>
        {(isCurrent || isUnsure) ? (
          <View style={styles.currentDotContainer}>
            <Animated.View
              style={[
                styles.currentDotRing,
                { transform: [{ scale: pulseScale }], opacity: pulseOpacity, backgroundColor: dotRingColor },
              ]}
            />
            <View style={[styles.currentDot, { backgroundColor: dotColor, borderColor: "white" }]}>
              <View style={styles.currentDotCore} />
            </View>
          </View>
        ) : (isDeparted || isMissed) ? (
          <View style={[styles.departedDot, isMissed && styles.missedDot]}>
            {isMissed
              ? <Ionicons name="close" size={11} color="#EF4444" />
              : <Ionicons name="checkmark" size={11} color={theme.colors.ink3} />
            }
          </View>
        ) : isDestination ? (
          <View style={styles.destinationDot}>
            <View style={styles.destinationDotCore} />
          </View>
        ) : (
          <View style={styles.upcomingDot} />
        )}

        {connectorType !== "none" &&
          (connectorType === "dashed" ? (
            <DashedConnector />
          ) : (
            <View
              style={[
                styles.connectorSolid,
                {
                  backgroundColor:
                    connectorType === "solid-primary"
                      ? theme.colors.primary
                      : "#BBCBB9",
                },
              ]}
            />
          ))}
      </View>

      {/* ── Stop content ── */}
      <View
        style={[
          styles.stopContentOuter,
          isCurrent && styles.stopContentOuterCurrent,
          isUnsure && styles.stopContentOuterUnsure,
        ]}
      >
        {(isCurrent || isUnsure) ? (
          <>
            <View style={styles.stopRowInner}>
              <Text style={[styles.currentStopName, isUnsure && { color: "#D97706" }]} numberOfLines={1}>
                {stop.name}
              </Text>
              {stop.time && (
                <Text style={[styles.stopTimeText, { color: isUnsure ? "#D97706" : theme.colors.primary }]}>
                  {stop.time}
                </Text>
              )}
            </View>
            <View style={[styles.currentStopChip, isUnsure && styles.unsureChip]}>
              <Text style={[styles.currentStopChipText, isUnsure && { color: "#92400E" }]}>
                {isUnsure
                  ? `${stop.transitName ? `${stop.transitName} · ` : ""}Confirm Boarding?`
                  : `${stop.transitName ? `${stop.transitName} · ` : ""}Current Stop`}
              </Text>
            </View>
            {stop.timeRemaining !== undefined && (
              <View style={styles.stopMetaRow}>
                <Text style={[
                  styles.stopTimeDelta,
                  stop.timeRemaining > 60 ? styles.stopTimeDeltaUpcoming
                    : stop.timeRemaining < -60 ? styles.stopTimeDeltaPast
                    : styles.stopTimeDeltaOnTime,
                ]}>
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
                  (isDeparted || isMissed) && styles.stopNameDeparted,
                  isMissed && styles.stopNameMissed,
                  isDestination && styles.stopNameDestination,
                ]}
                numberOfLines={1}
              >
                {stop.name}
              </Text>
              {stop.time && (
                <Text style={[styles.stopTimeText, (isDeparted || isMissed) && { opacity: 0.5 }]}>
                  {stop.time}
                </Text>
              )}
            </View>
            {isDestination && (
              <Text style={styles.destinationLabel}>Final Destination</Text>
            )}
            {isMissed && (
              <Text style={styles.missedLabel}>Missed</Text>
            )}
            {stop.mode === "TRANSIT" && (stop.transitName || stop.timeRemaining !== undefined) && (
              <View style={styles.stopMetaRow}>
                {stop.transitName && (
                  <View style={styles.stopRouteBadge}>
                    <Ionicons name="bus-outline" size={10} color={theme.colors.ink3} />
                    <Text style={styles.stopRouteBadgeText}>{stop.transitName}</Text>
                  </View>
                )}
                {stop.timeRemaining !== undefined && (
                  <Text style={[
                    styles.stopTimeDelta,
                    stop.timeRemaining > 60 ? styles.stopTimeDeltaUpcoming
                      : stop.timeRemaining < -60 ? styles.stopTimeDeltaPast
                      : styles.stopTimeDeltaOnTime,
                  ]}>
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
  const { colors } = useTheme();
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

  // NOTIFY / REROUTE UI state
  const [notifyBanner, setNotifyBanner] = useState<string | null>(null);
  const [boardingConfirmStop, setBoardingConfirmStop] = useState<string | null>(null);
  const [boardingConfirmMsg, setBoardingConfirmMsg] = useState<string | null>(null);
  // A reroute was received from the server but not yet applied to the polyline.
  // Applied manually via the Refresh button (no automatic reroute churn).
  const [pendingReroute, setPendingReroute] = useState(false);

  const [userLocation, setUserLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);

  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  // Throttle LOCATION sends to ~5 s
  const lastLocationSentRef = useRef<number>(0);

  // Cross-effect refs (avoid stale deps)
  const boardingConfirmStopRef = useRef<string | null>(null);
  const tripStateRef = useRef<TripStateMsg | null>(null);
  const activityStartedRef = useRef(false);

  const allVehicles = useVehicles();

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const { tripState, lastReroute, lastNotify, isConnected, sendLocation, sendUnsureResponse, disconnect } =
    useTripWebSocket(wsPath);

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

  // ── Keep cross-effect refs in sync ────────────────────────────────────────
  useEffect(() => { boardingConfirmStopRef.current = boardingConfirmStop; }, [boardingConfirmStop]);
  useEffect(() => { tripStateRef.current = tripState; }, [tripState]);

  // ── NOTIFY handler ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!lastNotify) return;
    // Any flag that needs a yes/no answer → actionable in-app flashcard + push.
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

  // ── Raise the boarding prompt from an UNSURE stop in STATE ─────────────────
  // The server may signal "unsure you boarded" purely via a stop's STATE status
  // (no NOTIFY message). Mirror the NOTIFY path so the flashcard still appears.
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

  // ── REROUTE handler ────────────────────────────────────────────────────────
  // No automatic refresh: the new route is buffered in lastReroute and only
  // applied to the polyline when the user taps the manual Refresh button. Live
  // STATE keeps flowing, so the timeline still advances on its own.
  useEffect(() => {
    if (!lastReroute) return;
    setPendingReroute(true);
  }, [lastReroute]);

  // ── Auto-dismiss boarding prompt when stop leaves UNSURE ───────────────────
  useEffect(() => {
    if (!boardingConfirmStop || !tripState) return;
    const stop = tripState.stops.find((s) => s.stop_id === boardingConfirmStop);
    if (!stop || stop.status !== "UNSURE") {
      cancelBoarding(boardingConfirmStop);
      setBoardingConfirmStop(null);
      setBoardingConfirmMsg(null);
    }
  }, [tripState, boardingConfirmStop]);

  // ── GPS subscription ──────────────────────────────────────────────────────
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
            setUserLocation({ latitude: coords.latitude, longitude: coords.longitude });
            if (coords.speed != null && coords.speed >= 0) {
              setCurrentSpeed(Math.round(coords.speed * 3.6));
            }

            // Send LOCATION to Route Save ~every 5 s
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

        if (cancelled) { sub.remove(); return; }
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

  // ── Route IDs for vehicle filter (from server stops or Google fallback) ───
  const transitRouteIds = useMemo(() => {
    if (tripState?.stops?.length) {
      const ids = tripState.stops.map((s) => s.route_id).filter(Boolean);
      return [...new Set(ids)];
    }
    if (!route) return [];
    const ids = (route.legs ?? [])
      .flatMap((l) => l.steps ?? [])
      .filter((s) => s.travelMode === "TRANSIT")
      .map((s) => s.transitDetails?.transitLine?.nameShort || s.transitDetails?.transitLine?.name)
      .filter((id): id is string => Boolean(id));
    return [...new Set(ids)];
  }, [tripState, route]);

  const routeVehicles = useMemo(
    () =>
      transitRouteIds.length === 0
        ? []
        : allVehicles.filter((v) => v.route_id != null && transitRouteIds.includes(v.route_id)),
    [allVehicles, transitRouteIds],
  );

  const vehiclesGeoJSON = useMemo(() => vehiclesToGeoJSON(routeVehicles), [routeVehicles]);

  // ── Stop GeoJSON from Route Save STATE ────────────────────────────────────
  const routeStopsGeoJSON = useMemo(() => ({
    type: "FeatureCollection" as const,
    features: (tripState?.stops ?? []).map((s) => ({
      type: "Feature" as const,
      properties: { stop_id: s.stop_id, status: s.status },
      geometry: {
        type: "Point" as const,
        coordinates: [s.lng, s.lat] as [number, number],
      },
    })),
  }), [tripState]);

  // ── Build display stops from STATE ────────────────────────────────────────
  const stops = useMemo((): CommuteStop[] => {
    const originLabel = originInfo?.label ?? "Your Location";
    const destLabel = destinationInfo?.label ?? "Destination";

    if (!tripState?.stops?.length) {
      // Fallback while WS connects: show origin + destination placeholders
      return [
        { id: "origin", name: originLabel, status: "departed", mode: "WALK" },
        { id: "destination", name: destLabel, status: "destination", mode: "WALK" },
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
      { id: "destination", name: destLabel, status: "destination", mode: "WALK" },
    ];
  }, [tripState, originInfo, destinationInfo]);

  // ── Fit map to route polyline ─────────────────────────────────────────────
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

  // ── Polyline GeoJSON ──────────────────────────────────────────────────────
  const routePolylinesGeoJSON = useMemo(() => {
    if (!route?.polyline?.encodedPolyline) {
      return { type: "FeatureCollection" as const, features: [] };
    }
    const allCoords = safeDecodePolyline(route.polyline.encodedPolyline);
    if (allCoords.length === 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }

    // Find current stop for split point
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
        if (d < minDist) { minDist = d; splitIdx = i; }
      });
    }

    const transitStep = (route.legs ?? [])
      .flatMap((l) => l.steps ?? [])
      .find((s) => s.travelMode === "TRANSIT");
    const lineColor = normalizeColor(transitStep?.transitDetails?.transitLine?.color);

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
        properties: { color: theme.colors.primary },
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
  }, [route, stops]);

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
            coordinates: [s.coordinate!.longitude, s.coordinate!.latitude] as [number, number],
          },
        })),
    }),
    [stops],
  );

  // ── Live Activity / persistent trip notification ───────────────────────────
  useEffect(() => {
    if (!tripState?.stops?.length) return;

    const activeIdx = tripState.stops.findIndex(
      (s) => s.status === "ACTIVE" || s.status === "UNSURE",
    );
    const currentStop =
      activeIdx >= 0 ? tripState.stops[activeIdx] : tripState.stops[0];
    const nextStop = activeIdx >= 0 ? (tripState.stops[activeIdx + 1] ?? null) : null;
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
    const windowEnd = Math.min(tripState.stops.length, activeIdx < 0 ? 5 : activeIdx + 3);
    const dotWindow = tripState.stops.slice(windowStart, windowEnd);
    const progressDots = dotWindow.map(
      (s): "departed" | "current" | "upcoming" => {
        if (s.status === "COMPLETED" || s.status === "MISSED") return "departed";
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

  // ── ETA from server ────────────────────────────────────────────────────────
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

  // ── Progress labels ────────────────────────────────────────────────────────
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
      (completedStopCount / Math.max(1, stops.length - 1)) * progressLabels.length,
    );
  }, [completedStopCount, stops.length, progressLabels.length]);

  const serverStopTotal = tripState?.stops?.length ?? 0;
  const serverStopCompleted = useMemo(
    () => (tripState?.stops ?? []).filter((s) => s.status === "COMPLETED").length,
    [tripState],
  );
  const progressFillPct = serverStopTotal > 1 ? serverStopCompleted / (serverStopTotal - 1) : 0;

  // ── Boarding instruction ──────────────────────────────────────────────────
  const boardingStep = useMemo(() => {
    if (!route) return null;
    const allSteps = (route.legs ?? []).flatMap((l) => l.steps ?? []);
    const transitSteps = allSteps.filter((s) => s.travelMode === "TRANSIT");
    // Find the first transit step that hasn't been fully completed
    const currentIdx = stops.findIndex((s) => s.status === "current" || s.status === "unsure");
    const completedFrac = currentIdx >= 0 ? currentIdx / Math.max(1, stops.length - 1) : 0;
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
    stops.find((s) => s.status === "current" || s.status === "unsure")?.transitName ||
    boardingStep?.transitDetails?.transitLine?.nameShort ||
    boardingStep?.transitDetails?.transitLine?.name ||
    "Transit";

  const heroNextStop = useMemo(
    () =>
      stops.find((s) => s.status === "current" || s.status === "unsure") ??
      stops.find((s) => s.status === "upcoming"),
    [stops],
  );

  // ── Missed/unsure flag → surface the manual Refresh control ────────────────
  const hasFlag = useMemo(
    () =>
      (tripState?.stops ?? []).some(
        (s) => s.status === "MISSED" || s.status === "UNSURE",
      ),
    [tripState],
  );

  // ── Manual Refresh: apply the buffered reroute polyline ────────────────────
  const handleRefresh = useCallback(() => {
    if (lastReroute) setRoute(lastReroute.route);
    setPendingReroute(false);
  }, [lastReroute]);

  // ── End journey ───────────────────────────────────────────────────────────
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

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!route) {
    return (
      <View style={[styles.emptyScreen, { backgroundColor: colors.surface }]}>
        <Ionicons name="navigate-outline" size={48} color={theme.colors.text} />
        <Text style={styles.emptyTitle}>No Active Journey</Text>
        <Text style={styles.emptySubtitle}>
          Go to Routes, select a route, and tap "Start Journey".
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.surface }]}>
      {/* ── Manual Refresh (shown when a stop is missed/unsure) ── */}
      {(hasFlag || pendingReroute) && (
        <TouchableOpacity
          style={styles.refreshButton}
          onPress={handleRefresh}
          activeOpacity={0.85}
        >
          <Ionicons name="refresh" size={18} color="white" />
          <Text style={styles.refreshButtonText}>
            {pendingReroute ? "Route changed — tap to refresh" : "Refresh route"}
          </Text>
        </TouchableOpacity>
      )}

      {/* ── Notify banner ── */}
      {notifyBanner && (
        <TouchableOpacity
          style={styles.notifyBanner}
          onPress={() => setNotifyBanner(null)}
          activeOpacity={0.85}
        >
          <Ionicons name="information-circle" size={18} color={theme.colors.primaryInk} />
          <Text style={styles.notifyBannerText} numberOfLines={2}>{notifyBanner}</Text>
          <Ionicons name="close" size={16} color={theme.colors.primaryInk} />
        </TouchableOpacity>
      )}

      {/* ── Boarding confirm prompt ── */}
      {boardingConfirmStop && (
        <View style={styles.boardingConfirmOverlay}>
          <View style={[styles.boardingConfirmCard, { backgroundColor: colors.card }]}>
            <Text style={styles.boardingConfirmTitle}>Did you board?</Text>
            <Text style={styles.boardingConfirmSub}>
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
                <Text style={styles.boardingConfirmBtnText}>Yes, I boarded</Text>
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
                <Text style={[styles.boardingConfirmBtnText, { color: theme.colors.ink }]}>
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
        {/* ── Live Map ── */}
        <View style={styles.mapContainer}>
          <Map
            style={styles.map}
            mapStyle={STYLE_URL}
            compass={false}
            logo={false}
            attribution={true}
          >
            <Camera
              ref={cameraRef}
              initialViewState={{ center: CALGARY_CENTER, zoom: 13 }}
            />
            <UserLocation heading={true} animated={true} />
            <Images images={{ tranzitBus: require("@/assets/images/tranzit_busView.png") }} />

            <GeoJSONSource id="commute-route-source" data={routePolylinesGeoJSON}>
              <Layer
                id="commute-route-line"
                type="line"
                paint={{ "line-color": ["get", "color"], "line-width": 5 }}
                layout={{ "line-cap": "round", "line-join": "round" }}
              />
            </GeoJSONSource>

            <GeoJSONSource id="commute-stops-source" data={routeStopsGeoJSON}>
              <Layer
                id="commute-stops-circle"
                type="circle"
                minzoom={MIN_MARKER_ZOOM}
                paint={{
                  "circle-radius": ["match", ["get", "status"], "ACTIVE", 7, "UNSURE", 7, 4],
                  "circle-color": [
                    "match",
                    ["get", "status"],
                    "COMPLETED", theme.colors.primary,
                    "ACTIVE",   theme.colors.primary,
                    "UNSURE",   "#F59E0B",
                    "MISSED",   "#EF4444",
                    "#C1C6D7",
                  ],
                  "circle-stroke-color": "white",
                  "circle-stroke-width": 1.5,
                  "circle-opacity": 0.9,
                }}
              />
            </GeoJSONSource>

            <GeoJSONSource id="commute-timeline-source" data={timelineStopsGeoJSON}>
              <Layer
                id="commute-timeline-circle"
                type="circle"
                paint={{
                  "circle-radius": ["match", ["get", "status"], "current", 9, "unsure", 9, 6],
                  "circle-color": [
                    "match",
                    ["get", "status"],
                    "departed",    theme.colors.primary,
                    "current",     theme.colors.primary,
                    "unsure",      "#F59E0B",
                    "missed",      "#EF4444",
                    "destination", theme.colors.secondary,
                    "#C1C6D7",
                  ],
                  "circle-stroke-color": "white",
                  "circle-stroke-width": ["match", ["get", "status"], "current", 4, "unsure", 4, 2],
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
                  "icon-size": 0.12,
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
                  "text-size": 10,
                  "text-font": ["Noto Sans Regular"],
                  "text-rotation-alignment": "viewport",
                  "text-allow-overlap": true,
                  "text-ignore-placement": true,
                }}
                paint={{
                  "text-color": "white",
                  "text-halo-color": "rgba(0,0,0,0.45)",
                  "text-halo-width": 1,
                }}
              />
            </GeoJSONSource>
          </Map>

          <View style={styles.liveBadge}>
            <View style={[styles.liveBadgeDot, !isConnected && styles.liveBadgeDotOffline]} />
            <Text style={styles.liveBadgeText}>{isConnected ? "LIVE" : "CONNECTING"}</Text>
          </View>

        </View>

        {/* ── Hero Section ── */}
        <View style={[styles.hero, { backgroundColor: colors.surface }]}>
          {(boardingStep || co2Saved != null) && (
            <View style={styles.heroBadgeRow}>
              {boardingStep ? (
                <View style={styles.lineBadge}>
                  <Ionicons name="bus-outline" size={13} color={theme.colors.primaryInk} />
                  <Text style={styles.lineBadgeText}>
                    {boardingStep.transitDetails?.transitLine?.nameShort ||
                      boardingStep.transitDetails?.transitLine?.name ||
                      "Transit"}
                    {boardingStep.transitDetails?.headsign
                      ? ` · ${boardingStep.transitDetails.headsign}`
                      : ""}
                  </Text>
                </View>
              ) : <View />}
              {co2Saved != null ? (
                <View style={styles.heroCo2Row}>
                  <MaterialCommunityIcons name="leaf" size={14} color={theme.colors.primaryInk} />
                  <Text style={styles.heroCo2Text}>{co2Saved} kg CO₂ saved</Text>
                </View>
              ) : <View />}
            </View>
          )}

          <View style={styles.heroEtaLabelRow}>
            <Text style={styles.heroEtaLabel}>Arriving in</Text>
            <View style={styles.heroSpeedBadge}>
              <Ionicons name="speedometer-outline" size={15} color={theme.colors.ink3} />
              <Text style={styles.heroSpeedText}>
                {currentSpeed != null ? `${currentSpeed} km/h` : "-- km/h"}
              </Text>
            </View>
          </View>
          <Text style={styles.heroEtaNum}>
            {etaMinutes ?? "--"}
            <Text style={styles.heroEtaUnit}> min</Text>
          </Text>

          <Text style={styles.heroNextStop}>
            Next stop:{" "}
            <Text style={styles.heroNextStopName}>
              {heroNextStop?.name ?? destinationInfo?.label ?? "Destination"}
            </Text>
          </Text>
        </View>

        <View style={styles.content}>
          {/* ── Journey summary + progress bar ── */}
          <View style={[styles.journeyCard, { backgroundColor: colors.card }]}>
            <View style={styles.journeyCardTop}>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={styles.journeyDestination} numberOfLines={1}>
                  To: {destinationInfo?.label ?? "Destination"}
                </Text>
                <Text style={styles.journeyEta}>
                  Arriving around {arrivalTime ?? "--:--"}
                </Text>
              </View>
              <View style={styles.arrivalBadge}>
                <Text style={styles.arrivalBadgeText}>{arrivalTime ?? "--:--"}</Text>
              </View>
            </View>

            <View style={styles.progressBarTrack}>
              <View style={[styles.progressBarFill, { width: `${progressFillPct * 100}%` as any }]} />
              {progressFillPct > 0 && progressFillPct < 1 && (
                <View style={[styles.progressThumb, { left: `${progressFillPct * 100}%` as any }]} />
              )}
              {serverStopTotal > 1 && Array.from({ length: serverStopTotal }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.progressTick,
                    { left: `${(i / (serverStopTotal - 1)) * 100}%` as any },
                    i < serverStopCompleted ? styles.progressTickDone : undefined,
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
                    i < completedProgressSteps && { color: theme.colors.primary },
                  ]}
                >
                  {label}
                </Text>
              ))}
            </View>
          </View>

          {/* ── Route Progress Timeline ── */}
          <View style={[styles.timelineCard, { backgroundColor: colors.surface2, borderColor: colors.divider }]}>
            <View style={styles.sectionLabelRow}>
              <Ionicons name="navigate" size={15} color={theme.colors.primary} />
              <Text style={styles.sectionLabel}>ROUTE PROGRESS</Text>
            </View>

            <View style={styles.stopList}>
              {stops.map((stop, i) => {
                const isLast = i === stops.length - 1;
                let connectorType: ConnectorType = "none";
                if (!isLast) {
                  const next = stops[i + 1];
                  if (stop.status === "departed" && (next?.status === "departed" || next?.status === "missed")) {
                    connectorType = "solid-gray";
                  } else if (stop.status === "departed" && (next?.status === "current" || next?.status === "unsure")) {
                    connectorType = "solid-primary";
                  } else {
                    connectorType = "dashed";
                  }
                }
                return <StopItem key={stop.id} stop={stop} connectorType={connectorType} />;
              })}
            </View>
          </View>

          {/* ── Boarding Instruction ── */}
          {boardingStep && (
            <View style={styles.boardingCard}>
              <View style={styles.boardingIcon}>
                <Ionicons
                  name={
                    boardingStep.transitDetails?.transitLine?.name?.toLowerCase().includes("ctrain") ||
                    boardingStep.transitDetails?.transitLine?.nameShort?.toLowerCase().includes("ctrain")
                      ? "train"
                      : "bus"
                  }
                  size={28}
                  color={theme.colors.primary}
                />
              </View>
              <View style={styles.boardingContent}>
                <Text style={styles.boardingCategory}>BOARDING INSTRUCTION</Text>
                <Text style={styles.boardingTitle}>
                  {`Board the ${boardingStep.transitDetails?.transitLine?.name || "Transit"}\ntowards ${boardingStep.transitDetails?.headsign || "destination"}`}
                </Text>
                <Text style={styles.boardingTip}>
                  {`From: ${boardingStep.transitDetails?.stopDetails?.departureStop?.name || "current stop"}`}
                </Text>
              </View>
            </View>
          )}

          {/* ── Community Reports ── */}
          <View style={[styles.communityCard, { backgroundColor: colors.surface2, borderColor: colors.divider }]}>
            <View style={styles.communityHeader}>
              <MaterialCommunityIcons name="account-group" size={22} color={theme.colors.selected} />
              <Text style={styles.communityTitle}>Community Reports</Text>
            </View>

            {reportSent ? (
              <View style={styles.reportThanks}>
                <View style={styles.reportThanksIcon}>
                  <Ionicons name="checkmark" size={32} color={theme.colors.primary} />
                </View>
                <Text style={styles.reportThanksTitle}>Thanks for the heads up!</Text>
                <Text style={styles.reportThanksBody}>
                  We just told{" "}
                  <Text style={{ fontWeight: "800", color: theme.colors.ink }}>1,240 commuters</Text>
                  {" "}on this line. You're a real one.
                </Text>
                <TouchableOpacity
                  onPress={() => { setReportSelected(null); setReportSeverity(1); setReportSent(false); }}
                  activeOpacity={0.8}
                  style={styles.reportAgainBtn}
                >
                  <Text style={styles.reportAgainBtnText}>Report something else</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={styles.communityQuestion}>
                  What's happening on the{" "}
                  <Text style={{ fontWeight: "700" }}>{activeTransitName}</Text>?
                </Text>

                <View style={styles.reportGrid}>
                  {REPORT_TYPES.map((r) => {
                    const p = PASTELS[r.pastel];
                    const active = reportSelected === r.id;
                    return (
                      <TouchableOpacity
                        key={r.id}
                        onPress={() => setReportSelected(r.id)}
                        activeOpacity={0.85}
                        style={[styles.reportGridCard, active && styles.reportGridCardActive]}
                      >
                        <View style={[styles.reportGridIcon, { backgroundColor: p.bg }]}>
                          <ReportIcon lib={r.iconLib} name={r.icon} size={20} color={p.ink} />
                        </View>
                        <Text style={[styles.reportGridLabel, active && styles.reportGridLabelActive]}>
                          {r.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {reportSelected && (
                  <View style={styles.severityCard}>
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
                            style={[styles.severityChip, active && styles.severityChipActive]}
                          >
                            <Text style={[styles.severityChipText, active && styles.severityChipTextActive]}>
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
                  style={[styles.reportSendBtn, !reportSelected && styles.reportSendBtnDisabled]}
                >
                  <Ionicons name="send" size={18} color="#fff" />
                  <Text style={styles.reportSendBtnText}>
                    {reportSelected
                      ? `Send "${REPORT_TYPES.find((r) => r.id === reportSelected)?.label}" report`
                      : "Pick what you saw"}
                  </Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity style={styles.thankButton} activeOpacity={0.85}>
              <FontAwesome5 name="thumbs-up" size={16} color={theme.colors.selected} />
              <Text style={styles.thankButtonText}>Thank a Driver</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      {/* ── End Journey Bar ── */}
      <View style={[styles.exitBar, { backgroundColor: colors.surface, borderTopColor: colors.divider }]}>
        <TouchableOpacity style={styles.exitBtn} onPress={handleExit} activeOpacity={0.85}>
          <Ionicons name="stop-circle-outline" size={20} color="white" />
          <Text style={styles.exitBtnText}>End Journey</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.surface },
  container: { flex: 1 },
  content: {
    paddingHorizontal: theme.spacing.screen,
    paddingTop: theme.spacing.card,
    gap: theme.spacing.card,
    flexDirection: "column",
  },

  // ── Banners ──────────────────────────────────────────────────────────────
  refreshButton: {
    backgroundColor: theme.colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: theme.spacing.screen,
    zIndex: 10,
  },
  refreshButtonText: {
    color: "white",
    fontSize: 14,
    fontWeight: "700",
  },
  notifyBanner: {
    backgroundColor: theme.colors.primaryDim,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: theme.spacing.screen,
    zIndex: 10,
  },
  notifyBannerText: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.primaryInk,
    lineHeight: 20,
  },

  // ── Boarding confirm ─────────────────────────────────────────────────────
  boardingConfirmOverlay: {
    position: "absolute",
    bottom: 90,
    left: theme.spacing.screen,
    right: theme.spacing.screen,
    zIndex: 20,
  },
  boardingConfirmCard: {
    backgroundColor: theme.colors.card,
    borderRadius: 20,
    padding: theme.spacing.card + 8,
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 10,
    borderWidth: 1.5,
    borderColor: "#F59E0B",
  },
  boardingConfirmTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: theme.colors.ink,
  },
  boardingConfirmSub: {
    fontSize: 14,
    color: theme.colors.ink2,
    lineHeight: 20,
  },
  boardingConfirmBtns: { flexDirection: "row", gap: 10 },
  boardingConfirmBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: theme.borderRadius.button,
    alignItems: "center",
  },
  boardingConfirmYes: { backgroundColor: theme.colors.primary },
  boardingConfirmNo: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  boardingConfirmBtnText: {
    fontSize: 15,
    fontWeight: "700",
    color: "white",
  },

  // ── Empty state ──────────────────────────────────────────────────────────
  emptyScreen: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 32,
    backgroundColor: theme.colors.surface,
  },
  emptyTitle: {
    fontSize: theme.fontSize.title,
    fontWeight: "700",
    color: theme.colors.ink,
  },
  emptySubtitle: {
    fontSize: theme.fontSize.body,
    color: theme.colors.ink2,
    textAlign: "center",
    lineHeight: 22,
  },

  // ── Map ──────────────────────────────────────────────────────────────────
  mapContainer: {
    height: 240,
    backgroundColor: theme.colors.muted,
    position: "relative",
  },
  map: { ...StyleSheet.absoluteFillObject },
  liveBadge: {
    position: "absolute",
    top: 14,
    right: 14,
    backgroundColor: theme.colors.danger,
    borderRadius: 99,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 5,
    gap: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  liveBadgeDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "white" },
  liveBadgeDotOffline: { backgroundColor: "#FEF3C7" },
  liveBadgeText: { color: "white", fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },

  // ── Hero ─────────────────────────────────────────────────────────────────
  hero: {
    paddingHorizontal: theme.spacing.screen,
    paddingTop: 22,
    paddingBottom: 18,
    backgroundColor: theme.colors.surface,
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
    backgroundColor: theme.colors.primaryDim,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 99,
    alignSelf: "flex-start",
  },
  lineBadgeText: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.primaryInk,
    letterSpacing: 0.2,
  },
  heroCo2Row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: theme.colors.primaryDim,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
    alignSelf: "flex-start",
  },
  heroCo2Text: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.primaryInk,
  },
  heroEtaLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  heroEtaLabel: {
    fontSize: 16,
    color: theme.colors.ink2,
    lineHeight: 22,
  },
  heroSpeedBadge: { flexDirection: "row", alignItems: "center", gap: 5 },
  heroSpeedText: { fontSize: 14, fontWeight: "600", color: theme.colors.ink2 },
  heroEtaNum: {
    fontSize: 52,
    fontWeight: "800",
    color: theme.colors.ink,
    letterSpacing: -1.5,
    lineHeight: 60,
    marginBottom: 6,
  },
  heroEtaUnit: { fontSize: 28, fontWeight: "600", letterSpacing: -0.5 },
  heroNextStop: { fontSize: 16, color: theme.colors.ink2, lineHeight: 24 },
  heroNextStopName: { fontWeight: "700", color: theme.colors.ink },

  // ── Journey summary card ─────────────────────────────────────────────────
  journeyCard: {
    backgroundColor: theme.colors.card,
    borderRadius: theme.borderRadius.card,
    borderLeftWidth: 5,
    borderLeftColor: theme.colors.secondary,
    padding: theme.spacing.card,
    ...theme.shadow.card,
  },
  journeyCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 18,
  },
  journeyDestination: { fontSize: 17, fontWeight: "700", color: theme.colors.ink },
  journeyEta: {
    fontSize: theme.fontSize.body,
    fontStyle: "italic",
    color: theme.colors.ink2,
    marginTop: 3,
  },
  arrivalBadge: {
    backgroundColor: theme.colors.surface2,
    borderRadius: 99,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  arrivalBadgeText: { fontSize: 18, fontWeight: "700", color: theme.colors.primary },
  progressBarTrack: {
    height: 10,
    backgroundColor: theme.colors.surface2,
    borderRadius: 99,
    position: "relative",
    justifyContent: "center",
    marginBottom: 8,
    overflow: "visible",
  },
  progressBarFill: {
    height: 10,
    backgroundColor: theme.colors.primary,
    borderRadius: 99,
    position: "absolute",
    left: 0,
  },
  progressTick: {
    position: "absolute",
    width: 2,
    height: 14,
    marginLeft: -1,
    backgroundColor: theme.colors.surface,
    borderRadius: 1,
  },
  progressTickDone: { backgroundColor: theme.colors.primary },
  progressThumb: {
    position: "absolute",
    marginLeft: -9,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.colors.primary,
    borderWidth: 4,
    borderColor: "white",
    zIndex: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 3,
  },
  progressLabels: { flexDirection: "row", justifyContent: "space-between" },
  progressLabel: {
    flex: 1,
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.ink2,
  },

  // ── Timeline card ────────────────────────────────────────────────────────
  timelineCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.card,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    padding: theme.spacing.card + 8,
    gap: 20,
  },
  sectionLabelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.ink2,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  stopList: { gap: 0 },

  // ── Stop row ─────────────────────────────────────────────────────────────
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
  currentDotCore: { width: 7, height: 7, borderRadius: 4, backgroundColor: "white" },

  departedDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.surface2,
    borderWidth: 2,
    borderColor: "#BBCBB9",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
  },
  missedDot: { borderColor: "#EF4444", backgroundColor: "#FEF2F2" },

  destinationDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.colors.card,
    borderWidth: 2,
    borderColor: "#BBCBB9",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
  },
  destinationDotCore: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#BBCBB9" },

  upcomingDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.colors.card,
    borderWidth: 2,
    borderColor: "#BBCBB9",
    marginTop: 10,
  },

  connectorSolid: { flex: 1, width: 2, marginTop: 3, borderRadius: 1 },

  stopContentOuter: { flex: 1, paddingBottom: 20, paddingTop: 6, gap: 3 },
  stopContentOuterCurrent: {
    backgroundColor: theme.colors.primaryDim + "55",
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.primary,
    paddingLeft: 12,
    paddingRight: 10,
    paddingTop: 8,
    paddingBottom: 10,
    marginBottom: 4,
  },
  stopContentOuterUnsure: {
    backgroundColor: "#FEF3C755",
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: "#F59E0B",
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
    gap: 8,
  },
  stopName: { flex: 1, fontSize: 15, color: theme.colors.ink, lineHeight: 22 },
  stopNameDeparted: { color: theme.colors.ink3 },
  stopNameMissed: { color: "#EF4444" },
  stopNameDestination: { fontSize: 16, fontWeight: "700", color: theme.colors.ink },
  currentStopName: { flex: 1, fontSize: 16, fontWeight: "700", color: theme.colors.primary, lineHeight: 22 },
  stopTimeText: { fontSize: 13, fontWeight: "600", color: theme.colors.ink2 },
  currentStopChip: {
    backgroundColor: theme.colors.surface,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  unsureChip: { backgroundColor: "#FEF3C7" },
  currentStopChipText: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.ink2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  destinationLabel: { fontSize: 12, color: theme.colors.ink3, fontStyle: "italic" },
  missedLabel: { fontSize: 12, color: "#EF4444", fontWeight: "700" },

  stopMetaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
  stopRouteBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: theme.colors.surface2,
    borderRadius: 99,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  stopRouteBadgeText: { fontSize: 10, fontWeight: "700", color: theme.colors.ink3, letterSpacing: 0.2 },
  stopTimeDelta: { fontSize: 11, fontWeight: "600" },
  stopTimeDeltaUpcoming: { color: theme.colors.primary },
  stopTimeDeltaOnTime: { color: "#16A34A" },
  stopTimeDeltaPast: { color: theme.colors.ink3 },

  // ── Boarding card ────────────────────────────────────────────────────────
  boardingCard: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius.card,
    padding: theme.spacing.card + 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    shadowColor: theme.colors.primaryInk,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 6,
  },
  boardingIcon: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: "white",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  boardingContent: { flex: 1, gap: 4 },
  boardingCategory: {
    fontSize: 11,
    fontWeight: "600",
    color: "rgba(255,255,255,0.75)",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  boardingTitle: { fontSize: 18, fontWeight: "700", color: "white", lineHeight: 26 },
  boardingTip: {
    fontSize: theme.fontSize.subtitle,
    color: "rgba(255,255,255,0.85)",
    lineHeight: 22,
    marginTop: 2,
  },

  // ── Community card ───────────────────────────────────────────────────────
  communityCard: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.card,
    borderWidth: 2,
    borderColor: theme.colors.divider,
    padding: theme.spacing.card + 8,
    gap: 14,
  },
  communityHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  communityTitle: { fontSize: 18, fontWeight: "700", color: theme.colors.ink },
  communityQuestion: { fontSize: theme.fontSize.subtitle, color: theme.colors.ink2, lineHeight: 24 },

  reportGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  reportGridCard: {
    width: "47.5%",
    backgroundColor: theme.colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    padding: 14,
    gap: 10,
  },
  reportGridCardActive: {
    borderWidth: 2,
    borderColor: theme.colors.primary,
    shadowColor: theme.colors.primary,
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
  reportGridLabel: { fontSize: 15, fontWeight: "700", color: theme.colors.ink },
  reportGridLabelActive: { color: theme.colors.primary },

  severityCard: {
    backgroundColor: theme.colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.divider,
    padding: 14,
    gap: 10,
  },
  severityHeading: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.ink3,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  severityRow: { flexDirection: "row", gap: 6 },
  severityChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: theme.colors.divider,
    backgroundColor: theme.colors.card,
    alignItems: "center",
  },
  severityChipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primaryDim,
  },
  severityChipText: { fontSize: 11, fontWeight: "700", color: theme.colors.ink2 },
  severityChipTextActive: { color: theme.colors.primaryInk },

  reportSendBtn: {
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius.button,
    height: 50,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  reportSendBtnDisabled: { opacity: 0.4, shadowOpacity: 0, elevation: 0 },
  reportSendBtnText: { color: "#fff", fontSize: 16, fontWeight: "700", letterSpacing: -0.2 },

  reportThanks: { alignItems: "center", gap: 10, paddingVertical: 8 },
  reportThanksIcon: {
    width: 72,
    height: 72,
    borderRadius: 22,
    backgroundColor: theme.colors.primaryDim,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 4,
  },
  reportThanksTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: theme.colors.ink,
    letterSpacing: -0.4,
    textAlign: "center",
  },
  reportThanksBody: { fontSize: 14, color: theme.colors.ink2, textAlign: "center", lineHeight: 22 },
  reportAgainBtn: {
    height: 44,
    paddingHorizontal: 20,
    borderRadius: theme.borderRadius.button,
    borderWidth: 1.5,
    borderColor: theme.colors.divider,
    backgroundColor: theme.colors.card,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  reportAgainBtnText: { fontSize: 15, fontWeight: "600", color: theme.colors.ink },

  thankButton: {
    backgroundColor: theme.colors.secondary,
    borderRadius: 99,
    paddingVertical: 18,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 3,
  },
  thankButtonText: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "700",
    color: theme.colors.accentInk,
  },

  // ── Exit bar ─────────────────────────────────────────────────────────────
  exitBar: {
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.screen,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: theme.colors.divider,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 8,
  },
  exitBtn: {
    backgroundColor: theme.colors.tertiary,
    borderRadius: theme.borderRadius.button,
    paddingVertical: 16,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
  },
  exitBtnText: { fontSize: theme.fontSize.subtitle, fontWeight: "700", color: "white" },
});
