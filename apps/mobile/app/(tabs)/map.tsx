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
import {
  Map,
  Camera,
  UserLocation,
  GeoJSONSource,
  Layer,
  Marker,
  Images,
  type CameraRef,
} from "@maplibre/maplibre-react-native";
import { SearchSheet } from "@/components/search/SearchSheet";
import { StopDetailsPanel, parseWKTPoint } from "@/components/stopViews";
import { BusDetailsPanel } from "@/components/busViews";
import type { SelectedDestination } from "@/types/places";
import type { CalgaryTransitStop } from "@/types/database";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useVehicles, vehiclesToGeoJSON } from "@/lib/vehicleSSE";
import { loadAndCacheStops } from "@/lib/transitStopsCache";
import { middlewareQuery } from "@/lib/middleware";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import { theme } from "@/styles/theme";
import { useRouter } from "expo-router";
import { TranzitApiService } from "@/services/TranzitApiService";
import type { PlaceDetails } from "@/types/places";
import { useQuickAccess } from "@/hooks/useSavedPlaces";
import type { QuickAccessPlace } from "@/lib/db";
import {
  SavePlaceModal,
  type PreselectedPlace,
} from "@/components/SavePlaceModal";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

const SNAP_COLLAPSED = SCREEN_HEIGHT * 0.28;
const SNAP_EXPANDED = SCREEN_HEIGHT * 0.62;

// Calgary downtown — used as the initial camera anchor before GPS resolves.
const CALGARY_CENTER: [number, number] = [-114.059263, 51.070664];

// Zoom-level threshold below which stops and buses are hidden by the GPU.
// MapLibre's minZoomLevel is enforced in the shader — no React unmount cost.
const MIN_MARKER_ZOOM = 12;

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

const TRANZIT_BASE_URL =
  "https://tranzit-route-service-000000000000.us-central1.run.app";

// ─── Types ─────────────────────────────────────────────────────────────────────

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

// ─── Quick Access icon map ─────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, { icon: string; color: string }> = {
  home:       { icon: "home",         color: theme.colors.primary },
  work:       { icon: "briefcase",    color: "#0070EB" },
  office:     { icon: "briefcase",    color: "#0070EB" },
  school:     { icon: "university",   color: theme.colors.selected },
  university: { icon: "university",   color: theme.colors.selected },
  gym:        { icon: "dumbbell",     color: theme.colors.tertiary },
  food:       { icon: "utensils",     color: "#E0A000" },
  restaurant: { icon: "utensils",     color: "#E0A000" },
  health:     { icon: "heartbeat",    color: "#D32F2F" },
  hospital:   { icon: "hospital",     color: "#D32F2F" },
  shopping:   { icon: "shopping-bag", color: "#9C27B0" },
  park:       { icon: "tree",         color: "#388E3C" },
};

function quickIcon(categoryName: string) {
  return (
    CATEGORY_ICONS[categoryName.toLowerCase()] ?? {
      icon: "map-marker-alt",
      color: theme.colors.text,
    }
  );
}

const NEARBY_STOPS = [
  { id: "1", name: "Centre St & 5 Ave N",    route: "CTrain Red",  eta: "2 min",  type: "ctrain" },
  { id: "2", name: "7 Ave SW Station",       route: "CTrain Blue", eta: "5 min",  type: "ctrain" },
  { id: "3", name: "4 St SW & 9 Ave SW",     route: "Route 7",     eta: "8 min",  type: "bus" },
  { id: "4", name: "Macleod Tr & 10 Ave SE", route: "Route 302",   eta: "11 min", type: "bus" },
];

const STOP_COLOR: Record<string, string> = {
  ctrain: theme.colors.primary,
  bus: "#E0A000",
};

// ─── Screen ────────────────────────────────────────────────────────────────────

