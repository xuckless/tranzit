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
import { middlewareQuery } from "@/lib/middleware";
import { loadAndCacheStops } from "@/lib/transitStopsCache";
import { getStopsByTelerideNumbers } from "@/lib/db";
import { parseWKTPoint } from "@/components/stopViews";
import type { CalgaryTransitStop } from "@/types/database";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import { theme, PASTELS } from "@/styles/theme";
import { routeStore } from "@/lib/routeStore";
import { decodePolyline } from "@/utils/decodePolyline";
import { normalizeColor } from "@/components/routes/RoutePickerSheet";
import type { Route } from "@/types/places";

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

const REPORT_TYPES: ReportType[] = [
  { id: "crowd",  label: "Crowded",      pastel: "sky",      iconLib: "ionicons", icon: "people" },
  { id: "delay",  label: "Delay",        pastel: "butter",   iconLib: "ionicons", icon: "time" },
  { id: "safety", label: "Safety",       pastel: "rose",     iconLib: "ionicons", icon: "shield" },
  { id: "vandal", label: "Vandalism",    pastel: "peach",    iconLib: "fa5",      icon: "spray-can" },
  { id: "cons",   label: "Construction", pastel: "mint",     iconLib: "mci",      icon: "road-barrier" },
  { id: "other",  label: "Other",        pastel: "lavender", iconLib: "ionicons", icon: "sparkles" },
];

const SEVERITY_LABELS = ["A little", "Notable", "Pretty bad", "Critical"];

interface CommuteStop {
  id: string;
  name: string;
  time?: string;
  status: "departed" | "current" | "upcoming" | "destination";
  coordinate?: { latitude: number; longitude: number };
  mode: "WALK" | "TRANSIT";
  transitName?: string;
  transitColor?: string;
}

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
  } catch (e) {
    console.error("[commute] polyline decode failed:", e);
    return [];
  }
}

function parseDurationSecs(duration: string): number | null {
  const secs = parseInt(duration?.replace("s", "") ?? "", 10);
  return isNaN(secs) ? null : secs;
}

function buildStops(
  route: Route,
  originLabel: string,
  destinationLabel: string,
): CommuteStop[] {
  const stops: CommuteStop[] = [];

  stops.push({
    id: "origin",
    name: originLabel,
    status: "departed",
    mode: "WALK",
  });

  const allSteps = (route.legs ?? []).flatMap((l) => l.steps ?? []);
  let idx = 0;

  for (const step of allSteps) {
    if (step.travelMode !== "TRANSIT") continue;
    const td = step.transitDetails;
    const lineName =
      td?.transitLine?.nameShort || td?.transitLine?.name || "Transit";
    const lineColor = normalizeColor(td?.transitLine?.color);

    if (td?.stopDetails?.departureStop?.name) {
      stops.push({
        id: `dep-${idx++}`,
        name: td.stopDetails.departureStop.name,
        time: td.localizedValues?.departureTime?.time?.text,
        status: "upcoming",
        coordinate: td.stopDetails.departureStop.location?.latLng ?? undefined,
        mode: "TRANSIT",
        transitName: lineName,
        transitColor: lineColor,
      });
    }
    if (td?.stopDetails?.arrivalStop?.name) {
      stops.push({
        id: `arr-${idx++}`,
        name: td.stopDetails.arrivalStop.name,
        time: td.localizedValues?.arrivalTime?.time?.text,
        status: "upcoming",
        coordinate: td.stopDetails.arrivalStop.location?.latLng ?? undefined,
        mode: "TRANSIT",
        transitName: lineName,
        transitColor: lineColor,
      });
    }
  }

  stops.push({
    id: "destination",
    name: destinationLabel,
    status: "destination",
    mode: "WALK",
  });

  return stops;
}

