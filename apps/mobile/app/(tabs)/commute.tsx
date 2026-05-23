import {
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
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import { theme } from "@/styles/theme";
import { routeStore } from "@/lib/routeStore";
import { decodePolyline } from "@/utils/decodePolyline";
import { normalizeColor } from "@/components/routes/RoutePickerSheet";
import type { Route } from "@/types/places";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const CALGARY_CENTER: [number, number] = [-114.0719, 51.0447];
const MIN_MARKER_ZOOM = 12;

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

  // ── Load from routeStore on focus ────────────────────────────────────────────
  useFocusEffect(
    useCallback(() => {
      const storedRoute = routeStore.getSelectedRoute();
      const storedDest = routeStore.getDestination();
      const storedOrigin = routeStore.getOrigin();

      setRoute(storedRoute);
      if (storedRoute) {
        setCurrentStopIndex(1);
        setCrowdAnswer(null);
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

  // ── GPS subscription ──────────────────────────────────────────────────────────
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

  // ── GPS-based stop advancement ───────────────────────────────────────────────
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

  // ── Filter live vehicles by active route IDs ─────────────────────────────────
  const routeVehicles = useMemo(
    () =>
      transitRouteIds.length === 0
        ? []
        : allVehicles.filter(
            (v) => v.route_id != null && transitRouteIds.includes(v.route_id),
          ),
    [allVehicles, transitRouteIds],
  );

  // ── Convert filtered vehicles to GeoJSON for the SymbolLayer ─────────────────
  const vehiclesGeoJSON = useMemo(
    () => vehiclesToGeoJSON(routeVehicles),
    [routeVehicles],
  );

  // ── Fetch route stops from cache whenever active vehicles change ──────────────
  useEffect(() => {
    if (routeVehicles.length === 0) {
      setRouteStops([]);
      return;
    }

    const tripIds = [
      ...new Set(
        routeVehicles.map((v) => v.trip_id).filter((id): id is string => Boolean(id)),
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

  // ── Route stops GeoJSON ───────────────────────────────────────────────────────
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
              coordinates: [coord.longitude, coord.latitude] as [number, number],
            },
          };
        })
        .filter((f): f is NonNullable<typeof f> => f !== null),
    }),
    [routeStops],
  );

  // ── Fit map to route polyline ─────────────────────────────────────────────────
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

  // ── Polyline GeoJSON: completed (blue) + remaining (line color) ──────────────
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

  // ── Route stops markers (the timeline dots on the map) ───────────────────────
  // These are the Google-route-API stops (origin, transit boundaries, destination)
  // rendered as colored dots reflecting departed/current/destination state.
  const timelineStopsGeoJSON = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: stops
        .filter((s) => s.coordinate)
        .map((s) => ({
          type: "Feature" as const,
          properties: {
            status: s.status,
          },
          geometry: {
            type: "Point" as const,
            coordinates: [s.coordinate!.longitude, s.coordinate!.latitude] as [number, number],
          },
        })),
    }),
    [stops],
  );

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

  const trackDoneHeight = Math.max(0, currentStopIndex * 50);

  const handleExit = useCallback(() => {
    routeStore.clearJourney();
    router.navigate("/(tabs)/routes" as never);
  }, [router]);

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
              initialViewState={{
                center: CALGARY_CENTER,
                zoom: 13,
              }}
            />

            <UserLocation heading={true} animated={true} />

            <Images
              images={{
                tranzitBus: require("@/assets/images/tranzit_busView.png"),
              }}
            />

            {/* Completed + remaining route polylines, data-driven color */}
            <GeoJSONSource id="commute-route-source" data={routePolylinesGeoJSON}>
              <Layer
                id="commute-route-line"
                type="line"
                paint={{
                  "line-color": ["get", "color"],
                  "line-width": 5,
                }}
                layout={{
                  "line-cap": "round",
                  "line-join": "round",
                }}
              />
            </GeoJSONSource>

            {/* All transit stops along the active route's trips */}
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

            {/* Timeline dots (origin, transit boundaries, destination) — colored
                by status via Mapbox's match expression. No React per-dot cost. */}
            <GeoJSONSource id="commute-timeline-source" data={timelineStopsGeoJSON}>
              <Layer
                id="commute-timeline-circle"
                type="circle"
                paint={{
                  "circle-radius": [
                    "match",
                    ["get", "status"],
                    "current", 9,
                    6,
                  ],
                  "circle-color": [
                    "match",
                    ["get", "status"],
                    "departed", theme.colors.primary,
                    "current", theme.colors.primary,
                    "destination", theme.colors.secondary,
                    "#C1C6D7",
                  ],
                  "circle-stroke-color": "white",
                  "circle-stroke-width": [
                    "match",
                    ["get", "status"],
                    "current", 4,
                    2,
                  ],
                }}
              />
            </GeoJSONSource>

            {/* Live buses for the active route(s) */}
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

        <View style={styles.content}>
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
