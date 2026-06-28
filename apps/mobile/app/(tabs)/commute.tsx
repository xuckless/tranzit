import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
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
import BottomSheet, {
  BottomSheetScrollView,
  BottomSheetFooter,
  type BottomSheetFooterProps,
} from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MarqueeText } from "@/components/MarqueeText";
import { useVehiclesForRoutes, vehiclesToGeoJSON } from "@/lib/vehicleSSE";
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
import {
  normalizeColor,
  formatDuration,
  formatDistance,
} from "@/components/routes/RoutePickerSheet";
import { scheduleBoarding, cancelBoarding } from "@/lib/boardingNotifications";
import { scheduleLeaveBy, cancelLeaveBy } from "@/lib/leaveByNotifications";
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
import { ROUTE_SAVE_URL } from "@/lib/config";
import { getAccessToken } from "@/lib/supabase";

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
  /** Present only on walking-segment rows (not origin/destination anchors). */
  walkInfo?: { distance?: string; transfer?: boolean };
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
        {stop.walkInfo ? (
          <View
            style={[styles.walkDot, { backgroundColor: semantic.walkChipBg }]}
          >
            <FontAwesome5
              name="walking"
              size={11}
              color={isDeparted ? colors.ink3 : colors.ink2}
            />
          </View>
        ) : isCurrent || isUnsure ? (
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
            {stop.walkInfo && (
              <View style={styles.stopMetaRow}>
                {stop.walkInfo.transfer && (
                  <View
                    style={[
                      styles.stopRouteBadge,
                      {
                        backgroundColor: colors.surface2,
                        borderColor: colors.divider,
                      },
                    ]}
                  >
                    <FontAwesome5
                      name="exchange-alt"
                      size={9}
                      color={colors.ink2}
                    />
                    <Text
                      style={[styles.stopRouteBadgeText, { color: colors.ink2 }]}
                    >
                      TRANSFER
                    </Text>
                  </View>
                )}
                {stop.walkInfo.distance && (
                  <Text
                    style={[
                      styles.stopTimeDelta,
                      { color: colors.ink3 },
                      isDeparted && { opacity: 0.6 },
                    ]}
                  >
                    {stop.walkInfo.distance}
                  </Text>
                )}
              </View>
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
  const insets = useSafeAreaInsets();
  const sheetSnapPoints = useMemo(() => ["14%", "50%", "90%"], []);
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

  // Store-side selector: only notifies when one of the trip's buses actually
  // changed, so the screen no longer re-renders on every fleet-wide SSE tick.
  const routeVehicles = useVehiclesForRoutes(transitRouteIds);

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

  // ── Boarding / leave-by data ────────────────────────────────────────────────
  // The boarding stop is the first server stop (the list is replaced wholesale
  // on reroute, so this self-heals). Before the first STATE frame, fall back
  // to the route's first transit step.
  const boardingStopServer = tripState?.stops?.[0] ?? null;

  const firstTransitStep = useMemo(
    () =>
      (route?.legs ?? [])
        .flatMap((l) => l.steps ?? [])
        .find((s) => s.travelMode === "TRANSIT") ?? null,
    [route],
  );

  // Boarding counts as confirmed once the server moves past the first stop
  // (completed/missed) or starts tracking a later stop — the leave-by hint
  // has served its purpose at that point.
  const boardingConfirmed = useMemo(() => {
    const s = tripState?.stops;
    if (!s?.length) return false;
    if (s[0].status === "COMPLETED" || s[0].status === "MISSED") return true;
    return s.some(
      (st, i) =>
        i > 0 && (st.status === "ACTIVE" || st.status === "COMPLETED"),
    );
  }, [tripState]);

  // Total walking time before the first transit leg.
  const firstWalkSecs = useMemo(() => {
    let secs = 0;
    for (const st of (route?.legs ?? []).flatMap((l) => l.steps ?? [])) {
      if (st.travelMode !== "WALK") break;
      secs += parseDurationSecs(st.duration ?? "") ?? 0;
    }
    return secs > 0 ? secs : null;
  }, [route]);

  const busArrivalEpoch = useMemo(() => {
    if (boardingStopServer && boardingStopServer.eta > 0)
      return boardingStopServer.eta;
    const iso = firstTransitStep?.transitDetails?.stopDetails?.departureTime;
    if (iso) {
      const t = new Date(iso).getTime();
      if (!isNaN(t)) return Math.floor(t / 1000);
    }
    return null;
  }, [boardingStopServer, firstTransitStep]);

  const busArrivesInMin = useMemo(() => {
    if (boardingStopServer && boardingStopServer.eta > 0)
      return Math.max(0, Math.round(boardingStopServer.time_remaining_s / 60));
    if (busArrivalEpoch == null) return null;
    return Math.max(0, Math.round((busArrivalEpoch - Date.now() / 1000) / 60));
  }, [boardingStopServer, busArrivalEpoch]);

  const boardingStopName =
    boardingStopServer?.stop_name ??
    firstTransitStep?.transitDetails?.stopDetails?.departureStop?.name ??
    null;

  // Leave-by = bus arrival − walk to the stop − 3 min buffer. Shown (and
  // notified) only until boarding is confirmed.
  const leaveByEpoch = useMemo(() => {
    if (boardingConfirmed || busArrivalEpoch == null) return null;
    return busArrivalEpoch - (firstWalkSecs ?? 0) - 180;
  }, [boardingConfirmed, busArrivalEpoch, firstWalkSecs]);

  const lastScheduledLeaveByRef = useRef<number | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    if (leaveByEpoch == null) {
      if (lastScheduledLeaveByRef.current != null) {
        lastScheduledLeaveByRef.current = null;
        void cancelLeaveBy(sessionId).catch(() => {});
      }
      return;
    }
    // The server refreshes the boarding stop's eta on every STATE frame;
    // only touch the scheduler when the leave-by moment drifts meaningfully.
    const prev = lastScheduledLeaveByRef.current;
    if (prev != null && Math.abs(prev - leaveByEpoch) <= 60) return;
    lastScheduledLeaveByRef.current = leaveByEpoch;
    void scheduleLeaveBy(sessionId, boardingStopName ?? "your stop", leaveByEpoch).catch(() => {});
  }, [sessionId, leaveByEpoch, boardingStopName]);

  // Cancel any pending leave-by notification when the commute screen unmounts
  // (e.g. user navigates away without pressing End Journey).
  useEffect(() => {
    if (!sessionId) return;
    return () => {
      if (lastScheduledLeaveByRef.current != null) {
        void cancelLeaveBy(sessionId).catch(() => {});
      }
    };
  }, [sessionId]);

  const stops = useMemo((): CommuteStop[] => {
    const originLabel = originInfo?.label ?? "Your Location";
    const destLabel = destinationInfo?.label ?? "Destination";

    const originStop: CommuteStop = {
      id: "origin",
      name: originLabel,
      status: "departed",
      mode: "WALK",
    };
    const destStop: CommuteStop = {
      id: "destination",
      name: destLabel,
      status: "destination",
      mode: "WALK",
    };

    if (!tripState?.stops?.length) return [originStop, destStop];

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

    // ── Interleave walking segments from the route steps ──
    // Collapse consecutive WALK steps into one segment per gap; transit step k
    // is preceded by walkBefore[k] (or null), with `trailing` after the last.
    type WalkSeg = { secs: number; meters: number };
    const allSteps = (route?.legs ?? []).flatMap((l) => l.steps ?? []);
    const walkBefore: (WalkSeg | null)[] = [];
    let pending: WalkSeg | null = null;
    for (const st of allSteps) {
      if (st.travelMode === "WALK") {
        const secs = parseDurationSecs(st.duration ?? "") ?? 0;
        const meters = st.distanceMeters ?? 0;
        if (pending) {
          pending.secs += secs;
          pending.meters += meters;
        } else {
          pending = { secs, meters };
        }
      } else {
        walkBefore.push(pending);
        pending = null;
      }
    }
    const trailing = pending;

    // Group server stops into consecutive runs per transit leg (route_id
    // changes at each transfer).
    const runs: CommuteStop[][] = [];
    tripState.stops.forEach((s, i) => {
      if (i === 0 || (s.route_id != null && s.route_id !== tripState.stops[i - 1].route_id)) {
        runs.push([serverStops[i]]);
      } else {
        runs[runs.length - 1].push(serverStops[i]);
      }
    });

    // Runs must align 1:1 with the route's transit steps; on mismatch (e.g.
    // mid-reroute, before the refreshed route lands) fall back to the flat
    // layout rather than mislabeling segments.
    if (runs.length !== walkBefore.length) {
      return [originStop, ...serverStops, destStop];
    }

    const walkRow = (
      seg: WalkSeg,
      k: number,
      target: string,
      transfer: boolean,
      departed: boolean,
    ): CommuteStop => ({
      id: `walk-${k}`,
      name: transfer ? `Transfer · walk to ${target}` : `Walk to ${target}`,
      time: formatDuration(`${seg.secs}s`),
      status: departed ? "departed" : "upcoming",
      mode: "WALK",
      walkInfo: {
        distance: seg.meters > 0 ? formatDistance(seg.meters) : undefined,
        transfer,
      },
    });

    const out: CommuteStop[] = [originStop];
    runs.forEach((run, k) => {
      const seg = walkBefore[k];
      if (seg && seg.secs > 0) {
        const firstStatus = run[0]?.status;
        const departed =
          firstStatus === "departed" ||
          firstStatus === "missed" ||
          (k === 0 && boardingConfirmed);
        out.push(walkRow(seg, k, run[0]?.name ?? "stop", k > 0, departed));
      }
      out.push(...run);
    });
    if (trailing && trailing.secs > 0) {
      const lastStatus = runs.at(-1)?.at(-1)?.status;
      out.push(
        walkRow(
          trailing,
          runs.length,
          destLabel,
          false,
          lastStatus === "departed" || lastStatus === "missed",
        ),
      );
    }
    out.push(destStop);
    return out;
  }, [tripState, route, originInfo, destinationInfo, boardingConfirmed]);

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
    const empty = {
      type: "FeatureCollection" as const,
      features: [] as Array<{
        type: "Feature";
        properties: { color: string; mode: "WALK" | "TRANSIT" };
        geometry: { type: "LineString"; coordinates: [number, number][] };
      }>,
    };
    if (!route) return empty;

    // Per-step geometry (OTP always carries it) lets walk segments render as
    // dotted lines; a route missing any step polyline (Google standby) falls
    // back to one solid route-level segment, exactly the old behavior.
    type Segment = {
      mode: "WALK" | "TRANSIT";
      coords: { latitude: number; longitude: number }[];
      color: string;
    };
    const allSteps = (route.legs ?? []).flatMap((l) => l.steps ?? []);
    const hasStepGeometry =
      allSteps.length > 0 &&
      allSteps.every((s) => s.polyline?.encodedPolyline);

    let segments: Segment[];
    if (hasStepGeometry) {
      segments = allSteps
        .map((s) => ({
          mode: s.travelMode,
          coords: safeDecodePolyline(s.polyline!.encodedPolyline),
          color:
            s.travelMode === "WALK"
              ? mapPaint.polyline.walk
              : normalizeColor(
                  s.transitDetails?.transitLine?.color,
                  colors.primary,
                ),
        }))
        .filter((seg) => seg.coords.length > 1);
    } else {
      const allCoords = safeDecodePolyline(
        route.polyline?.encodedPolyline ?? "",
      );
      if (allCoords.length === 0) return empty;
      const transitStep = allSteps.find((s) => s.travelMode === "TRANSIT");
      segments = [
        {
          mode: "TRANSIT",
          coords: allCoords,
          color: normalizeColor(
            transitStep?.transitDetails?.transitLine?.color,
            colors.primary,
          ),
        },
      ];
    }
    if (segments.length === 0) return empty;

    // Split the whole path at the coordinate nearest the current stop: before
    // it renders as "completed" (muted), after it in segment colors.
    const currentStop = stops.find((s) => s.status === "current");
    let splitSeg = -1;
    let splitIdx = 0;
    if (currentStop?.coordinate) {
      let minDist = Infinity;
      segments.forEach((seg, si) => {
        seg.coords.forEach((c, i) => {
          const d = haversineMeters(
            currentStop.coordinate!.latitude,
            currentStop.coordinate!.longitude,
            c.latitude,
            c.longitude,
          );
          if (d < minDist) {
            minDist = d;
            splitSeg = si;
            splitIdx = i;
          }
        });
      });
    }

    const features: typeof empty.features = [];
    const push = (seg: Segment, coords: Segment["coords"], done: boolean) => {
      if (coords.length < 2) return;
      features.push({
        type: "Feature",
        properties: {
          color: done ? mapPaint.polyline.completed : seg.color,
          mode: seg.mode,
        },
        geometry: {
          type: "LineString",
          coordinates: coords.map((c) => [c.longitude, c.latitude]),
        },
      });
    };
    segments.forEach((seg, si) => {
      if (splitSeg < 0 || si > splitSeg) {
        push(seg, seg.coords, false);
      } else if (si < splitSeg) {
        push(seg, seg.coords, true);
      } else {
        push(seg, seg.coords.slice(0, splitIdx + 1), true);
        push(seg, seg.coords.slice(splitIdx), false);
      }
    });

    return { type: "FeatureCollection" as const, features };
  }, [route, stops, mapPaint.polyline, colors.primary]);

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

  // ETA to the FINAL destination (the old hero number — kept for the journey
  // card and the post-boarding fallback, renamed so it can't be mistaken for
  // the bus's arrival at the boarding stop).
  const destinationEtaMinutes = useMemo(() => {
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

  const serverStopTotal = tripState?.stops?.length ?? 0;
  const serverStopCompleted = useMemo(
    () =>
      (tripState?.stops ?? []).filter((s) => s.status === "COMPLETED").length,
    [tripState],
  );
  const progressFillPct =
    serverStopTotal > 1 ? serverStopCompleted / (serverStopTotal - 1) : 0;

  // Ordered legs of the whole trip (consecutive walks merged), weighted by
  // duration so the rail segments size proportionally. Drives the journey rail.
  type JourneySeg = {
    mode: "WALK" | "TRANSIT";
    icon: "walk" | "bus" | "train";
    label: string;
    weightSecs: number;
    line?: string;
    headsign?: string;
  };
  const journeySegments = useMemo<JourneySeg[]>(() => {
    if (!route) return [];
    const allSteps = (route.legs ?? []).flatMap((l) => l.steps ?? []);
    const segs: JourneySeg[] = [];
    for (const step of allSteps) {
      const secs =
        parseDurationSecs(step.duration ?? step.staticDuration ?? "") ?? 0;
      if (step.travelMode === "WALK") {
        const last = segs[segs.length - 1];
        if (last && last.mode === "WALK") last.weightSecs += secs;
        else
          segs.push({ mode: "WALK", icon: "walk", label: "Walk", weightSecs: secs });
      } else {
        const line =
          step.transitDetails?.transitLine?.nameShort ||
          step.transitDetails?.transitLine?.name ||
          "Transit";
        const nameBlob = `${step.transitDetails?.transitLine?.name ?? ""} ${
          step.transitDetails?.transitLine?.nameShort ?? ""
        }`;
        segs.push({
          mode: "TRANSIT",
          icon: /ctrain/i.test(nameBlob) ? "train" : "bus",
          label: line,
          weightSecs: secs,
          line,
          headsign: step.transitDetails?.headsign,
        });
      }
    }
    // Floor each weight so zero-duration legs still claim rail width.
    return segs.map((s) => ({ ...s, weightSecs: Math.max(s.weightSecs, 1) }));
  }, [route]);

  // Checkpoint positions along the rail: one node at each leg's start (carrying
  // that leg's mode icon), placed by cumulative duration fraction.
  const railNodes = useMemo(() => {
    const total = journeySegments.reduce((a, s) => a + s.weightSecs, 0) || 1;
    let acc = 0;
    return journeySegments.map((seg) => {
      const frac = acc / total;
      acc += seg.weightSecs;
      return { frac, icon: seg.icon };
    });
  }, [journeySegments]);

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

  // One-line "what to do now" caption for the journey rail. Kept deliberately
  // non-redundant with the hero rows (which already state "Board at <stop>").
  const activeInstruction = useMemo((): {
    icon: "walk" | "bus" | "train";
    mode: "WALK" | "TRANSIT";
    text: string;
  } => {
    const boardingIcon: "bus" | "train" = /ctrain/i.test(
      boardingStep?.transitDetails?.transitLine?.name ?? "",
    )
      ? "train"
      : "bus";
    const line =
      boardingStep?.transitDetails?.transitLine?.nameShort ||
      boardingStep?.transitDetails?.transitLine?.name ||
      activeTransitName;
    const headsign = boardingStep?.transitDetails?.headsign;

    if (boardingStep && !boardingConfirmed) {
      return {
        icon: boardingIcon,
        mode: "TRANSIT",
        text: headsign ? `Board ${line} → ${headsign}` : `Board ${line}`,
      };
    }
    if (boardingStep && boardingConfirmed && heroNextStop?.mode !== "WALK") {
      return {
        icon: boardingIcon,
        mode: "TRANSIT",
        text: heroNextStop?.name
          ? `Ride ${activeTransitName} · next ${heroNextStop.name}`
          : `Ride ${activeTransitName}`,
      };
    }
    const target =
      heroNextStop?.name?.replace(/^(Transfer · )?walk to /i, "") ??
      destinationInfo?.label ??
      "destination";
    const dist = heroNextStop?.walkInfo?.distance;
    return {
      icon: "walk",
      mode: "WALK",
      text: dist ? `Walk ${dist} to ${target}` : `Walk to ${target}`,
    };
  }, [
    boardingStep,
    boardingConfirmed,
    heroNextStop,
    activeTransitName,
    destinationInfo,
  ]);

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
        const token = await getAccessToken();
        const resp = await fetch(`${ROUTE_SAVE_URL}/trips/${sessionId}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
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
    if (sessionId) {
      cancelLeaveBy(sessionId);
      lastScheduledLeaveByRef.current = null;
    }
    if (sessionId && ROUTE_SAVE_URL) {
      // Owner token required: Route Save only tears the trip down for its owner.
      const token = await getAccessToken();
      fetch(`${ROUTE_SAVE_URL}/trips/${sessionId}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).catch(() => {});
    }
    routeStore.clearJourney();
    router.navigate("/(tabs)/routes" as never);
  }, [disconnect, sessionId, router]);

  const renderSheetFooter = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props} bottomInset={0}>
        <View
          style={[
            styles.footerWrap,
            { paddingBottom: insets.bottom > 0 ? 8 : 12 },
          ]}
        >
          <TouchableOpacity
            style={styles.exitBtn}
            onPress={handleExit}
            activeOpacity={0.85}
          >
            <Ionicons
              name="stop-circle-outline"
              size={20}
              color={colors.onPrimary}
            />
            <Text style={styles.exitBtnText}>End Journey</Text>
          </TouchableOpacity>
        </View>
      </BottomSheetFooter>
    ),
    [styles, insets.bottom, handleExit, colors.onPrimary],
  );

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
                id="commute-route-line-transit"
                type="line"
                filter={["!=", ["get", "mode"], "WALK"]}
                paint={{ "line-color": ["get", "color"], "line-width": mapPaint.polyline.width }}
                layout={{ "line-cap": "round", "line-join": "round" }}
              />
              {/* Walking: thick dotted ([0, 2] dash + round cap = dots). */}
              <Layer
                id="commute-route-line-walk"
                type="line"
                filter={["==", ["get", "mode"], "WALK"]}
                paint={{
                  "line-color": ["get", "color"],
                  "line-width": mapPaint.polyline.width + 2,
                  "line-dasharray": [0, 2],
                }}
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

      <BottomSheet
        index={2}
        snapPoints={sheetSnapPoints}
        enablePanDownToClose={false}
        enableContentPanningGesture={false}
        handleIndicatorStyle={{ backgroundColor: colors.ink3 }}
        backgroundStyle={{ backgroundColor: colors.card }}
        footerComponent={renderSheetFooter}
      >
        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 120 }}
        >
          {/* ── Hero Section ── */}
          <View style={styles.hero}>
            <View style={styles.heroHeaderRow}>
              <MarqueeText
                containerStyle={styles.heroRouteTitleBox}
                style={[styles.heroRouteTitle, { color: colors.ink }]}
                align="left"
                text={
                  boardingStep
                    ? `Route ${
                        boardingStep.transitDetails?.transitLine?.nameShort ||
                        boardingStep.transitDetails?.transitLine?.name ||
                        "Transit"
                      }${
                        boardingStep.transitDetails?.headsign
                          ? ` · ${boardingStep.transitDetails.headsign}`
                          : ""
                      }`
                    : "Your journey"
                }
              />
              <View style={styles.heroSpeedBadge}>
                <Ionicons
                  name="speedometer-outline"
                  size={14}
                  color={colors.ink3}
                />
                <Text style={styles.heroSpeedText}>
                  {currentSpeed != null ? `${currentSpeed} km/h` : "-- km/h"}
                </Text>
              </View>
            </View>

            <View style={styles.heroDivider} />

            {!boardingConfirmed &&
            busArrivesInMin != null &&
            boardingStopName ? (
              <>
                {/* Pre-boarding: the bus's arrival at the BOARDING stop. */}
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Arrives</Text>
                  <Text style={styles.infoValueStrong}>
                    {busArrivesInMin} min
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Board at</Text>
                  <MarqueeText
                    containerStyle={styles.infoValueBox}
                    style={styles.infoValue}
                    align="right"
                    text={boardingStopName ?? ""}
                  />
                </View>
                {leaveByEpoch != null && formatEta(leaveByEpoch) !== "" && (
                  <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>Leave by</Text>
                    <Text style={styles.infoValue}>
                      {formatEta(leaveByEpoch)}
                    </Text>
                  </View>
                )}
              </>
            ) : (
              <>
                {/* On board (or walk-only route): the next stop ahead. */}
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>
                    {heroNextStop?.timeRemaining != null
                      ? "Next stop"
                      : "Arriving"}
                  </Text>
                  <Text style={styles.infoValueStrong}>
                    {heroNextStop?.timeRemaining != null
                      ? Math.max(0, Math.round(heroNextStop.timeRemaining / 60))
                      : (destinationEtaMinutes ?? "--")}{" "}
                    min
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={styles.infoLabel}>Next</Text>
                  <MarqueeText
                    containerStyle={styles.infoValueBox}
                    style={styles.infoValue}
                    align="right"
                    text={
                      heroNextStop?.name ??
                      destinationInfo?.label ??
                      "Destination"
                    }
                  />
                </View>
              </>
            )}
          </View>

        <View style={[styles.content]}>
          <View style={[styles.journeyRail, { backgroundColor: colors.card }]}>
            <View style={styles.railHeaderRow}>
              <MarqueeText
                containerStyle={styles.railDestinationBox}
                style={[styles.railDestination, { color: colors.ink }]}
                align="left"
                text={`To: ${destinationInfo?.label ?? "Destination"}`}
              />
              <View
                style={[styles.arrivalBadge, { backgroundColor: colors.surface2 }]}
              >
                <Text style={[styles.arrivalBadgeText, { color: colors.primary }]}>
                  ETA {arrivalTime ?? "--:--"}
                </Text>
              </View>
            </View>

            <View style={[styles.heroDivider, { backgroundColor: colors.divider }]} />

            {/* Gamified leg rail: checkpoints light green as you advance. */}
            <View style={styles.railTrack}>
              <View style={styles.railInner}>
                <View
                  style={[styles.railBarBase, { backgroundColor: colors.surface2 }]}
                />
                <View
                  style={[
                    styles.railBarFill,
                    {
                      backgroundColor: colors.primary,
                      width: `${Math.min(1, Math.max(0, progressFillPct)) * 100}%` as any,
                    },
                  ]}
                />
                {railNodes.map((n, i) => {
                  const done = n.frac <= progressFillPct + 0.001;
                  return (
                    <View
                      key={i}
                      style={[
                        styles.railNode,
                        {
                          left: `${n.frac * 100}%` as any,
                          backgroundColor: done ? colors.primary : colors.card,
                          borderColor: done ? colors.primary : colors.divider,
                        },
                      ]}
                    >
                      <Ionicons
                        name={n.icon}
                        size={11}
                        color={done ? colors.onPrimary : colors.ink3}
                      />
                    </View>
                  );
                })}
                <View
                  style={[
                    styles.railNode,
                    {
                      left: "100%" as any,
                      backgroundColor:
                        progressFillPct >= 0.999 ? colors.primary : colors.card,
                      borderColor:
                        progressFillPct >= 0.999 ? colors.primary : colors.divider,
                    },
                  ]}
                >
                  <Ionicons
                    name="flag"
                    size={10}
                    color={
                      progressFillPct >= 0.999 ? colors.onPrimary : colors.ink3
                    }
                  />
                </View>
                {progressFillPct > 0.001 && progressFillPct < 0.999 && (
                  <View
                    style={[
                      styles.progressPuck,
                      {
                        left: `${progressFillPct * 100}%` as any,
                        backgroundColor: colors.primary,
                        borderColor: colors.onPrimary,
                      },
                    ]}
                  />
                )}
              </View>
            </View>

            <View style={styles.instructionRow}>
              <Ionicons
                name={activeInstruction.icon}
                size={16}
                color={
                  activeInstruction.mode === "TRANSIT"
                    ? colors.primary
                    : colors.ink
                }
              />
              <Text
                style={[
                  styles.instructionText,
                  {
                    color:
                      activeInstruction.mode === "TRANSIT"
                        ? colors.primary
                        : colors.ink,
                  },
                ]}
                numberOfLines={2}
              >
                {activeInstruction.text}
              </Text>
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
        </BottomSheetScrollView>
      </BottomSheet>
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
      paddingTop: 6,
      paddingBottom: 16,
    },
    heroHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    heroRouteTitle: {
      ...typography.subtitleStrong,
      color: colors.ink,
    },
    heroRouteTitleBox: { flex: 1 },
    heroSpeedBadge: { flexDirection: "row", alignItems: "center", gap: 5 },
    heroSpeedText: { ...typography.captionStrong, color: colors.ink3 },
    heroDivider: {
      height: 1,
      backgroundColor: colors.divider,
      marginTop: 12,
      marginBottom: 4,
    },
    infoRow: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 12,
      paddingVertical: 8,
    },
    infoLabel: {
      ...typography.body,
      color: colors.ink2,
    },
    infoValue: {
      ...typography.bodyStrong,
      color: colors.ink,
      textAlign: "right",
    },
    infoValueBox: { flex: 1 },
    infoValueStrong: {
      ...typography.title,
      fontWeight: "800",
      color: colors.primary,
      flex: 1,
      textAlign: "right",
    },

    // ── Journey rail card (combined journey + boarding) ──
    journeyRail: {
      backgroundColor: colors.card,
      borderRadius: radii.card,
      padding: spacing.card,
      ...shadow.card,
    },
    railHeaderRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 10,
    },
    railDestination: {
      ...typography.metaLg,
      color: colors.ink,
    },
    railDestinationBox: { flex: 1 },
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
    railTrack: {
      height: 40,
      justifyContent: "center",
      paddingHorizontal: 12,
      marginTop: 12,
      marginBottom: 4,
    },
    railInner: {
      position: "relative",
      height: 22,
      justifyContent: "center",
    },
    railBarBase: {
      position: "absolute",
      left: 0,
      right: 0,
      top: 8,
      height: 6,
      borderRadius: 3,
    },
    railBarFill: {
      position: "absolute",
      left: 0,
      top: 8,
      height: 6,
      borderRadius: 3,
    },
    railNode: {
      position: "absolute",
      top: 0,
      marginLeft: -11,
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      alignItems: "center",
      justifyContent: "center",
    },
    progressPuck: {
      position: "absolute",
      top: 4,
      marginLeft: -7,
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 3,
      zIndex: 2,
      shadowColor: semantic.shadow,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.18,
      shadowRadius: 2,
      elevation: 3,
    },
    instructionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 6,
    },
    instructionText: {
      ...typography.bodyStrong,
      flex: 1,
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

    walkDot: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: semantic.walkChipBg,
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
    footerWrap: {
      paddingHorizontal: spacing.screen,
      paddingTop: 8,
      backgroundColor: colors.card,
      borderTopWidth: 1,
      borderTopColor: colors.divider,
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
