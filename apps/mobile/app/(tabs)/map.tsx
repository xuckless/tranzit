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
import { StopMarker, parseWKTPoint } from "@/components/stopViews";
import { BusMarker } from "@/components/busViews";
import type { SelectedDestination } from "@/types/places";
import type { CalgaryTransitStop, VehiclePosition } from "@/types/database";
import MapView, { Marker, Region } from "react-native-maps";
import mapStyle from "@/assets/map-style.json";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { supabase } from "@/lib/supabase";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import { theme } from "@/styles/theme";
import { useRouter } from "expo-router";
import { TranzitApiService } from "@/services/TranzitApiService";
import type { PlaceDetails } from "@/types/places";
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

// Hardcoded — this is a deployed service URL, not a secret.
// Do not move to env: EXPO_PUBLIC_ vars are bundled into the binary and
// this value never changes between environments.
const TRANZIT_BASE_URL =
  "https://tranzit-route-service-000000000000.us-central1.run.app";

// ─── Types ─────────────────────────────────────────────────────────────────────

// ─── Add to Types ──────────────────────────────────────────────────────────────

interface PressedPin {
  coordinate: Coordinate;
  placeId: string; // session-scoped only, never persist
  address: string;
  isResolving: boolean;
}

// Coordinate pair shared by the user marker and destination marker
interface Coordinate {
  latitude: number;
  longitude: number;
}

// ─── Data ──────────────────────────────────────────────────────────────────────

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

// ─── Direction Marker ──────────────────────────────────────────────────────────

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

// ─── Screen ────────────────────────────────────────────────────────────────────