function applyStatuses(
  stops: CommuteStop[],
  currentIdx: number,
): CommuteStop[] {
  return stops.map((s, i) => ({
    ...s,
    status:
      i === stops.length - 1
        ? "destination"
        : i < currentIdx
          ? "departed"
          : i === currentIdx
            ? "current"
            : "upcoming",
  }));
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

  // Pulsing ring animation for the current stop
  const pulseScale = useRef(new Animated.Value(0.85)).current;
  const pulseOpacity = useRef(new Animated.Value(0.7)).current;

  useEffect(() => {
    if (!isCurrent) return;
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
  }, [isCurrent]);

  return (
    <View style={styles.stopRow}>
      {/* ── Timeline column ── */}
      <View style={styles.stopTimelineCol}>
        {isCurrent ? (
          <View style={styles.currentDotContainer}>
            <Animated.View
              style={[
                styles.currentDotRing,
                {
                  transform: [{ scale: pulseScale }],
                  opacity: pulseOpacity,
                },
              ]}
            />
            <View style={styles.currentDot}>
              <View style={styles.currentDotCore} />
            </View>
          </View>
        ) : isDeparted ? (
          <View style={styles.departedDot}>
            <Ionicons name="checkmark" size={11} color={theme.colors.ink3} />
          </View>
        ) : isDestination ? (
          <View style={styles.destinationDot}>
            <View style={styles.destinationDotCore} />
          </View>
        ) : (
          <View style={styles.upcomingDot} />
        )}

        {/* Connector line below dot */}
        {connectorType !== "none" &&
          (connectorType === "dashed" ? (
            <View style={styles.connectorDashed} />
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
        ]}
      >
        {isCurrent ? (
          <>
            <View style={styles.stopRowInner}>
              <Text style={styles.currentStopName} numberOfLines={1}>
                {stop.name}
              </Text>
              {stop.time && (
                <Text
                  style={[styles.stopTimeText, { color: theme.colors.primary }]}
                >
                  {stop.time}
                </Text>
              )}
            </View>
            <View style={styles.currentStopChip}>
              <Text style={styles.currentStopChipText}>
                {stop.transitName ? `${stop.transitName} · ` : ""}Current Stop
              </Text>
            </View>
          </>
        ) : (
          <>
            <View style={styles.stopRowInner}>
              <Text
                style={[
                  styles.stopName,
                  isDeparted && styles.stopNameDeparted,
                  isDestination && styles.stopNameDestination,
                ]}
                numberOfLines={1}
              >
                {stop.name}
              </Text>
              {stop.time && (
                <Text
                  style={[styles.stopTimeText, isDeparted && { opacity: 0.5 }]}
                >
                  {stop.time}
                </Text>
              )}
            </View>
            {isDestination && (
              <Text style={styles.destinationLabel}>Final Destination</Text>
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

  const [rawStops, setRawStops] = useState<CommuteStop[]>([]);
  const [currentStopIndex, setCurrentStopIndex] = useState(1);
  const allVehicles = useVehicles();
  const [routeStops, setRouteStops] = useState<CalgaryTransitStop[]>([]);
  const [userLocation, setUserLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);

  const locationSubRef = useRef<Location.LocationSubscription | null>(null);

  // ── Load from routeStore on focus ─────────────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      const storedRoute = routeStore.getSelectedRoute();
      const storedDest = routeStore.getDestination();
      const storedOrigin = routeStore.getOrigin();

      setRoute(storedRoute);
      if (storedRoute) {
        setCurrentStopIndex(1);
        setReportSelected(null);
        setReportSeverity(1);
        setReportSent(false);
      }
      if (storedDest) setDestinationInfo(storedDest);
      if (storedOrigin) setOriginInfo(storedOrigin);
    }, []),
  );

  useEffect(() => {
    if (!route) return;
    const originLabel = originInfo?.label ?? "Your location";
    const destLabel = destinationInfo?.label ?? "Destination";
    setRawStops(buildStops(route, originLabel, destLabel));
    setCurrentStopIndex(1);
  }, [route, originInfo?.label, destinationInfo?.label]);

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
            setUserLocation({
              latitude: coords.latitude,
              longitude: coords.longitude,
            });
            if (coords.speed != null && coords.speed >= 0) {
              setCurrentSpeed(Math.round(coords.speed * 3.6));
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
  }, [route]);

  // ── GPS-based stop advancement ────────────────────────────────────────────
  useEffect(() => {
    if (!userLocation || rawStops.length === 0) return;

    const nextIdx = currentStopIndex + 1;
    if (nextIdx >= rawStops.length - 1) return;

    const nextStop = rawStops[nextIdx];
    if (!nextStop?.coordinate) return;

    const dist = haversineMeters(
      userLocation.latitude,
      userLocation.longitude,
      nextStop.coordinate.latitude,
      nextStop.coordinate.longitude,
    );

    if (dist < 50) {
      setCurrentStopIndex(nextIdx);
    }
  }, [userLocation, rawStops, currentStopIndex]);

  // ── Route IDs from active route's TRANSIT steps ───────────────────────────
  const transitRouteIds = useMemo(() => {
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
  }, [route]);

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

  // ── Fetch route stops ─────────────────────────────────────────────────────
  useEffect(() => {
    if (routeVehicles.length === 0) {
      setRouteStops([]);
      return;
    }

    const tripIds = [
      ...new Set(
        routeVehicles
          .map((v) => v.trip_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (tripIds.length === 0) return;

    const now = Math.floor(Date.now() / 1000);
    const fifteenMinAgo = now - 900;

    (async () => {
      await loadAndCacheStops();

      const rawStopTimes = await middlewareQuery<{ stop_id: string | null }>(
        "stop_time_updates",
        {
          trip_id: `in.(${tripIds.join(",")})`,
          schedule_relationship: "neq.NO_DATA",
          or: `(arrival_time.gte.${fifteenMinAgo},arrival_time.eq.-1)`,
          limit: 500,
        },
      );

      const stopIds = [
        ...new Set(
          rawStopTimes
            .map((s) => parseInt(s.stop_id ?? "", 10))
            .filter((n) => !isNaN(n)),
        ),
      ];

      const stops = await getStopsByTelerideNumbers(stopIds);
      setRouteStops(stops);
    })();
  }, [routeVehicles]);

  const routeStopsGeoJSON = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: routeStops
        .map((s) => {
          const coord = s.point ? parseWKTPoint(s.point) : null;
          if (!coord || s.teleride_number == null) return null;
          return {
            type: "Feature" as const,
            properties: {
              teleride_number: s.teleride_number,
              stop_name: s.stop_name ?? "Unknown Stop",
            },
            geometry: {
              type: "Point" as const,
              coordinates: [coord.longitude, coord.latitude] as [
                number,
                number,
              ],
            },
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null),
    }),
    [routeStops],
  );

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

  const stops = useMemo(
    () => applyStatuses(rawStops, currentStopIndex),
    [rawStops, currentStopIndex],
  );

  // ── Polyline GeoJSON: completed + remaining ───────────────────────────────
  const routePolylinesGeoJSON = useMemo(() => {
    if (!route?.polyline?.encodedPolyline) {
      return { type: "FeatureCollection" as const, features: [] };
    }
    const allCoords = safeDecodePolyline(route.polyline.encodedPolyline);
    if (allCoords.length === 0) {
      return { type: "FeatureCollection" as const, features: [] };
    }

    const currentStop = stops[currentStopIndex];
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
  }, [route, currentStopIndex, stops]);

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
            coordinates: [
              s.coordinate!.longitude,
              s.coordinate!.latitude,
            ] as [number, number],
          },
        })),
    }),
    [stops],
  );

  // ── Derived display values ────────────────────────────────────────────────
  const etaMinutes = useMemo(() => {
    if (!route) return null;
    const secs = parseDurationSecs(route.duration);
    return secs != null ? Math.round(secs / 60) : null;
  }, [route]);

  const arrivalTime = useMemo(() => {
    if (!route) return null;
    const secs = parseDurationSecs(route.duration);
    if (secs == null) return null;
    const arrival = new Date(Date.now() + secs * 1000);
    return arrival.toLocaleTimeString("en-CA", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }, [route]);

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

  const completedProgressSteps = useMemo(() => {
    return Math.floor(
      (currentStopIndex / Math.max(1, stops.length - 1)) *
        progressLabels.length,
    );
  }, [currentStopIndex, stops.length, progressLabels.length]);

  const boardingStep = useMemo(() => {
    if (!route) return null;
    const allSteps = (route.legs ?? []).flatMap((l) => l.steps ?? []);
    const transitStepsWithIndex = allSteps
      .map((s, i) => ({ step: s, i }))
      .filter((x) => x.step.travelMode === "TRANSIT");

    const completedFraction = currentStopIndex / Math.max(1, stops.length - 1);
    const completedStepIdx = Math.floor(completedFraction * allSteps.length);

    const active = transitStepsWithIndex.find((x) => x.i >= completedStepIdx);
    return active?.step ?? transitStepsWithIndex[0]?.step ?? null;
  }, [route, currentStopIndex, stops.length]);

  const co2Saved = useMemo(() => {
    if (!route?.distanceMeters) return null;
    const km = route.distanceMeters / 1000;
    return (km * 0.16).toFixed(1);
  }, [route]);

  const activeTransitName =
    stops[currentStopIndex]?.transitName ||
    boardingStep?.transitDetails?.transitLine?.nameShort ||
    boardingStep?.transitDetails?.transitLine?.name ||
    "Transit";

  // Next/current stop for hero subtitle
  const heroNextStop = useMemo(
    () =>
      stops.find((s) => s.status === "current") ??
      stops.find((s) => s.status === "upcoming"),
    [stops],
  );

  const handleExit = useCallback(() => {
    routeStore.clearJourney();
    router.navigate("/(tabs)/routes" as never);
  }, [router]);

  // ── Empty state ───────────────────────────────────────────────────────────
  if (!route) {
    return (
      <View style={styles.emptyScreen}>
        <Ionicons name="navigate-outline" size={48} color={theme.colors.text} />
        <Text style={styles.emptyTitle}>No Active Journey</Text>
        <Text style={styles.emptySubtitle}>
          Go to Routes, select a route, and tap "Start Journey".
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
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
                  "circle-radius": 4,
                  "circle-color": theme.colors.primary,
                  "circle-stroke-color": "white",
                  "circle-stroke-width": 1.5,
                  "circle-opacity": 0.8,
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
                    "current",
                    9,
                    6,
                  ],
                  "circle-color": [
                    "match",
                    ["get", "status"],
                    "departed",
                    theme.colors.primary,
                    "current",
                    theme.colors.primary,
                    "destination",
                    theme.colors.secondary,
                    "#C1C6D7",
                  ],
                  "circle-stroke-color": "white",
                  "circle-stroke-width": [
                    "match",
                    ["get", "status"],
                    "current",
                    4,
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
            <View style={styles.liveBadgeDot} />
            <Text style={styles.liveBadgeText}>LIVE</Text>
          </View>
        </View>

        {/* ── Hero Section ── */}
        <View style={styles.hero}>
          {boardingStep && (
            <View style={styles.lineBadge}>
              <Ionicons
                name="bus-outline"
                size={13}
                color={theme.colors.primaryInk}
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
          )}

          {co2Saved != null && (
            <View style={styles.heroCo2Row}>
              <MaterialCommunityIcons name="leaf" size={14} color={theme.colors.primaryInk} />
              <Text style={styles.heroCo2Text}>{co2Saved} kg CO₂ saved</Text>
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
          <View style={styles.journeyCard}>
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
                <Text style={styles.arrivalBadgeText}>
                  {arrivalTime ?? "--:--"}
                </Text>
              </View>
            </View>

            <View style={styles.progressRow}>
              {progressLabels.map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.progressSegment,
                    i < completedProgressSteps && styles.progressSegmentDone,
                  ]}
                >
                  {i === completedProgressSteps - 1 && (
                    <View style={styles.progressThumb} />
                  )}
                </View>
              ))}
            </View>

            <View style={styles.progressLabels}>
              {progressLabels.map((label, i) => (
                <Text
                  key={i}
                  style={[
                    styles.progressLabel,
                    i < completedProgressSteps && {
                      color: theme.colors.primary,
                    },
                  ]}
                >
                  {label}
                </Text>
              ))}
            </View>
          </View>

          {/* ── Route Progress Timeline ── */}
          <View style={styles.timelineCard}>
            <View style={styles.sectionLabelRow}>
              <Ionicons
                name="navigate"
                size={15}
                color={theme.colors.primary}
              />
              <Text style={styles.sectionLabel}>ROUTE PROGRESS</Text>
            </View>

            <View style={styles.stopList}>
              {stops.map((stop, i) => {
                const isLast = i === stops.length - 1;
                let connectorType: ConnectorType = "none";
                if (!isLast) {
                  const next = stops[i + 1];
                  if (
                    stop.status === "departed" &&
                    next?.status === "departed"
                  ) {
                    connectorType = "solid-gray";
                  } else if (
                    stop.status === "departed" &&
                    next?.status === "current"
                  ) {
                    connectorType = "solid-primary";
                  } else {
                    connectorType = "dashed";
                  }
                }
                return (
                  <StopItem
                    key={stop.id}
                    stop={stop}
                    connectorType={connectorType}
                  />
                );
              })}
            </View>
          </View>

          {/* ── Boarding Instruction ── */}
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
                  color={theme.colors.primary}
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

          {/* ── Community Reports ── */}
          <View style={styles.communityCard}>
            <View style={styles.communityHeader}>
              <MaterialCommunityIcons
                name="account-group"
                size={22}
                color={theme.colors.selected}
              />
              <Text style={styles.communityTitle}>Community Reports</Text>
            </View>

            {reportSent ? (
              /* Thank-you inline state */
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

                {/* 2-column category grid */}
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

                {/* Severity stepper — appears after category selection */}
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

                {/* Send button */}
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

            {/* Thank a Driver — always visible */}
            <TouchableOpacity style={styles.thankButton} activeOpacity={0.85}>
              <FontAwesome5
                name="thumbs-up"
                size={16}
                color={theme.colors.selected}
              />
              <Text style={styles.thankButtonText}>Thank a Driver</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      {/* ── End Journey Bar ── */}
      <View style={styles.exitBar}>
        <TouchableOpacity
          style={styles.exitBtn}
          onPress={handleExit}
          activeOpacity={0.85}
        >
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
  liveBadgeText: { color: "white", fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },

  // ── Hero ─────────────────────────────────────────────────────────────────
  hero: {
    paddingHorizontal: theme.spacing.screen,
    paddingTop: 22,
    paddingBottom: 18,
    backgroundColor: theme.colors.surface,
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
    marginBottom: 10,
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
    marginBottom: 8,
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
  heroSpeedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  heroSpeedText: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.ink2,
  },
  heroEtaNum: {
    fontSize: 52,
    fontWeight: "800",
    color: theme.colors.ink,
    letterSpacing: -1.5,
    lineHeight: 60,
    marginBottom: 6,
  },
  heroEtaUnit: {
    fontSize: 28,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  heroNextStop: {
    fontSize: 16,
    color: theme.colors.ink2,
    lineHeight: 24,
  },
  heroNextStopName: {
    fontWeight: "700",
    color: theme.colors.ink,
  },

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
  journeyDestination: {
    fontSize: 17,
    fontWeight: "700",
    color: theme.colors.ink,
  },
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
  arrivalBadgeText: {
    fontSize: 18,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  progressRow: {
    flexDirection: "row",
    gap: 4,
    alignItems: "center",
    marginBottom: 8,
  },
  progressSegment: {
    flex: 1,
    height: 10,
    backgroundColor: theme.colors.surface2,
    borderRadius: 99,
    position: "relative",
    justifyContent: "center",
  },
  progressSegmentDone: { backgroundColor: theme.colors.primary },
  progressThumb: {
    position: "absolute",
    right: -2,
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
  stopRow: {
    flexDirection: "row",
    gap: 12,
    minHeight: 72,
  },

  // ── Timeline column ──────────────────────────────────────────────────────
  stopTimelineCol: {
    width: 32,
    alignItems: "center",
    alignSelf: "stretch",
  },

  // Current dot (pulsing)
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
    backgroundColor: theme.colors.primary,
  },
  currentDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.colors.primary,
    borderWidth: 3,
    borderColor: "white",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
  currentDotCore: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "white",
  },

  // Departed dot
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

  // Destination dot
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
  destinationDotCore: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#BBCBB9",
  },

  // Upcoming dot
  upcomingDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.colors.card,
    borderWidth: 2,
    borderColor: "#BBCBB9",
    marginTop: 10,
  },

  // Connectors
  connectorSolid: {
    flex: 1,
    width: 2,
    marginTop: 3,
    borderRadius: 1,
  },
  connectorDashed: {
    flex: 1,
    width: 0,
    borderLeftWidth: 2,
    borderLeftColor: "#BBCBB9",
    borderStyle: "dashed",
    marginTop: 3,
  },

  // ── Stop content ─────────────────────────────────────────────────────────
  stopContentOuter: {
    flex: 1,
    paddingBottom: 20,
    paddingTop: 6,
    gap: 3,
  },
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
  stopRowInner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 8,
  },
  stopName: {
    flex: 1,
    fontSize: 15,
    color: theme.colors.ink,
    lineHeight: 22,
  },
  stopNameDeparted: {
    textDecorationLine: "line-through",
    color: theme.colors.ink3,
  },
  stopNameDestination: {
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.ink,
  },
  currentStopName: {
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    color: theme.colors.primary,
    lineHeight: 22,
  },
  stopTimeText: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.ink2,
  },
  currentStopChip: {
    backgroundColor: theme.colors.surface,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  currentStopChipText: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.ink2,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  destinationLabel: {
    fontSize: 12,
    color: theme.colors.ink3,
    fontStyle: "italic",
  },

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
  boardingTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "white",
    lineHeight: 26,
  },
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
  communityQuestion: {
    fontSize: theme.fontSize.subtitle,
    color: theme.colors.ink2,
    lineHeight: 24,
  },

  // Report category grid
  reportGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
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
  reportGridLabel: {
    fontSize: 15,
    fontWeight: "700",
    color: theme.colors.ink,
  },
  reportGridLabelActive: {
    color: theme.colors.primary,
  },

  // Severity stepper
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
  severityChipText: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.ink2,
  },
  severityChipTextActive: {
    color: theme.colors.primaryInk,
  },

  // Send report button
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
  reportSendBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.2,
  },

  // Inline thank-you
  reportThanks: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
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
  reportThanksBody: {
    fontSize: 14,
    color: theme.colors.ink2,
    textAlign: "center",
    lineHeight: 22,
  },
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
  reportAgainBtnText: {
    fontSize: 15,
    fontWeight: "600",
    color: theme.colors.ink,
  },

  // Thank a Driver button
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
  exitBtnText: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "700",
    color: "white",
  },
});
