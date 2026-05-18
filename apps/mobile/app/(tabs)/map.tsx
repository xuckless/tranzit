import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Dimensions,
  PanResponder,
  Animated,
  Keyboard,
} from "react-native";
import { SearchSheet } from "@/components/search/SearchSheet";
import {
  RoutePickerSheet,
  StepChips,
  formatDuration,
  normalizeColor,
} from "@/components/routes/RoutePickerSheet";
import type { SelectedDestination, Route } from "@/types/places";
import MapView, { Marker, Polyline, Region } from "react-native-maps";
import type { LatLng } from "react-native-maps";
import polyline from "@mapbox/polyline";
import { TranzitApiService } from "@/services/TranzitApiService";
import mapStyle from "@/assets/map-style.json";
import { useState, useEffect, useRef, useCallback } from "react";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import { theme } from "@/styles/theme";
import Svg, {
  Path,
  Circle,
  Defs,
  RadialGradient,
  Stop,
} from "react-native-svg";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

const SNAP_COLLAPSED = SCREEN_HEIGHT * 0.28;
const SNAP_EXPANDED = SCREEN_HEIGHT * 0.62;
const DELTA = { latitudeDelta: 0.01, longitudeDelta: 0.01 };

// ─── Types ────────────────────────────────────────────────────────────────────

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface PressedPin {
  coordinate: Coordinate;
  placeId: string;
  address: string;
  isResolving: boolean;
}

interface PolylineSegment {
  key: string;
  coordinates: LatLng[];
  mode: "WALK" | "TRANSIT";
  color: string;
  strokeWidth: number;
  lineDashPattern?: number[];
}

type RoutePhase =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "picking"; routes: Route[] }
  | { status: "active"; route: Route; segments: PolylineSegment[] };

// ─── Route helpers ────────────────────────────────────────────────────────────