export default function MapScreen() {
  const mapRef = useRef<MapView>(null);
  const router = useRouter();
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

  // True while SearchSheet has an active query — hides Quick Access / Nearby Stops
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [placeDetails, setPlaceDetails] = useState<{
    place: PlaceDetails;
    isFetching: boolean;
  } | null>(null);

  const [transitStops, setTransitStops] = useState<CalgaryTransitStop[]>([]);
  const [vehicles, setVehicles] = useState<VehiclePosition[]>([]);
  // Tracked after first pan/animate — null means map hasn't settled yet (safe: no markers)
  const [mapRegion, setMapRegion] = useState<Region | null>(null);

  // Fetch active stops that currently have scheduled arrivals.
  // A stop renders if it is active AND has at least one stop_time_update where
  // schedule_relationship != NO_DATA and the bus is upcoming or already at the stop.
  useEffect(() => {
    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
    Promise.all([
      supabase
        .from("calgary_transit_stops")
        .select("*")
        .ilike("status", "active"),
      supabase
        .from("stop_time_updates")
        .select("stop_id")
        .neq("schedule_relationship", "NO_DATA")
        // upcoming arrivals OR bus currently at stop (arrival=-1, departure is still a valid future ts)
        .or(`arrival_time.gte.${fiveMinAgo},and(arrival_time.eq.-1,departure_time.gt.0)`)
        .limit(5000),
    ]).then(([{ data: stops }, { data: rawStus }]) => {
      if (!stops) return;
      const stus = rawStus as Array<{ stop_id: string | null }> | null;
      const scheduled = new Set(stus?.map((s) => s.stop_id) ?? []);
      setTransitStops(
        (stops as CalgaryTransitStop[]).filter(
          (s) =>
            s.teleride_number != null &&
            scheduled.has(String(s.teleride_number))
        )
      );
    });
  }, []);

  // Poll live vehicle positions every 30s.
  useEffect(() => {
    const fetchVehicles = () =>
      supabase
        .from("vehicle_positions")
        .select("*")
        .then(({ data }) => {
          if (data) setVehicles(data as VehiclePosition[]);
        });
    fetchVehicles();
    const id = setInterval(fetchVehicles, 30_000);
    return () => clearInterval(id);
  }, []);

  // Only render stop markers once the map has settled (mapRegion != null) and
  // only within the visible viewport. This prevents two crash vectors:
  //   1. Bulk-inserting hundreds of markers at once into AIRMap (Fabric interop crash)
  //   2. A StopMarker returning null (bad WKT) causing AIRMap to insert a nil native view
  const stopMarkers = useMemo(() => {
    if (!mapRegion || mapRegion.latitudeDelta > 0.04) return [];

    // 50% padding so stops don't flicker on small pans
    const latPad = mapRegion.latitudeDelta * 0.75;
    const lngPad = mapRegion.longitudeDelta * 0.75;

    return transitStops
      .filter((s) => {
        if (!s.point || !s.teleride_number) return false;
        // Pre-validate WKT — StopMarker returning null inside MapView crashes AIRMap
        const coord = parseWKTPoint(s.point);
        if (!coord) return false;
        return (
          Math.abs(coord.latitude - mapRegion.latitude) < latPad &&
          Math.abs(coord.longitude - mapRegion.longitude) < lngPad
        );
      })
      .map((s) => (
        <StopMarker
          key={`stop-${s.teleride_number}`}
          teleride_number={s.teleride_number!}
          stop_name={s.stop_name ?? "Unknown Stop"}
          point={s.point!}
        />
      ));
  }, [transitStops, mapRegion]);

  const busMarkers = useMemo(
    () =>
      vehicles
        .filter(
          (v) =>
            v.latitude != null &&
            v.longitude != null &&
            v.trip_id != null &&
            v.route_id != null &&
            v.route_id !== ""
        )
        .map((v) => (
          <BusMarker
            key={`bus-${v.vehicle_id}`}
            vehicle_id={v.vehicle_id}
            trip_id={v.trip_id!}
            route_id={v.route_id!}
            latitude={v.latitude!}
            longitude={v.longitude!}
            bearing={v.bearing ?? 0}
          />
        )),
    [vehicles]
  );

  const [pressedPin, setPressedPin] = useState<PressedPin | null>(null);
  const pressAbortRef = useRef<AbortController | null>(null);

  // ── Heading ──────────────────────────────────────────────────────────────────
  const smoothHeading = (raw: number) => {
    let d = raw - headingRef.current;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    headingRef.current += d;
    setHeading(headingRef.current);
  };

  // ── Sheet snap ───────────────────────────────────────────────────────────────
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

  // ── Pan responder ────────────────────────────────────────────────────────────
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

  // ── SearchSheet callbacks ─────────────────────────────────────────────────────

  const handleDestinationSelected = useCallback(
    async (dest: SelectedDestination) => {
      Keyboard.dismiss();
      setDestination(dest.coordinate);
      setPressedPin(null);
      pressAbortRef.current?.abort();

      const destRegion: Region = { ...dest.coordinate, ...DELTA };
      setRegion(destRegion);
      mapRef.current?.animateToRegion(destRegion, 900);

      // Show optimistic details card immediately with data from the search result
      setPlaceDetails({
        place: {
          id: dest.placeId,
          displayName: { text: dest.displayText },
          formattedAddress: "",
          location: dest.coordinate,
        },
        isFetching: true,
      });

      // Fetch full place details (address, etc.) in the background
      try {
        const full = await TranzitApiService.getPlaceDetails(dest.placeId);
        setPlaceDetails({ place: full, isFetching: false });
      } catch {
        setPlaceDetails((prev) => (prev ? { ...prev, isFetching: false } : null));
      }
    },
    [],
  );

  const handleClear = useCallback(() => {
    setDestination(null);
    setPressedPin(null);
    setPlaceDetails(null);
    pressAbortRef.current?.abort();
    if (userLocation) {
      const userRegion: Region = { ...userLocation, ...DELTA };
      setRegion(userRegion);
      mapRef.current?.animateToRegion(userRegion, 600);
    }
  }, [userLocation]);

  // ── Location ─────────────────────────────────────────────────────────────────
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

  const handleMapPress = useCallback(
    async (coord: Coordinate) => {
      pressAbortRef.current?.abort();
      const controller = new AbortController();
      pressAbortRef.current = controller;

      Keyboard.dismiss();
      setIsSearchActive(false);
      setPlaceDetails(null);

      // Drop pin + open sheet immediately
      setDestination(coord);
      setPressedPin({
        coordinate: coord,
        placeId: "",
        address: `${coord.latitude.toFixed(4)}, ${coord.longitude.toFixed(4)}`,
        isResolving: true,
      });
      snapTo(SNAP_COLLAPSED);
      mapRef.current?.animateCamera({ center: coord, zoom: 15 }, { duration: 500 });

      // Search for a business at this coordinate
      try {
        const query = `${coord.latitude.toFixed(5)},${coord.longitude.toFixed(5)}`;
        const res = await fetch(
          `${TRANZIT_BASE_URL}/search?q=${encodeURIComponent(query)}&lat=${coord.latitude}&lng=${coord.longitude}`,
          { signal: controller.signal },
        );

        if (res.ok) {
          const json: {
            places: Array<{
              id: string;
              displayName: { text: string };
              location: { latitude: number; longitude: number };
            }>;
          } = await res.json();

          const place = json.places?.[0];
          if (place) {
            // Business found — switch to the full place card via /details
            setPressedPin(null);
            setPlaceDetails({
              place: {
                id: place.id,
                displayName: { text: place.displayName.text },
                formattedAddress: "",
                location: place.location,
              },
              isFetching: true,
            });
            try {
              const full = await TranzitApiService.getPlaceDetails(place.id, controller.signal);
              if (!controller.signal.aborted) {
                setPlaceDetails({ place: full, isFetching: false });
              }
            } catch (detailsErr: unknown) {
              if ((detailsErr as Error).name === "AbortError") return;
              setPlaceDetails((prev) => (prev ? { ...prev, isFetching: false } : null));
            }
            return;
          }
        }
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") return;
      }

      // No business found — show raw coordinate pin
      setPressedPin((prev) => (prev ? { ...prev, isResolving: false } : null));
    },
    [snapTo],
  );

  // ── POI tap (native Google Maps business markers) ─────────────────────────────
  const handlePoiPress = useCallback(
    async (e: { nativeEvent: { placeId: string; name: string; coordinate: Coordinate } }) => {
      const { placeId, name, coordinate } = e.nativeEvent;

      pressAbortRef.current?.abort();
      const controller = new AbortController();
      pressAbortRef.current = controller;

      Keyboard.dismiss();
      setIsSearchActive(false);
      setPressedPin(null);
      setDestination(coordinate);
      snapTo(SNAP_COLLAPSED);
      mapRef.current?.animateCamera({ center: coordinate, zoom: 15 }, { duration: 500 });

      // Optimistic card while /details loads
      setPlaceDetails({
        place: {
          id: placeId,
          displayName: { text: name },
          formattedAddress: "",
          location: coordinate,
        },
        isFetching: true,
      });

      try {
        const full = await TranzitApiService.getPlaceDetails(placeId, controller.signal);
        if (!controller.signal.aborted) {
          setPlaceDetails({ place: full, isFetching: false });
        }
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") return;
        setPlaceDetails((prev) => (prev ? { ...prev, isFetching: false } : null));
      }
    },
    [snapTo],
  );

  const dismissPressedPin = useCallback(() => {
    pressAbortRef.current?.abort();
    setPressedPin(null);
    setDestination(null);
  }, []);

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
          // Always update the user dot — never the camera region,
          // which may be pointed at a destination.
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

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      {/* Map */}
      <MapView
        ref={mapRef}
        customMapStyle={mapStyle}
        style={styles.map}
        showsUserLocation={false}
        showsCompass={true}
        onRegionChangeComplete={(region) => setMapRegion(region)}
        onPress={(e) => {
          const coord = e.nativeEvent.coordinate;
          if (!coord || isSearchActive) return;
          // Dismiss any active pin or place card on empty-space tap
          if (pressedPin || placeDetails) {
            pressAbortRef.current?.abort();
            setPressedPin(null);
            setPlaceDetails(null);
            setDestination(null);
          }
        }}
        onLongPress={(e) => {
          const coord = e.nativeEvent.coordinate;
          if (coord) handleMapPress(coord);
        }}
        onPoiClick={handlePoiPress}
        initialRegion={{
          latitude: 51.070664,
          longitude: -114.059263,
          ...DELTA,
        }}
      >
        {/* User location dot — follows userLocation, not region */}
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

        {/* Destination pin — appears immediately on suggestion select */}
        {destination && (
          <Marker
            coordinate={destination}
            anchor={{ x: 0.5, y: 1.0 }}
            tracksViewChanges={false}
            pinColor={theme.colors.primary}
          />
        )}

        {/* Transit stops — static, loaded once from calgary_transit_stops */}
        {stopMarkers}

        {/* Live buses — polled every 30s from vehicle_positions */}
        {busMarkers}
      </MapView>

      {/* Re-center button */}
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

      {/* Error banner */}
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
          <Text style={styles.handleHint}>
            {isExpanded ? "Nearby Stops" : "Explore"}
          </Text>
        </View>
        {/* ── Pressed pin card ── */}
        {pressedPin && !isSearchActive && (
          <View style={styles.pinCard}>
            <View style={styles.pinCardLeft}>
              <View style={styles.pinIconBox}>
                <Ionicons
                  name="location"
                  size={18}
                  color={theme.colors.primary}
                />
              </View>
              <View style={styles.pinTextBlock}>
                <Text style={styles.pinLabel}>Dropped pin</Text>
                {pressedPin.isResolving ? (
                  <View style={styles.pinResolveRow}>
                    <ActivityIndicator
                      size="small"
                      color={theme.colors.primary}
                    />
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
                  if (!pressedPin.placeId) return;
                  router.navigate({
                    pathname: "/(tabs)/routes",
                    params: {
                      destinationId: pressedPin.placeId,
                      destinationLat: String(pressedPin.coordinate.latitude),
                      destinationLng: String(pressedPin.coordinate.longitude),
                      destinationName: pressedPin.address,
                    },
                  } as never);
                }}
              >
                <Ionicons name="navigate" size={15} color="white" />
                <Text style={styles.pinCtaText}>Go</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={dismissPressedPin}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons
                  name="close-circle"
                  size={22}
                  color={theme.colors.text}
                />
              </TouchableOpacity>
            </View>
          </View>
        )}
        {/* ── Place details card (shown after selecting a search result) ── */}
        {placeDetails && !isSearchActive && (
          <View style={styles.placeCard}>
            <View style={styles.placeCardLeft}>
              <View style={styles.placeIconBox}>
                <Ionicons name="location" size={18} color={theme.colors.primary} />
              </View>
              <View style={styles.placeTextBlock}>
                <Text style={styles.placeName} numberOfLines={1}>
                  {placeDetails.place.displayName.text}
                </Text>
                {placeDetails.isFetching ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                ) : (
                  <>
                    <Text style={styles.placeAddress} numberOfLines={1}>
                      {placeDetails.place.formattedAddress || "Calgary, AB"}
                    </Text>
                    {placeDetails.place.rating != null && (
                      <Text style={styles.placeRating}>
                        {"★ "}
                        {placeDetails.place.rating.toFixed(1)}
                        {placeDetails.place.userRatingCount != null
                          ? ` (${placeDetails.place.userRatingCount.toLocaleString()})`
                          : ""}
                        {placeDetails.place.regularOpeningHours?.openNow != null
                          ? placeDetails.place.regularOpeningHours.openNow
                            ? "  ·  Open"
                            : "  ·  Closed"
                          : ""}
                      </Text>
                    )}
                  </>
                )}
              </View>
            </View>
            <View style={styles.placeActions}>
              <TouchableOpacity
                style={styles.placeDirectionsCta}
                activeOpacity={0.85}
                onPress={() => {
                  router.navigate({
                    pathname: "/(tabs)/routes",
                    params: {
                      destinationId: placeDetails.place.id,
                      destinationLat: String(
                        placeDetails.place.location.latitude,
                      ),
                      destinationLng: String(
                        placeDetails.place.location.longitude,
                      ),
                      destinationName: placeDetails.place.displayName.text,
                    },
                  } as never);
                }}
              >
                <Ionicons name="navigate" size={15} color="white" />
                <Text style={styles.placeDirectionsText}>Directions</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setPlaceDetails(null);
                  setDestination(null);
                }}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons
                  name="close-circle"
                  size={22}
                  color={theme.colors.text}
                />
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Search sheet ── */}
        <SearchSheet
          userLocation={userLocation}
          onDestinationSelected={handleDestinationSelected}
          onSearchActiveChange={(active) => {
            setIsSearchActive(active);
            if (active) snapTo(SNAP_EXPANDED);
          }}
          onClear={handleClear}
        />

        {/* ── Quick access chips (hidden while search is active) ── */}
        {!isSearchActive && (
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

        {/* ── Nearby stops (expanded only, no active search) ── */}
        {isExpanded && !isSearchActive && (
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
                      style={[styles.etaText, { color: STOP_COLOR[stop.type] }]}
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
  // ── Place details card ──
  placeCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: theme.spacing.screen,
    marginBottom: 12,
    padding: 12,
    borderRadius: 16,
    backgroundColor: theme.colors.primary + "08",
    borderWidth: 1.5,
    borderColor: theme.colors.primary + "30",
  },
  placeCardLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  placeIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: theme.colors.primary + "15",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  placeTextBlock: { flex: 1, gap: 2 },
  placeName: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  placeAddress: {
    fontSize: theme.fontSize.caption,
    fontWeight: "500",
    color: theme.colors.text,
  },
  placeRating: {
    fontSize: 11,
    fontWeight: "600",
    color: "#775A00",
  },
  placeActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  placeDirectionsCta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  placeDirectionsText: {
    fontSize: 13,
    fontWeight: "700",
    color: "white",
  },
});
