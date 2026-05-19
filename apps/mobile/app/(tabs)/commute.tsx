import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { supabase } from "@/lib/supabase";
import { BusMarker } from "@/components/busViews";
import { StopMarker } from "@/components/stopViews";
import type { VehiclePosition, CalgaryTransitStop } from "@/types/database";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import { theme } from "@/styles/theme";
import { routeStore } from "@/lib/routeStore";
import { decodePolyline } from "@/utils/decodePolyline";
import { normalizeColor } from "@/components/routes/RoutePickerSheet";
import type { Route } from "@/types/places";

// ─── Types ────────────────────────────────────────────────────────────────────

type CrowdAnswer = "packed" | "clearing" | null;

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
    // Destination must win — it should never be overwritten by "current"
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

// ─── StopItem ─────────────────────────────────────────────────────────────────

function StopItem({ stop }: { stop: CommuteStop }) {
  const isDeparted = stop.status === "departed";
  const isCurrent = stop.status === "current";
  const isDestination = stop.status === "destination";

  const dotBg = isCurrent
    ? "#F9F9FE"
    : isDestination
      ? theme.colors.secondary
      : isDeparted
        ? theme.colors.primary
        : "#C1C6D7";

  const dotBorder = isCurrent ? theme.colors.primary : "#F9F9FE";

  return (
    <View style={styles.stopRow}>
      <View style={styles.stopDotWrapper}>
        <View
          style={[
            styles.stopDot,
            { backgroundColor: dotBg, borderColor: dotBorder, borderWidth: 4 },
            isCurrent && styles.stopDotCurrentRing,
          ]}
        >
          {isDeparted && <Ionicons name="checkmark" size={10} color="white" />}
          {isDestination && (
            <Ionicons name="location" size={11} color={theme.colors.selected} />
          )}
          {isCurrent && <View style={styles.stopDotCurrentInner} />}
        </View>
      </View>

      {isCurrent ? (
        <View style={styles.currentStopCard}>
          <Text style={styles.currentStopName}>{stop.name}</Text>
          <Text style={styles.currentStopLabel}>
            {stop.transitName ? `${stop.transitName} · ` : ""}Current Stop
          </Text>
        </View>
      ) : (
        <View style={styles.stopContent}>
          <Text
            style={[styles.stopName, isDeparted && styles.stopNameDeparted]}
          >
            {stop.name}
          </Text>
          {isDeparted && stop.time && (
            <Text style={styles.stopMeta}>Departed {stop.time}</Text>
          )}
          {stop.status === "upcoming" && stop.time && (
            <Text style={styles.stopMeta}>{stop.time}</Text>
          )}
          {isDestination && stop.time && (
            <Text style={styles.stopMeta}>Destination · {stop.time}</Text>
          )}
          {isDestination && !stop.time && (
            <Text style={styles.stopMeta}>Destination</Text>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function CommuteScreen() {
  const router = useRouter();
  const [crowdAnswer, setCrowdAnswer] = useState<CrowdAnswer>(null);
  const mapRef = useRef<MapView>(null);

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
  const [currentStopIndex, setCurrentStopIndex] = useState(1); // start at first transit stop
  const [routeVehicles, setRouteVehicles] = useState<VehiclePosition[]>([]);
  const [routeStops, setRouteStops] = useState<CalgaryTransitStop[]>([]);
  const [userLocation, setUserLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [currentSpeed, setCurrentSpeed] = useState<number | null>(null);

  const locationSubRef = useRef<Location.LocationSubscription | null>(null);

  // ── Load from routeStore on focus ────────────────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      const storedRoute = routeStore.getSelectedRoute();
      const storedDest = routeStore.getDestination();
      const storedOrigin = routeStore.getOrigin();

      // Always set — null here means clearJourney was called, showing empty state
      setRoute(storedRoute);
      if (storedRoute) {
        setCurrentStopIndex(1);
        setCrowdAnswer(null);
      }
      if (storedDest) setDestinationInfo(storedDest);
      if (storedOrigin) setOriginInfo(storedOrigin);
    }, []),
  );

  // ── Build stops from route ────────────────────────────────────────────────────
  useEffect(() => {
    if (!route) return;
    const originLabel = originInfo?.label ?? "Your location";
    const destLabel = destinationInfo?.label ?? "Destination";
    setRawStops(buildStops(route, originLabel, destLabel));
    setCurrentStopIndex(1);
  }, [route, originInfo?.label, destinationInfo?.label]);

  // ── GPS subscription ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!route) return;

    // Guard against unmount happening before the async subscription resolves
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
              setCurrentSpeed(Math.round(coords.speed * 3.6)); // m/s → km/h
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

  // ── GPS-based stop advancement ───────────────────────────────────────────────
  useEffect(() => {
    if (!userLocation || rawStops.length === 0) return;

    const nextIdx = currentStopIndex + 1;
    if (nextIdx >= rawStops.length - 1) return; // don't auto-advance past destination

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

  // ── Route IDs extracted from the active route's TRANSIT steps ────────────────
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

  // ── Fetch live vehicles for the route, poll every 30s ─────────────────────────
  useEffect(() => {
    if (transitRouteIds.length === 0) {
      setRouteVehicles([]);
      return;
    }

    const fetchVehicles = () =>
      supabase
        .from("vehicle_positions")
        .select("*")
        .in("route_id", transitRouteIds)
        .then(({ data }) => {
          if (data) setRouteVehicles(data as VehiclePosition[]);
        });

    fetchVehicles();
    const id = setInterval(fetchVehicles, 30_000);
    return () => clearInterval(id);
  }, [transitRouteIds]);

  // ── Fetch all stops for those trips whenever vehicles update ──────────────────
  useEffect(() => {
    if (routeVehicles.length === 0) {
      setRouteStops([]);
      return;
    }

    const tripIds = routeVehicles
      .map((v) => v.trip_id)
      .filter((id): id is string => Boolean(id));
    if (tripIds.length === 0) return;

    const now = Math.floor(Date.now() / 1000);
    const fifteenMinAgo = now - 900;

    supabase
      .from("stop_time_updates")
      .select("stop_id")
      .in("trip_id", tripIds)
      .neq("schedule_relationship", "NO_DATA")
      .or(`arrival_time.gte.${fifteenMinAgo},arrival_time.eq.-1`)
      .limit(500)
      .then(async ({ data: rawStus }) => {
        const stus = rawStus as Array<{ stop_id: string | null }> | null;
        if (!stus?.length) return;

        const stopIds = [
          ...new Set(
            stus
              .map((s) => parseInt(s.stop_id ?? "", 10))
              .filter((n) => !isNaN(n)),
          ),
        ];

        const { data: stops } = await supabase
          .from("calgary_transit_stops")
          .select("*")
          .in("teleride_number", stopIds);

        if (stops) setRouteStops(stops as CalgaryTransitStop[]);
      });
  }, [routeVehicles]);

  // ── Fit map to route ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!route?.polyline?.encodedPolyline) return;
    const coords = safeDecodePolyline(route.polyline.encodedPolyline);
    if (coords.length === 0) return;
    setTimeout(() => {
      mapRef.current?.fitToCoordinates(coords, {
        edgePadding: { top: 20, right: 20, bottom: 20, left: 20 },
        animated: true,
      });
    }, 400);
  }, [route]);

  // ── Derived values ────────────────────────────────────────────────────────────

  const stops = useMemo(
    () => applyStatuses(rawStops, currentStopIndex),
    [rawStops, currentStopIndex],
  );

  const routePolylines = useMemo(() => {
    if (!route?.polyline?.encodedPolyline) return [];
    const allCoords = safeDecodePolyline(route.polyline.encodedPolyline);
    if (allCoords.length === 0) return [];

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

    const result: {
      coords: { latitude: number; longitude: number }[];
      color: string;
      strokeWidth: number;
      isDash: boolean;
    }[] = [];

    if (completed.length > 1) {
      result.push({
        coords: completed,
        color: theme.colors.primary,
        strokeWidth: 5,
        isDash: false,
      });
    }
    if (remaining.length > 1) {
      result.push({
        coords: remaining,
        color: lineColor,
        strokeWidth: 5,
        isDash: false,
      });
    }
    return result;
  }, [route, currentStopIndex, stops]);

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
    // Find the first TRANSIT step that is not yet completed
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
    return (km * 0.16).toFixed(1); // ~0.16 kg CO₂/km saved vs car
  }, [route]);

  const activeTransitName =
    stops[currentStopIndex]?.transitName ||
    boardingStep?.transitDetails?.transitLine?.nameShort ||
    boardingStep?.transitDetails?.transitLine?.name ||
    "Transit";

  const trackDoneHeight = Math.max(0, currentStopIndex * 50);

  // ── Exit journey ─────────────────────────────────────────────────────────────
  const handleExit = useCallback(() => {
    routeStore.clearJourney();
    router.navigate("/(tabs)/routes" as never);
  }, [router]);

  // ── Empty state ───────────────────────────────────────────────────────────────
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

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 100 }}
      >
        {/* ── Live Map ── */}
        <View style={styles.mapContainer}>
          <MapView
            ref={mapRef}
            provider={PROVIDER_GOOGLE}
            style={styles.map}
            showsUserLocation
            showsCompass={false}
            showsMyLocationButton={false}
          >
            {/* Route polylines — completed in blue, remaining in line color */}
            {routePolylines.map((sp, i) => (
              <Polyline
                key={`rp-${i}`}
                coordinates={sp.coords}
                strokeColor={sp.color}
                strokeWidth={sp.strokeWidth}
                lineDashPattern={sp.isDash ? [8, 6] : undefined}
              />
            ))}

            {/* Stop markers from route API coordinates */}
            {stops.map((stop) => {
              const coord = stop.coordinate;
              if (!coord) return null;
              return (
                <Marker
                  key={stop.id}
                  coordinate={coord}
                  anchor={{ x: 0.5, y: 0.5 }}
                  tracksViewChanges={false}
                >
                  <View
                    style={[
                      styles.mapDot,
                      stop.status === "departed" && styles.mapDotDone,
                      stop.status === "current" && styles.mapDotCurrent,
                      stop.status === "destination" && styles.mapDotDest,
                    ]}
                  />
                </Marker>
              );
            })}

            {/* All transit stops along the active route's trips */}
            {routeStops
              .filter((s) => s.point != null && s.teleride_number != null)
              .map((s) => (
                <StopMarker
                  key={`commute-stop-${s.teleride_number}`}
                  teleride_number={s.teleride_number!}
                  stop_name={s.stop_name ?? "Unknown Stop"}
                  point={s.point!}
                />
              ))}

            {/* Live buses currently on the active route */}
            {routeVehicles
              .filter(
                (v) =>
                  v.latitude != null &&
                  v.longitude != null &&
                  v.trip_id != null &&
                  v.route_id != null,
              )
              .map((v) => (
                <BusMarker
                  key={`commute-bus-${v.vehicle_id}`}
                  vehicle_id={v.vehicle_id}
                  trip_id={v.trip_id!}
                  route_id={v.route_id!}
                  latitude={v.latitude!}
                  longitude={v.longitude!}
                  bearing={v.bearing ?? 0}
                />
              ))}
          </MapView>

          <View style={styles.liveBadge}>
            <View style={styles.liveBadgeDot} />
            <Text style={styles.liveBadgeText}>LIVE</Text>
          </View>
        </View>

        <View style={styles.content}>
          {/* ── Journey Card ── */}
          <View style={styles.journeyCard}>
            <View style={styles.journeyCardTop}>
              <View>
                <Text style={styles.journeyDestination}>
                  To: {destinationInfo?.label ?? "Destination"}
                </Text>
                <Text style={styles.journeyEta}>
                  Arriving in {etaMinutes ?? "--"} min
                </Text>
              </View>
              <View style={styles.arrivalBadge}>
                <Text style={styles.arrivalBadgeText}>
                  {arrivalTime ?? "--:--"}
                </Text>
              </View>
            </View>

            {/* Progress bar */}
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

          {/* ── Route Progress ── */}
          <View style={styles.progressCard}>
            <View style={styles.sectionLabelRow}>
              <Ionicons
                name="navigate"
                size={15}
                color={theme.colors.primary}
              />
              <Text style={styles.sectionLabel}>ROUTE PROGRESS</Text>
            </View>

            <View style={styles.stopList}>
              <View style={styles.trackBg} />
              <View style={[styles.trackDone, { height: trackDoneHeight }]} />

              {stops.map((stop) => (
                <StopItem key={stop.id} stop={stop} />
              ))}
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

          {/* ── Community Check-in ── */}
          <View style={styles.communityCard}>
            <View style={styles.communityHeader}>
              <MaterialCommunityIcons
                name="account-group"
                size={22}
                color={theme.colors.selected}
              />
              <Text style={styles.communityTitle}>Community Check-in</Text>
            </View>
            <Text style={styles.communityQuestion}>
              Is the{" "}
              <Text style={{ fontWeight: "700" }}>{activeTransitName}</Text>{" "}
              crowded right now?
            </Text>

            <View style={styles.communityOptions}>
              <TouchableOpacity
                style={[
                  styles.communityOption,
                  crowdAnswer === "packed" && styles.communityOptionSelected,
                ]}
                onPress={() => setCrowdAnswer("packed")}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="people"
                  size={24}
                  color={
                    crowdAnswer === "packed" ? theme.colors.primary : "#1A1C1F"
                  }
                />
                <Text
                  style={[
                    styles.communityOptionText,
                    crowdAnswer === "packed" && { color: theme.colors.primary },
                  ]}
                >
                  Yes, Packed
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.communityOption,
                  crowdAnswer === "clearing" && styles.communityOptionSelected,
                ]}
                onPress={() => setCrowdAnswer("clearing")}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="happy-outline"
                  size={24}
                  color={
                    crowdAnswer === "clearing"
                      ? theme.colors.primary
                      : "#1A1C1F"
                  }
                />
                <Text
                  style={[
                    styles.communityOptionText,
                    crowdAnswer === "clearing" && {
                      color: theme.colors.primary,
                    },
                  ]}
                >
                  No, Clearing
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.thankButton} activeOpacity={0.85}>
              <FontAwesome5
                name="thumbs-up"
                size={16}
                color={theme.colors.selected}
              />
              <Text style={styles.thankButtonText}>Thank a Driver</Text>
            </TouchableOpacity>
          </View>

          {/* ── Stats Row ── */}
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Ionicons
                name="speedometer-outline"
                size={18}
                color={theme.colors.primary}
              />
              <Text style={styles.statLabel}>Avg Speed</Text>
              <Text style={styles.statValue}>
                {currentSpeed != null ? `${currentSpeed} km/h` : "-- km/h"}
              </Text>
            </View>
            <View style={styles.statCard}>
              <MaterialCommunityIcons
                name="leaf"
                size={18}
                color={theme.colors.tertiary}
              />
              <Text style={styles.statLabel}>CO₂ Saved</Text>
              <Text style={styles.statValue}>
                {co2Saved != null ? `${co2Saved} kg` : "-- kg"}
              </Text>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* ── End Journey bar ── */}
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
  screen: { flex: 1, backgroundColor: "#F9F9FE" },
  container: { flex: 1 },
  content: {
    paddingHorizontal: theme.spacing.screen,
    gap: theme.spacing.card,
    flexDirection: "column",
  },

  // ── Empty state ──
  emptyScreen: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 32,
    backgroundColor: "#F9F9FE",
  },
  emptyTitle: {
    fontSize: theme.fontSize.title,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  emptySubtitle: {
    fontSize: theme.fontSize.body,
    color: theme.colors.text,
    textAlign: "center",
    lineHeight: 22,
  },

  // ── Map ──
  mapContainer: {
    height: 240,
    backgroundColor: theme.colors.muted,
    marginBottom: theme.spacing.card,
    position: "relative",
  },
  map: { ...StyleSheet.absoluteFillObject },
  liveBadge: {
    position: "absolute",
    top: 14,
    right: 14,
    backgroundColor: "#BA1A1A",
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
  liveBadgeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "white",
  },
  liveBadgeText: {
    color: "white",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  mapDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#C1C6D7",
    borderWidth: 2,
    borderColor: "white",
  },
  mapDotDone: { backgroundColor: theme.colors.primary },
  mapDotCurrent: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.colors.primary,
    borderWidth: 4,
    borderColor: "white",
  },
  mapDotDest: { backgroundColor: theme.colors.secondary },

  // ── Journey Card ──
  journeyCard: {
    backgroundColor: "#F9F9FE",
    borderRadius: 24,
    borderLeftWidth: 6,
    borderLeftColor: theme.colors.secondary,
    padding: theme.spacing.card,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    marginTop: 4,
  },
  journeyCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
  },
  journeyDestination: {
    fontSize: 22,
    fontWeight: "800",
    color: "#1A1C1F",
  },
  journeyEta: {
    fontSize: theme.fontSize.subtitle,
    fontStyle: "italic",
    color: theme.colors.text,
    marginTop: 2,
  },
  arrivalBadge: {
    backgroundColor: "#E8E8ED",
    borderRadius: 99,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  arrivalBadgeText: {
    fontSize: 20,
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
    backgroundColor: "#C1C6D7",
    borderRadius: 99,
    position: "relative",
    justifyContent: "center",
  },
  progressSegmentDone: { backgroundColor: "#0070EB" },
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
  progressLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  progressLabel: {
    flex: 1,
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
  },

  // ── Route Progress Card ──
  progressCard: {
    backgroundColor: "#F3F3F8",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "#E2E2E7",
    padding: theme.spacing.card + 8,
    gap: 20,
  },
  sectionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sectionLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  stopList: { position: "relative", gap: 24 },
  trackBg: {
    position: "absolute",
    left: 11,
    top: 8,
    width: 4,
    bottom: 8,
    backgroundColor: "#C1C6D7",
    borderRadius: 99,
  },
  trackDone: {
    position: "absolute",
    left: 11,
    top: 8,
    width: 4,
    backgroundColor: theme.colors.primary,
    borderRadius: 99,
  },
  stopRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  stopDotWrapper: { width: 26, alignItems: "center" },
  stopDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  stopDotCurrentRing: {
    borderColor: theme.colors.primary,
    borderWidth: 4,
    backgroundColor: "#F9F9FE",
  },
  stopDotCurrentInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.primary,
  },
  stopContent: { flex: 1, gap: 2 },
  stopName: {
    fontSize: theme.fontSize.subtitle,
    color: "#1A1C1F",
    lineHeight: 22,
  },
  stopNameDeparted: {
    textDecorationLine: "line-through",
    opacity: 0.6,
    color: theme.colors.text,
  },
  stopMeta: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
    fontStyle: "italic",
  },
  currentStopCard: {
    flex: 1,
    backgroundColor: "rgba(0,112,235,0.10)",
    borderRadius: 16,
    borderLeftWidth: 4,
    borderLeftColor: theme.colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 2,
  },
  currentStopName: {
    fontSize: theme.fontSize.subtitle,
    color: theme.colors.primary,
    lineHeight: 22,
  },
  currentStopLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.primary,
  },

  // ── Boarding Card ──
  boardingCard: {
    backgroundColor: "#0070EB",
    borderRadius: 24,
    padding: theme.spacing.card + 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    shadowColor: "#0058BC",
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
    color: "rgba(254,252,255,0.8)",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  boardingTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#FEFCFF",
    lineHeight: 26,
  },
  boardingTip: {
    fontSize: theme.fontSize.subtitle,
    color: "rgba(254,252,255,0.9)",
    lineHeight: 22,
    marginTop: 2,
  },

  // ── Community Card ──
  communityCard: {
    backgroundColor: "#F3F3F8",
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "#C1C6D7",
    padding: theme.spacing.card + 8,
    gap: 14,
  },
  communityHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  communityTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  communityQuestion: {
    fontSize: theme.fontSize.subtitle,
    color: theme.colors.text,
    lineHeight: 24,
  },
  communityOptions: {
    flexDirection: "row",
    gap: theme.spacing.element,
  },
  communityOption: {
    flex: 1,
    backgroundColor: "#E2E2E7",
    borderRadius: 20,
    paddingVertical: 20,
    alignItems: "center",
    gap: 6,
    borderWidth: 2,
    borderColor: "transparent",
  },
  communityOptionSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: "rgba(0,88,188,0.08)",
  },
  communityOptionText: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "600",
    color: "#1A1C1F",
  },
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
    color: theme.colors.selected,
  },

  // ── Exit bar ──
  exitBar: {
    backgroundColor: "#F9F9FE",
    paddingHorizontal: theme.spacing.screen,
    paddingTop: 12,
    paddingBottom: 16,
    borderTopWidth: 1,
    borderTopColor: "#E2E2E7",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 8,
  },
  exitBtn: {
    backgroundColor: "#BA1A1A",
    borderRadius: 16,
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

  // ── Stats ──
  statsRow: { flexDirection: "row", gap: theme.spacing.element },
  statCard: {
    flex: 1,
    backgroundColor: theme.colors.muted,
    borderRadius: 20,
    padding: theme.spacing.card,
    gap: 4,
  },
  statLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
    marginTop: 6,
  },
  statValue: { fontSize: 20, fontWeight: "700", color: "#1A1C1F" },
});