export default function MapScreen() {
  const cameraRef = useRef<CameraRef>(null);
  const router = useRouter();
  const sheetAnim = useRef(new Animated.Value(SNAP_COLLAPSED)).current;
  const lastSnap = useRef(SNAP_COLLAPSED);
  const { data: quickAccessPlaces, refresh: refreshQuickAccess } = useQuickAccess();
  const [showSaveModal, setShowSaveModal] = useState(false);

  const [userLocation, setUserLocation] = useState<Coordinate | null>(null);
  const [destination, setDestination] = useState<Coordinate | null>(null);

  const [loadingLocation, setLoadingLocation] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const [isSearchActive, setIsSearchActive] = useState(false);
  const [placeDetails, setPlaceDetails] = useState<{
    place: PlaceDetails;
    isFetching: boolean;
  } | null>(null);

  const [transitStops, setTransitStops] = useState<CalgaryTransitStop[]>([]);
  const [selectedStop, setSelectedStop] = useState<{
    teleride_number: number;
    stop_name: string;
  } | null>(null);
  const [selectedBus, setSelectedBus] = useState<{
    vehicleId: string;
    routeId: string;
    tripId: string;
  } | null>(null);

  const vehicles = useVehicles();

  const [pressedPin, setPressedPin] = useState<PressedPin | null>(null);
  const pressAbortRef = useRef<AbortController | null>(null);

  // ── Load active transit stops with imminent-arrival filter ───────────────────
  // Same filtering logic as before — keeps stop set to ~500-800 instead of ~3000.
  useEffect(() => {
    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
    Promise.all([
      loadAndCacheStops(),
      middlewareQuery<{ stop_id: string | null }>("stop_time_updates", {
        schedule_relationship: "neq.NO_DATA",
        or: `(arrival_time.gte.${fiveMinAgo},arrival_time.eq.-1)`,
        limit: 5000,
      }),
    ]).then(([allStops, scheduledStus]) => {
      const scheduled = new Set(scheduledStus.map((s) => s.stop_id));
      setTransitStops(
        allStops.filter(
          (s) =>
            s.status?.toLowerCase() === "active" &&
            s.teleride_number != null &&
            scheduled.has(String(s.teleride_number)),
        ),
      );
    });
  }, []);

  // ── Stops GeoJSON ─────────────────────────────────────────────────────────────
  // Pre-parsed once when transitStops changes. WKT validation happens here so
  // bad rows never reach the GPU layer.
  const stopsGeoJSON = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: transitStops
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
    [transitStops],
  );

  // ── Vehicles GeoJSON ──────────────────────────────────────────────────────────
  // Rebuilt on every SSE update — cheap (object construction only). MapLibre
  // diffs the source data natively on the C++ side.
  const vehiclesGeoJSON = useMemo(() => vehiclesToGeoJSON(vehicles), [vehicles]);

  // ── Tap handlers on ShapeSources ─────────────────────────────────────────────
  // Mapbox/MapLibre returns matched features as event.features[]. We pull
  // properties off the first hit and delegate to the existing state setters.

  const handleStopLayerPress = useCallback((event: any) => {
    const feature = event?.nativeEvent?.features?.[0];
    const props = feature?.properties;
    if (!props || props.teleride_number == null) return;
    setPressedPin(null);
    setPlaceDetails(null);
    setSelectedBus(null);
    setSelectedStop({
      teleride_number: props.teleride_number,
      stop_name: props.stop_name ?? "Unknown Stop",
    });
  }, []);

  const handleBusLayerPress = useCallback((event: any) => {
    const feature = event?.nativeEvent?.features?.[0];
    const props = feature?.properties;
    if (!props?.vehicle_id || !props?.route_id || !props?.trip_id) return;
    setPressedPin(null);
    setPlaceDetails(null);
    setSelectedStop(null);
    setSelectedBus({
      vehicleId: props.vehicle_id,
      routeId: props.route_id,
      tripId: props.trip_id,
    });
  }, []);

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

  // ── Camera helpers ───────────────────────────────────────────────────────────
  const flyTo = useCallback((coord: Coordinate, zoom = 14, duration = 800) => {
    cameraRef.current?.flyTo({
      center: [coord.longitude, coord.latitude],
      zoom,
      duration,
    });
  }, []);

  // ── SearchSheet callbacks ────────────────────────────────────────────────────
  const handleDestinationSelected = useCallback(
    async (dest: SelectedDestination) => {
      Keyboard.dismiss();
      setDestination(dest.coordinate);
      setPressedPin(null);
      pressAbortRef.current?.abort();

      flyTo(dest.coordinate, 14, 900);

      setPlaceDetails({
        place: {
          id: dest.placeId,
          displayName: { text: dest.displayText },
          formattedAddress: "",
          location: dest.coordinate,
        },
        isFetching: true,
      });

      try {
        const full = await TranzitApiService.getPlaceDetails(dest.placeId);
        setPlaceDetails({ place: full, isFetching: false });
      } catch {
        setPlaceDetails((prev) => (prev ? { ...prev, isFetching: false } : null));
      }
    },
    [flyTo],
  );

  const handleClear = useCallback(() => {
    setDestination(null);
    setPressedPin(null);
    setPlaceDetails(null);
    setSelectedStop(null);
    setSelectedBus(null);
    pressAbortRef.current?.abort();
    if (userLocation) flyTo(userLocation, 14, 600);
  }, [userLocation, flyTo]);

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
      flyTo(coord, 14, 800);
    } catch {
      setErrorMsg("Could not get your location.");
    } finally {
      setLoadingLocation(false);
    }
  };

  // ── Long-press: coordinate-based POI lookup ──────────────────────────────────
  // Triggered ONLY by long-press now. Single tap on the basemap dismisses
  // active cards but does not search (per the conservative tap behavior choice).
  const handleMapPress = useCallback(
    async (coord: Coordinate) => {
      pressAbortRef.current?.abort();
      const controller = new AbortController();
      pressAbortRef.current = controller;

      Keyboard.dismiss();
      setIsSearchActive(false);
      setPlaceDetails(null);
      setSelectedStop(null);
      setSelectedBus(null);
      setDestination(coord);
      setPressedPin({
        coordinate: coord,
        placeId: "",
        address: `${coord.latitude.toFixed(4)}, ${coord.longitude.toFixed(4)}`,
        isResolving: true,
      });
      snapTo(SNAP_COLLAPSED);
      flyTo(coord, 15, 500);

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

      setPressedPin((prev) => (prev ? { ...prev, isResolving: false } : null));
    },
    [snapTo, flyTo],
  );

  const dismissPressedPin = useCallback(() => {
    pressAbortRef.current?.abort();
    setPressedPin(null);
    setDestination(null);
  }, []);

  // ── Map gestures (MapLibre) ──────────────────────────────────────────────────
  // MapLibre's MapView onPress receives a GeoJSON feature whose geometry is
  // the tapped point. We use it only to dismiss active cards on empty-space
  // taps (conservative behavior per user choice).
  const onMapPress = useCallback(
    (e: any) => {
      if (isSearchActive) return;
      if (pressedPin || placeDetails || selectedStop || selectedBus) {
        pressAbortRef.current?.abort();
        setPressedPin(null);
        setPlaceDetails(null);
        setSelectedStop(null);
        setSelectedBus(null);
        setDestination(null);
      }
    },
    [isSearchActive, pressedPin, placeDetails, selectedStop, selectedBus],
  );

  const onMapLongPress = useCallback(
    (e: any) => {
      const lngLat = e?.nativeEvent?.lngLat;
      if (!Array.isArray(lngLat) || lngLat.length < 2) return;
      const [longitude, latitude] = lngLat;
      handleMapPress({ latitude, longitude });
    },
    [handleMapPress],
  );

  // ── GPS watch (position only — UserLocation handles heading natively) ────────
  useEffect(() => {
    if (!hasPermission) return;
    let posSub: Location.LocationSubscription;
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
        },
      );
    })();
    return () => {
      posSub?.remove();
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
      <Map
        style={styles.map}
        mapStyle={STYLE_URL}
        onPress={onMapPress}
        onLongPress={onMapLongPress}
        compass={true}
        logo={false}
        attribution={true}
        attributionPosition={{ bottom: SNAP_COLLAPSED + 8, right: 8 }}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{
            center: CALGARY_CENTER,
            zoom: 13,
          }}
        />

        {/* Native blue-dot + heading indicator. Replaces DirectionMarker. */}
        <UserLocation heading={true} animated={true} />

        {/* Bus icon image registered once for the symbol layer below */}
        <Images
          images={{
            tranzitBus: require("@/assets/images/tranzit_busView.png"),
          }}
        />

        {/* Transit stops — GPU-rendered circles, no React per-marker cost */}
        <GeoJSONSource
          id="stops-source"
          data={stopsGeoJSON}
          onPress={handleStopLayerPress}
        >
          <Layer
            id="stops-circle"
            type="circle"
            minzoom={MIN_MARKER_ZOOM}
            paint={{
              "circle-radius": 5,
              "circle-color": theme.colors.primary,
              "circle-stroke-color": "white",
              "circle-stroke-width": 2,
              "circle-opacity": 0.95,
            }}
          />
        </GeoJSONSource>

        {/* Live buses — single GeoJSON source, icon rotated per-feature.
            Bearing snaps on each SSE update (same as the old implementation). */}
        <GeoJSONSource
          id="vehicles-source"
          data={vehiclesGeoJSON}
          onPress={handleBusLayerPress}
        >
          <Layer
            id="vehicles-icon"
            type="symbol"
            minzoom={MIN_MARKER_ZOOM}
            layout={{
              "icon-image": "tranzitBus",
              "icon-size": 0.08,
              "icon-rotate": ["get", "bearing"],
              "icon-rotation-alignment": "map",
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            }}
          />
          <Layer
            id="vehicles-label"
            type="symbol"
            minzoom={MIN_MARKER_ZOOM}
            layout={{
              "text-field": ["get", "route_id"],
              "text-size": 10,
              "text-font": ["Noto Sans Regular"],
              "text-rotation-alignment": "viewport",
              "text-allow-overlap": true,
              "text-ignore-placement": true,
              "text-anchor": "center",
              "text-offset": [0, 0],
            }}
            paint={{
              "text-color": "white",
              "text-halo-color": "rgba(0,0,0,0.45)",
              "text-halo-width": 1,
            }}
          />
        </GeoJSONSource>

        {/* Destination pin — single Marker is cheap (1 instance only) */}
        {destination && (
          <Marker
            id="destination-pin"
            lngLat={[destination.longitude, destination.latitude]}
            anchor="bottom"
          >
            <Ionicons name="location" size={32} color={theme.colors.primary} />
          </Marker>
        )}
      </Map>

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

      {errorMsg && (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={15} color="#BA1A1A" />
          <Text style={styles.errorText}>{errorMsg}</Text>
        </View>
      )}

      {/* ════════ BOTTOM SHEET ════════ */}
      <Animated.View style={[styles.sheet, { height: sheetAnim }]}>
        <View {...panResponder.panHandlers} style={styles.handleArea}>
          <View style={styles.handle} />
          <Text style={styles.handleHint}>
            {isExpanded ? "Nearby Stops" : "Explore"}
          </Text>
        </View>

        {selectedStop && !isSearchActive && (
          <StopDetailsPanel
            teleride_number={selectedStop.teleride_number}
            stop_name={selectedStop.stop_name}
            onClose={() => setSelectedStop(null)}
          />
        )}

        {selectedBus && !isSearchActive && (
          <BusDetailsPanel
            vehicleId={selectedBus.vehicleId}
            routeId={selectedBus.routeId}
            tripId={selectedBus.tripId}
            onClose={() => setSelectedBus(null)}
          />
        )}

        {pressedPin && !isSearchActive && (
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
                <Ionicons name="close-circle" size={22} color={theme.colors.text} />
              </TouchableOpacity>
            </View>
          </View>
        )}

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
                      destinationLat: String(placeDetails.place.location.latitude),
                      destinationLng: String(placeDetails.place.location.longitude),
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
                <Ionicons name="close-circle" size={22} color={theme.colors.text} />
              </TouchableOpacity>
            </View>
          </View>
        )}

        <SearchSheet
          userLocation={userLocation}
          onDestinationSelected={handleDestinationSelected}
          onSearchActiveChange={(active) => {
            setIsSearchActive(active);
            if (active) snapTo(SNAP_EXPANDED);
          }}
          onClear={handleClear}
        />

        {!isSearchActive && (
          <View style={styles.sectionWrap}>
            <Text style={styles.sectionLabel}>Quick Access</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.quickRow}
            >
              {quickAccessPlaces.map((item: QuickAccessPlace) => {
                const { icon, color } = quickIcon(item.categoryName);
                return (
                  <TouchableOpacity
                    key={`${item.categoryId}-${item.googlePlaceId}`}
                    style={styles.quickChip}
                    activeOpacity={0.8}
                    onPress={() => {
                      const coord = {
                        latitude: item.latitude,
                        longitude: item.longitude,
                      };
                      setDestination(coord);
                      flyTo(coord, 14, 900);
                      router.navigate({
                        pathname: "/(tabs)/routes",
                        params: {
                          destinationId: item.googlePlaceId,
                          destinationLat: String(item.latitude),
                          destinationLng: String(item.longitude),
                          destinationName: item.label ?? item.address,
                        },
                      } as never);
                    }}
                  >
                    <View
                      style={[
                        styles.quickIconBox,
                        { backgroundColor: color + "18" },
                      ]}
                    >
                      <FontAwesome5 name={icon as any} size={14} color={color} />
                    </View>
                    <Text style={styles.quickLabel}>{item.categoryName}</Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={styles.quickChip}
                activeOpacity={0.8}
                onPress={() => setShowSaveModal(true)}
              >
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

        {isExpanded && !isSearchActive && (
          <View style={styles.nearbyWrap}>
            <View style={styles.nearbyHeader}>
              <View style={styles.nearbyTitleRow}>
                <Ionicons name="radio-button-on" size={14} color={theme.colors.primary} />
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
                    <Text style={[styles.etaText, { color: STOP_COLOR[stop.type] }]}>
                      {stop.eta}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
      </Animated.View>

      <SavePlaceModal
        visible={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onSaved={refreshQuickAccess}
        userLocation={userLocation}
        preselectedPlace={
          placeDetails?.place && !placeDetails.isFetching
            ? ({
                googlePlaceId: placeDetails.place.id,
                displayName: placeDetails.place.displayName.text,
                address:
                  placeDetails.place.formattedAddress ||
                  placeDetails.place.displayName.text,
                latitude: placeDetails.place.location.latitude,
                longitude: placeDetails.place.location.longitude,
              } satisfies PreselectedPlace)
            : null
        }
      />
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