function buildPolylineSegments(route: Route): PolylineSegment[] {
  const segments: PolylineSegment[] = [];

  let stepIndex = 0;
  for (const leg of route.legs) {
    for (const step of leg.steps) {
      const encoded = step.polyline?.encodedPolyline;
      if (encoded) {
        const coordinates = polyline
          .decode(encoded)
          .map(([lat, lng]) => ({ latitude: lat, longitude: lng }));

        if (step.travelMode === "WALK") {
          segments.push({
            key: `walk-${stepIndex}`,
            coordinates,
            mode: "WALK",
            color: "#9E9E9E",
            strokeWidth: 3,
            lineDashPattern: [2, 6],
          });
        } else {
          const rawColor = step.transitDetails?.transitLine?.color;
          segments.push({
            key: `transit-${stepIndex}`,
            coordinates,
            mode: "TRANSIT",
            color: normalizeColor(rawColor),
            strokeWidth: 5,
          });
        }
      }
      stepIndex++;
    }
  }

  // Fallback: no step-level polylines — render the whole route as one line
  if (segments.length === 0) {
    const coordinates = polyline
      .decode(route.polyline.encodedPolyline)
      .map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
    segments.push({
      key: "route-fallback",
      coordinates,
      mode: "TRANSIT",
      color: theme.colors.primary,
      strokeWidth: 5,
    });
  }

  return segments;
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const QUICK_ACCESS = [
  { id: "home", label: "Home", icon: "home", color: theme.colors.primary },
  { id: "work", label: "Work", icon: "briefcase", color: "#0070EB" },
  {
    id: "school",
    label: "University",
    icon: "university",
    color: theme.colors.selected,
  },
  { id: "gym", label: "Gym", icon: "dumbbell", color: theme.colors.tertiary },
];

const NEARBY_STOPS = [
  {
    id: "1",
    name: "Centre St & 5 Ave N",
    route: "CTrain Red",
    eta: "2 min",
    type: "ctrain",
  },
  {
    id: "2",
    name: "7 Ave SW Station",
    route: "CTrain Blue",
    eta: "5 min",
    type: "ctrain",
  },
  {
    id: "3",
    name: "4 St SW & 9 Ave SW",
    route: "Route 7",
    eta: "8 min",
    type: "bus",
  },
  {
    id: "4",
    name: "Macleod Tr & 10 Ave SE",
    route: "Route 302",
    eta: "11 min",
    type: "bus",
  },
];

const STOP_COLOR: Record<string, string> = {
  ctrain: theme.colors.primary,
  bus: "#E0A000",
};

// ─── Direction Marker ─────────────────────────────────────────────────────────

function DirectionMarker({ heading }: { heading: number }) {
  const SIZE = 80,
    cx = 40,
    cy = 40,
    DOT_R = 10,
    ARC_R = 34,
    HALF = 30;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const sa = toRad(heading - HALF - 90);
  const ea = toRad(heading + HALF - 90);
  const x1 = cx + ARC_R * Math.cos(sa),
    y1 = cy + ARC_R * Math.sin(sa);
  const x2 = cx + ARC_R * Math.cos(ea),
    y2 = cy + ARC_R * Math.sin(ea);
  const arcPath = `M ${cx} ${cy} L ${x1.toFixed(3)} ${y1.toFixed(3)} A ${ARC_R} ${ARC_R} 0 0 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z`;

  return (
    <Svg width={SIZE} height={SIZE}>
      <Defs>
        <RadialGradient id="coneGrad" cx="50%" cy="50%" r="50%">
          <Stop
            offset="0%"
            stopColor={theme.colors.primary}
            stopOpacity="0.5"
          />
          <Stop
            offset="100%"
            stopColor={theme.colors.primary}
            stopOpacity="0.0"
          />
        </RadialGradient>
      </Defs>
      <Path d={arcPath} fill="url(#coneGrad)" />
      <Circle cx={cx} cy={cy} r={DOT_R + 8} fill="rgba(0,88,188,0.10)" />
      <Circle cx={cx} cy={cy} r={DOT_R + 1} fill="white" />
      <Circle cx={cx} cy={cy} r={DOT_R - 2} fill={theme.colors.primary} />
    </Svg>
  );
}

// ─── Active Route Banner ──────────────────────────────────────────────────────

function ActiveRouteBanner({
  route,
  onChangeRoute,
  onClearRoute,
}: {
  route: Route;
  onChangeRoute: () => void;
  onClearRoute: () => void;
}) {
  const allSteps = route.legs.flatMap((l) => l.steps);

  return (
    <View style={activeBannerStyles.container}>
      <View style={activeBannerStyles.left}>
        <Text style={activeBannerStyles.duration}>
          {formatDuration(route.duration)}
        </Text>
        <StepChips steps={allSteps} />
      </View>
      <View style={activeBannerStyles.actions}>
        <TouchableOpacity
          style={activeBannerStyles.changeBtn}
          onPress={onChangeRoute}
          activeOpacity={0.8}
        >
          <Text style={activeBannerStyles.changeBtnText}>Change</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onClearRoute}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close-circle" size={22} color={theme.colors.text} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const activeBannerStyles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: theme.spacing.screen,
    marginBottom: 12,
    padding: 12,
    borderRadius: 16,
    backgroundColor: theme.colors.primary + "0D",
    borderWidth: 1.5,
    borderColor: theme.colors.primary + "30",
  },
  left: { flex: 1, gap: 6 },
  duration: {
    fontSize: 20,
    fontWeight: "800",
    color: theme.colors.primary,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  changeBtn: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
  },
  changeBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "white",
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function MapScreen() {
  const mapRef = useRef<MapView>(null);
  const sheetAnim = useRef(new Animated.Value(SNAP_COLLAPSED)).current;
  const lastSnap = useRef(SNAP_COLLAPSED);
  const headingRef = useRef(0);

  const [userLocation, setUserLocation] = useState<Coordinate | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [destination, setDestination] = useState<Coordinate | null>(null);

  const [heading, setHeading] = useState(0);
  const [loadingLocation, setLoadingLocation] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isSearchActive, setIsSearchActive] = useState(false);

  const [pressedPin, setPressedPin] = useState<PressedPin | null>(null);
  const pressAbortRef = useRef<AbortController | null>(null);

  const [routePhase, setRoutePhase] = useState<RoutePhase>({ status: "idle" });
  const routeAbortRef = useRef<AbortController | null>(null);

  // ── Heading ───────────────────────────────────────────────────────────────────
  const smoothHeading = (raw: number) => {
    let d = raw - headingRef.current;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    headingRef.current += d;
    setHeading(headingRef.current);
  };

  // ── Sheet snap ────────────────────────────────────────────────────────────────
  const snapTo = useCallback(
    (target: number) => {
      lastSnap.current = target;
      setIsExpanded(target === SNAP_EXPANDED);
      Animated.spring(sheetAnim, {
        toValue: target,
        useNativeDriver: false,
        bounciness: 3,
        speed: 14,
      }).start();
    },
    [sheetAnim],
  );

  // ── Pan responder ─────────────────────────────────────────────────────────────
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_, g) => {
        const next = Math.max(
          SNAP_COLLAPSED,
          Math.min(SNAP_EXPANDED, lastSnap.current - g.dy),
        );
        sheetAnim.setValue(next);
      },
      onPanResponderRelease: (_, g) => {
        const projected = lastSnap.current - g.dy;
        const mid = (SNAP_COLLAPSED + SNAP_EXPANDED) / 2;
        snapTo(g.vy < -0.4 || projected > mid ? SNAP_EXPANDED : SNAP_COLLAPSED);
      },
    }),
  ).current;

  // ── Route fetching ────────────────────────────────────────────────────────────
  const fetchRoute = useCallback(
    async (placeId: string, origin: Coordinate) => {
      routeAbortRef.current?.abort();
      const controller = new AbortController();
      routeAbortRef.current = controller;
      setRoutePhase({ status: "loading" });
      setPressedPin(null);

      try {
        const response = await TranzitApiService.getRoute(
          {
            origin: { lat: origin.latitude, lng: origin.longitude },
            destination_id: placeId,
          },
          controller.signal,
        );

        if (response.routes.length === 0) {
          setRoutePhase({ status: "idle" });
          return;
        }

        setRoutePhase({ status: "picking", routes: response.routes });
        snapTo(SNAP_EXPANDED);
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") return;
        setRoutePhase({ status: "idle" });
      }
    },
    [snapTo],
  );

  // ── Route selection (Phase 1 → Phase 2) ──────────────────────────────────────
  const handleSelectRoute = useCallback(
    (route: Route) => {
      const segments = buildPolylineSegments(route);
      setRoutePhase({ status: "active", route, segments });
      snapTo(SNAP_COLLAPSED);

      const allCoords = segments.flatMap((s) => s.coordinates);
      if (allCoords.length > 0) {
        mapRef.current?.fitToCoordinates(allCoords, {
          edgePadding: {
            top: 80,
            right: 40,
            bottom: SNAP_COLLAPSED + 40,
            left: 40,
          },
          animated: true,
        });
      }
    },
    [snapTo],
  );

  // ── Reset everything ──────────────────────────────────────────────────────────
  const clearAll = useCallback(() => {
    pressAbortRef.current?.abort();
    routeAbortRef.current?.abort();
    setPressedPin(null);
    setDestination(null);
    setRoutePhase({ status: "idle" });
  }, []);

  // ── SearchSheet callbacks ─────────────────────────────────────────────────────
  const handleDestinationSelected = useCallback(
    (dest: SelectedDestination) => {
      Keyboard.dismiss();
      setDestination(dest.coordinate);
      pressAbortRef.current?.abort();
      setPressedPin(null);

      const destRegion: Region = { ...dest.coordinate, ...DELTA };
      setRegion(destRegion);
      mapRef.current?.animateToRegion(destRegion, 900);

      if (userLocation) fetchRoute(dest.placeId, userLocation);
    },
    [userLocation, fetchRoute],
  );

  const handleClear = useCallback(() => {
    clearAll();
    if (userLocation) {
      const userRegion: Region = { ...userLocation, ...DELTA };
      setRegion(userRegion);
      mapRef.current?.animateToRegion(userRegion, 600);
    }
  }, [userLocation, clearAll]);

  // ── Location ──────────────────────────────────────────────────────────────────
  const requestLocationPermission = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      setErrorMsg("Location permission denied.");
      return;
    }
    setHasPermission(true);
  };

  const fetchCurrentLocation = async () => {
    try {
      setLoadingLocation(true);
      setErrorMsg(null);
      const { coords } = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.BestForNavigation,
      });
      const coord: Coordinate = {
        latitude: coords.latitude,
        longitude: coords.longitude,
      };
      setUserLocation(coord);
      const newRegion: Region = { ...coord, ...DELTA };
      setRegion(newRegion);
      if (coords.heading != null && coords.heading >= 0)
        smoothHeading(coords.heading);
      mapRef.current?.animateToRegion(newRegion, 800);
    } catch {
      setErrorMsg("Could not get your location.");
    } finally {
      setLoadingLocation(false);
    }
  };

  // ── Map press (dropped pin) ───────────────────────────────────────────────────
  const handleMapPress = useCallback(
    async (coord: Coordinate) => {
      pressAbortRef.current?.abort();
      const controller = new AbortController();
      pressAbortRef.current = controller;

      Keyboard.dismiss();
      setIsSearchActive(false);

      // Clear any active route — user is starting a new destination flow
      routeAbortRef.current?.abort();
      setRoutePhase({ status: "idle" });

      setDestination(coord);
      setPressedPin({
        coordinate: coord,
        placeId: "",
        address: `${coord.latitude.toFixed(4)}, ${coord.longitude.toFixed(4)}`,
        isResolving: true,
      });

      snapTo(SNAP_COLLAPSED);
      mapRef.current?.animateCamera(
        { center: coord, zoom: 15 },
        { duration: 500 },
      );

      try {
        const query = `${coord.latitude.toFixed(5)},${coord.longitude.toFixed(5)}`;
        const places = await TranzitApiService.searchPlaces(
          query,
          coord,
          controller.signal,
        );
        const place = places[0];
        if (place) {
          setPressedPin({
            coordinate: coord,
            placeId: place.id,
            address: place.displayName.text,
            isResolving: false,
          });
          return;
        }
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") return;
      }

      setPressedPin((prev) => (prev ? { ...prev, isResolving: false } : null));
    },
    [snapTo],
  );

  const dismissPressedPin = useCallback(() => {
    pressAbortRef.current?.abort();
    setPressedPin(null);
    setDestination(null);
    setRoutePhase({ status: "idle" });
    routeAbortRef.current?.abort();
  }, []);

  // ── Location subscription ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasPermission) return;
    let posSub: Location.LocationSubscription;
    let headSub: Location.LocationSubscription;
    (async () => {
      posSub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          distanceInterval: 2,
          timeInterval: 1000,
        },
        ({ coords }) => {
          setUserLocation({
            latitude: coords.latitude,
            longitude: coords.longitude,
          });
          if (coords.heading != null && coords.heading >= 0)
            smoothHeading(coords.heading);
        },
      );
      headSub = await Location.watchHeadingAsync(
        ({ trueHeading, magHeading }) =>
          smoothHeading(trueHeading >= 0 ? trueHeading : magHeading),
      );
    })();
    return () => {
      posSub?.remove();
      headSub?.remove();
    };
  }, [hasPermission]);

  useEffect(() => {
    requestLocationPermission();
  }, []);
  useEffect(() => {
    if (hasPermission) fetchCurrentLocation();
  }, [hasPermission]);

  // ── Derived flags ─────────────────────────────────────────────────────────────
  const isRouteActive = routePhase.status !== "idle";
  const sheetHint =
    routePhase.status === "loading"
      ? "Finding routes…"
      : routePhase.status === "picking"
        ? "Choose a route"
        : routePhase.status === "active"
          ? "Route active"
          : isExpanded
            ? "Nearby Stops"
            : "Explore";

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* ── Map ── */}
      <MapView
        ref={mapRef}
        customMapStyle={mapStyle}
        style={styles.map}
        showsUserLocation={false}
        showsCompass={true}
        onPress={(e) => {
          if (!isSearchActive) handleMapPress(e.nativeEvent.coordinate);
        }}
        onLongPress={(e) => handleMapPress(e.nativeEvent.coordinate)}
        initialRegion={{
          latitude: 51.070664,
          longitude: -114.059263,
          ...DELTA,
        }}
      >
        {/* User location dot */}
        {userLocation && (
          <Marker
            coordinate={userLocation}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            tracksViewChanges={false}
          >
            <DirectionMarker heading={heading} />
          </Marker>
        )}

        {/* Destination pin */}
        {destination && (
          <Marker
            coordinate={destination}
            anchor={{ x: 0.5, y: 1.0 }}
            tracksViewChanges={false}
            pinColor={theme.colors.primary}
          />
        )}

        {/* Per-segment polylines (walk = dotted, transit = solid + line color) */}
        {routePhase.status === "active" &&
          routePhase.segments.map((seg) => (
            <Polyline
              key={seg.key}
              coordinates={seg.coordinates}
              strokeColor={seg.color}
              strokeWidth={seg.strokeWidth}
              lineDashPattern={seg.lineDashPattern}
              zIndex={seg.mode === "TRANSIT" ? 2 : 1}
            />
          ))}
      </MapView>

      {/* ── Re-center button ── */}
      <TouchableOpacity
        style={styles.recenterButton}
        onPress={fetchCurrentLocation}
        activeOpacity={0.85}
        disabled={loadingLocation}
      >
        {loadingLocation ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : (
          <Ionicons name="locate" size={22} color={theme.colors.primary} />
        )}
      </TouchableOpacity>

      {/* ── Route loading badge (above the sheet) ── */}
      {routePhase.status === "loading" && (
        <View style={styles.routeLoadingBadge}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={styles.routeLoadingText}>Finding routes…</Text>
        </View>
      )}

      {/* ── Error banner ── */}
      {errorMsg && (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={15} color="#BA1A1A" />
          <Text style={styles.errorText}>{errorMsg}</Text>
        </View>
      )}

      {/* ════════ BOTTOM SHEET ════════ */}
      <Animated.View style={[styles.sheet, { height: sheetAnim }]}>
        {/* Drag handle */}
        <View {...panResponder.panHandlers} style={styles.handleArea}>
          <View style={styles.handle} />
          <Text style={styles.handleHint}>{sheetHint}</Text>
        </View>

        {/* ── Pressed pin card (idle only) ── */}
        {pressedPin && !isSearchActive && routePhase.status === "idle" && (
          <View style={styles.pinCard}>
            <View style={styles.pinCardLeft}>
              <View style={styles.pinIconBox}>
                <Ionicons name="location" size={18} color={theme.colors.primary} />
              </View>
              <View style={styles.pinTextBlock}>
                <Text style={styles.pinLabel}>Dropped pin</Text>
                {pressedPin.isResolving ? (
                  <View style={styles.pinResolveRow}>
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                    <Text style={styles.pinResolving}>Resolving address…</Text>
                  </View>
                ) : (
                  <Text style={styles.pinAddress} numberOfLines={2}>
                    {pressedPin.address}
                  </Text>
                )}
              </View>
            </View>
            <View style={styles.pinActions}>
              <TouchableOpacity
                style={styles.pinCta}
                activeOpacity={0.85}
                disabled={pressedPin.isResolving || !pressedPin.placeId}
                onPress={() => {
                  if (!pressedPin.placeId || !userLocation) return;
                  fetchRoute(pressedPin.placeId, userLocation);
                }}
              >
                <Ionicons name="navigate" size={15} color="white" />
                <Text style={styles.pinCtaText}>Go</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={dismissPressedPin}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close-circle" size={22} color={theme.colors.text} />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Search bar (always visible) ── */}
        <SearchSheet
          userLocation={userLocation}
          onDestinationSelected={handleDestinationSelected}
          onSearchActiveChange={(active) => {
            setIsSearchActive(active);
            if (active) snapTo(SNAP_EXPANDED);
          }}
          onClear={handleClear}
        />

        {/* ── Phase: route picker ── */}
        {!isSearchActive && routePhase.status === "picking" && (
          <RoutePickerSheet
            routes={routePhase.routes}
            onSelectRoute={handleSelectRoute}
          />
        )}

        {/* ── Phase: active route banner ── */}
        {!isSearchActive && routePhase.status === "active" && (
          <ActiveRouteBanner
            route={routePhase.route}
            onChangeRoute={() => {
              if (routePhase.status === "active") {
                setRoutePhase({ status: "picking", routes: [routePhase.route] });
                snapTo(SNAP_EXPANDED);
              }
            }}
            onClearRoute={handleClear}
          />
        )}

        {/* ── Quick access chips (idle, no active search or route) ── */}
        {!isSearchActive && !isRouteActive && (
          <View style={styles.sectionWrap}>
            <Text style={styles.sectionLabel}>Quick Access</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.quickRow}
            >
              {QUICK_ACCESS.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.quickChip}
                  activeOpacity={0.8}
                >
                  <View
                    style={[
                      styles.quickIconBox,
                      { backgroundColor: item.color + "18" },
                    ]}
                  >
                    <FontAwesome5
                      name={item.icon as any}
                      size={14}
                      color={item.color}
                    />
                  </View>
                  <Text style={styles.quickLabel}>{item.label}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={styles.quickChip} activeOpacity={0.8}>
                <View
                  style={[
                    styles.quickIconBox,
                    { backgroundColor: theme.colors.muted },
                  ]}
                >
                  <Ionicons name="add" size={16} color={theme.colors.text} />
                </View>
                <Text style={styles.quickLabel}>Add</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}

        {/* ── Nearby stops (expanded, idle only) ── */}
        {isExpanded && !isSearchActive && !isRouteActive && (
          <View style={styles.nearbyWrap}>
            <View style={styles.nearbyHeader}>
              <View style={styles.nearbyTitleRow}>
                <Ionicons
                  name="radio-button-on"
                  size={14}
                  color={theme.colors.primary}
                />
                <Text style={styles.sectionLabel}>Nearby Stops</Text>
              </View>
              <TouchableOpacity>
                <Text style={styles.seeAll}>See all</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {NEARBY_STOPS.map((stop, i) => (
                <TouchableOpacity
                  key={stop.id}
                  style={[
                    styles.stopRow,
                    i === NEARBY_STOPS.length - 1 && { borderBottomWidth: 0 },
                  ]}
                  activeOpacity={0.75}
                >
                  <View
                    style={[
                      styles.stopIconBox,
                      { backgroundColor: STOP_COLOR[stop.type] + "15" },
                    ]}
                  >
                    <FontAwesome5
                      name={stop.type === "bus" ? "bus" : "subway"}
                      size={13}
                      color={STOP_COLOR[stop.type]}
                    />
                  </View>
                  <View style={styles.stopInfo}>
                    <Text style={styles.stopName} numberOfLines={1}>
                      {stop.name}
                    </Text>
                    <Text style={styles.stopRoute}>{stop.route}</Text>
                  </View>
                  <View
                    style={[
                      styles.etaChip,
                      { backgroundColor: STOP_COLOR[stop.type] + "15" },
                    ]}
                  >
                    <Text
                      style={[
                        styles.etaText,
                        { color: STOP_COLOR[stop.type] },
                      ]}
                    >
                      {stop.eta}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
      </Animated.View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.neutral },
  map: { ...StyleSheet.absoluteFillObject },

  recenterButton: {
    position: "absolute",
    bottom: SNAP_COLLAPSED + 16,
    right: 16,
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "white",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 6,
  },

  // ── Loading badge ──
  routeLoadingBadge: {
    position: "absolute",
    top: 16,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "white",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 9,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 6,
  },
  routeLoadingText: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.primary,
  },

  // ── Error banner ──
  errorBanner: {
    position: "absolute",
    top: 16,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FFEDEA",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: "#FFCDC7",
  },
  errorText: { fontSize: 13, fontWeight: "600", color: "#BA1A1A" },

  // ── Sheet ──
  sheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "white",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 24,
  },
  handleArea: { alignItems: "center", paddingTop: 10, paddingBottom: 6 },
  handle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#DEDEDE",
    marginBottom: 6,
  },
  handleHint: {
    fontSize: 11,
    fontWeight: "700",
    color: "#B0B4BF",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },

  // ── Quick access ──
  sectionWrap: { paddingHorizontal: theme.spacing.screen, marginBottom: 4 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.colors.text,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 10,
  },
  quickRow: { gap: 14, paddingBottom: 2 },
  quickChip: { alignItems: "center", gap: 5 },
  quickIconBox: {
    width: 54,
    height: 54,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  quickLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.colors.text,
  },

  // ── Nearby stops ──
  nearbyWrap: {
    flex: 1,
    paddingHorizontal: theme.spacing.screen,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: theme.colors.muted,
    marginTop: 8,
  },
  nearbyHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 2,
  },
  nearbyTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  seeAll: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.primary,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.muted,
  },
  stopIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  stopInfo: { flex: 1, gap: 2 },
  stopName: {
    fontSize: theme.fontSize.body,
    fontWeight: "600",
    color: "#1A1C1F",
  },
  stopRoute: {
    fontSize: theme.fontSize.caption,
    fontWeight: "500",
    color: theme.colors.text,
  },
  etaChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 99,
  },
  etaText: {
    fontSize: theme.fontSize.caption,
    fontWeight: "700",
  },

  // ── Pressed pin card ──
  pinCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: theme.spacing.screen,
    marginBottom: 12,
    padding: 12,
    borderRadius: 16,
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  pinCardLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  pinIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: theme.colors.primary + "15",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  pinTextBlock: { flex: 1, gap: 2 },
  pinLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: theme.colors.text,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  pinResolveRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pinResolving: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
  },
  pinAddress: {
    fontSize: theme.fontSize.body,
    fontWeight: "600",
    color: "#1A1C1F",
  },
  pinActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  pinCta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  pinCtaText: {
    fontSize: 13,
    fontWeight: "700",
    color: "white",
  },
});
