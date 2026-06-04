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
import { PlaceDetailsPanel } from "@/components/placeViews";
import type { SelectedDestination, PlaceResult } from "@/types/places";
import type { CalgaryTransitStop } from "@/types/database";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useVehicles, vehiclesToGeoJSON } from "@/lib/vehicleSSE";
import { loadAndCacheStops } from "@/lib/transitStopsCache";
import { middlewareQuery } from "@/lib/middleware";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import { theme } from "@/styles/theme";
import { useTheme } from "@/contexts/ThemeContext";
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
const SNAP_EXPANDED  = SCREEN_HEIGHT * 0.62;
const SNAP_FULL      = SCREEN_HEIGHT * 0.79;

// Calgary downtown — used as the initial camera anchor before GPS resolves.
const CALGARY_CENTER: [number, number] = [-114.059263, 51.070664];

// 100 km bounding box around Calgary (LngLatBounds: [west, south, east, north]).
// Prevents tile requests — and panning — outside the service area.
const CALGARY_MAX_BOUNDS: [number, number, number, number] = [-115.5, 50.147, -112.645, 51.943];

// Zoom-level threshold below which stops and buses are hidden by the GPU.
// MapLibre's minZoomLevel is enforced in the shader — no React unmount cost.
const MIN_MARKER_ZOOM = 12;

const STYLE_URL = `https://api.maptiler.com/maps/positron/style.json?key=${process.env.EXPO_PUBLIC_MAPTILER_KEY}`;

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Coordinate {
  latitude: number;
  longitude: number;
}

interface NearbyState {
  coordinate: Coordinate;
  places: PlaceResult[];
  loading: boolean;
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

// ─── Tile math ─────────────────────────────────────────────────────────────────
// Converts lat/lng to slippy-map tile indices at a given zoom level.

function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      Math.pow(2, zoom),
  );
  return { x, y };
}

// ─── Screen ────────────────────────────────────────────────────────────────────

export default function MapScreen() {
  const cameraRef = useRef<CameraRef>(null);
  const router = useRouter();
  const { colors } = useTheme();
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
    fromNearby?: boolean;
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

  const [nearbyState, setNearbyState] = useState<NearbyState | null>(null);
  const pressAbortRef = useRef<AbortController | null>(null);

  // Refs to track current selected state inside memoized callbacks (avoids
  // stale closures without adding them to every useCallback dep array).
  const selectedStopRef = useRef<typeof selectedStop>(null);
  const selectedBusRef = useRef<typeof selectedBus>(null);
  useEffect(() => { selectedStopRef.current = selectedStop; }, [selectedStop]);
  useEffect(() => { selectedBusRef.current = selectedBus; }, [selectedBus]);

  // Set to true in layer-press handlers; onMapPress checks and skips deselect.
  // Prevents the double-fire (layer press + map press same event) toggle loop.
  const layerTappedRef = useRef(false);

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

  // ── Nearby stops (tile-filtered) ─────────────────────────────────────────────
  // Filters loaded stops to those in the user's z=15 tile + 8 adjacent tiles.
  // Pure math — no network call.
  const nearbyTransitStops = useMemo(() => {
    if (!userLocation) return [];
    const ZOOM = 15;
    const { x: ux, y: uy } = latLngToTile(
      userLocation.latitude,
      userLocation.longitude,
      ZOOM,
    );
    const tileSet = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        tileSet.add(`${ux + dx},${uy + dy}`);
      }
    }
    return transitStops
      .filter((stop) => {
        if (!stop.point) return false;
        const coord = parseWKTPoint(stop.point);
        if (!coord) return false;
        const { x, y } = latLngToTile(coord.latitude, coord.longitude, ZOOM);
        return tileSet.has(`${x},${y}`);
      })
      .slice(0, 20);
  }, [transitStops, userLocation]);

  // ── Camera helpers ───────────────────────────────────────────────────────────
  const flyTo = useCallback((coord: Coordinate, zoom = 14, duration = 800) => {
    cameraRef.current?.flyTo({
      center: [coord.longitude, coord.latitude],
      zoom,
      duration,
    });
  }, []);

  // ── Tap handlers on ShapeSources ─────────────────────────────────────────────
  // Mapbox/MapLibre returns matched features as event.features[]. We pull
  // properties off the first hit and delegate to the existing state setters.

  const handleStopLayerPress = useCallback((event: any) => {
    layerTappedRef.current = true;
    const feature = event?.nativeEvent?.features?.[0];
    const props = feature?.properties;
    if (!props || props.teleride_number == null) return;

    // Toggle: tapping the already-selected stop deselects it.
    if (selectedStopRef.current?.teleride_number === props.teleride_number) {
      setSelectedStop(null);
      return;
    }

    setNearbyState(null);
    setPlaceDetails(null);
    setSelectedBus(null);
    setSelectedStop({
      teleride_number: props.teleride_number,
      stop_name: props.stop_name ?? "Unknown Stop",
    });

    const coords = feature?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      flyTo({ longitude: coords[0], latitude: coords[1] }, 16, 600);
    }
  }, [flyTo]);

  const handleBusLayerPress = useCallback((event: any) => {
    layerTappedRef.current = true;
    const feature = event?.nativeEvent?.features?.[0];
    const props = feature?.properties;
    if (!props?.vehicle_id || !props?.route_id || !props?.trip_id) return;

    // Toggle: tapping the already-selected bus deselects it.
    if (selectedBusRef.current?.vehicleId === props.vehicle_id) {
      setSelectedBus(null);
      return;
    }

    setNearbyState(null);
    setPlaceDetails(null);
    setSelectedStop(null);
    setSelectedBus({
      vehicleId: props.vehicle_id,
      routeId: props.route_id,
      tripId: props.trip_id,
    });

    const coords = feature?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      flyTo({ longitude: coords[0], latitude: coords[1] }, 16, 600);
    }
  }, [flyTo]);

  // ── Sheet snap ───────────────────────────────────────────────────────────────
  const snapTo = useCallback(
    (target: number) => {
      lastSnap.current = target;
      setIsExpanded(target >= SNAP_EXPANDED);
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
          Math.min(SNAP_FULL, lastSnap.current - g.dy),
        );
        sheetAnim.setValue(next);
      },
      onPanResponderRelease: (_, g) => {
        const projected = lastSnap.current - g.dy;
        let target: number;
        if (g.vy > 0.4) {
          // fast flick down → next lower snap
          target = lastSnap.current > SNAP_EXPANDED ? SNAP_EXPANDED : SNAP_COLLAPSED;
        } else if (g.vy < -0.4) {
          // fast flick up → next higher snap
          target = lastSnap.current < SNAP_EXPANDED ? SNAP_EXPANDED : SNAP_FULL;
        } else {
          // settle to nearest of the three snap points
          const dC = Math.abs(projected - SNAP_COLLAPSED);
          const dE = Math.abs(projected - SNAP_EXPANDED);
          const dF = Math.abs(projected - SNAP_FULL);
          if (dC <= dE && dC <= dF) target = SNAP_COLLAPSED;
          else if (dE <= dF) target = SNAP_EXPANDED;
          else target = SNAP_FULL;
        }
        snapTo(target);
      },
    }),
  ).current;

  // ── SearchSheet callbacks ────────────────────────────────────────────────────
  const handleDestinationSelected = useCallback(
    async (dest: SelectedDestination) => {
      Keyboard.dismiss();
      setDestination(dest.coordinate);
      setNearbyState(null);
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
    setNearbyState(null);
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

  // ── Long-press: nearby place lookup via /searchnearby ────────────────────────
  // Triggered ONLY by long-press. Single tap on the basemap dismisses active cards.
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
      setNearbyState({ coordinate: coord, places: [], loading: true });
      snapTo(SNAP_COLLAPSED);
      flyTo(coord, 15, 500);

      try {
        const places = await TranzitApiService.searchNearby(
          coord.latitude,
          coord.longitude,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setNearbyState({ coordinate: coord, places, loading: false });
        }
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") return;
        if (!controller.signal.aborted) {
          setNearbyState({ coordinate: coord, places: [], loading: false });
        }
      }
    },
    [snapTo, flyTo],
  );

  const dismissNearby = useCallback(() => {
    pressAbortRef.current?.abort();
    setNearbyState(null);
    setDestination(null);
  }, []);

  // Opens PlaceDetailsPanel from a nearby result without clearing nearbyState,
  // so the back button can restore the nearby list.
  const handleNearbyPlaceTap = useCallback(async (place: PlaceResult) => {
    setPlaceDetails({
      place: {
        id: place.id,
        displayName: place.displayName,
        formattedAddress: place.formattedAddress,
        location: place.location,
      },
      isFetching: true,
      fromNearby: true,
    });

    try {
      const full = await TranzitApiService.getPlaceDetails(place.id);
      setPlaceDetails({ place: full, isFetching: false, fromNearby: true });
    } catch {
      setPlaceDetails((prev) => (prev ? { ...prev, isFetching: false } : null));
    }
  }, []);

  // ── Map gestures (MapLibre) ──────────────────────────────────────────────────
  // MapLibre's MapView onPress receives a GeoJSON feature whose geometry is
  // the tapped point. We use it only to dismiss active cards on empty-space
  // taps (conservative behavior per user choice).
  const onMapPress = useCallback(
    (e: any) => {
      // A layer-press (stop or bus) already fired — don't also deselect.
      if (layerTappedRef.current) {
        layerTappedRef.current = false;
        return;
      }
      if (isSearchActive) return;
      if (nearbyState || placeDetails || selectedStop || selectedBus) {
        pressAbortRef.current?.abort();
        setNearbyState(null);
        setPlaceDetails(null);
        setSelectedStop(null);
        setSelectedBus(null);
        setDestination(null);
      }
    },
    [isSearchActive, nearbyState, placeDetails, selectedStop, selectedBus],
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

  // ── Cross-panel navigation ───────────────────────────────────────────────────

  // Called when the user taps an arrival row in StopDetailsPanel.
  // Finds the live vehicle by trip_id and flies the camera to it.
  const handleBusTapFromStop = useCallback((tripId: string) => {
    const vehicle = vehicles.find((v) => v.trip_id === tripId);
    if (!vehicle || vehicle.latitude == null || vehicle.longitude == null) {
      setErrorMsg("Bus is not currently visible on the map.");
      setTimeout(() => setErrorMsg(null), 3000);
      return;
    }
    setSelectedStop(null);
    setSelectedBus({
      vehicleId: vehicle.vehicle_id!,
      routeId: vehicle.route_id ?? "",
      tripId,
    });
    flyTo({ latitude: vehicle.latitude, longitude: vehicle.longitude }, 16, 600);
  }, [vehicles, flyTo]);

  // Called when the user taps a stop row in BusDetailsPanel.
  // Switches to the stop panel and flies the camera to that stop.
  const handleStopTapFromBus = useCallback(async (telerideNumber: number, stopName: string) => {
    setSelectedBus(null);
    setSelectedStop({ teleride_number: telerideNumber, stop_name: stopName });

    const active = transitStops.find((s) => s.teleride_number === telerideNumber);
    if (active?.point) {
      const coord = parseWKTPoint(active.point);
      if (coord) { flyTo(coord, 16, 600); return; }
    }

    // Stop not in the filtered active set — look it up in the full cache.
    const allStops = await loadAndCacheStops();
    const stop = allStops.find((s) => s.teleride_number === telerideNumber);
    if (stop?.point) {
      const coord = parseWKTPoint(stop.point);
      if (coord) flyTo(coord, 16, 600);
    }
  }, [transitStops, flyTo]);

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
          maxBounds={CALGARY_MAX_BOUNDS}
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
              "icon-size": 0.12,
              "icon-rotate": ["get", "bearing"],
              "icon-rotation-alignment": "map",
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
              "symbol-z-order": "source",
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
        style={[styles.recenterButton, { backgroundColor: colors.card }]}
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
      <Animated.View style={[styles.sheet, { height: sheetAnim, backgroundColor: colors.card }]}>
        <View {...panResponder.panHandlers} style={styles.handleArea}>
          <View style={[styles.handle, { backgroundColor: colors.divider }]} />
          <Text style={[styles.handleHint, { color: colors.ink3 }]}>
            {isExpanded ? "Nearby Stops" : "Explore"}
          </Text>
        </View>

        {selectedStop && !isSearchActive && (
          <StopDetailsPanel
            teleride_number={selectedStop.teleride_number}
            stop_name={selectedStop.stop_name}
            onClose={() => setSelectedStop(null)}
            onBusTap={handleBusTapFromStop}
          />
        )}

        {selectedBus && !isSearchActive && (
          <BusDetailsPanel
            vehicleId={selectedBus.vehicleId}
            routeId={selectedBus.routeId}
            tripId={selectedBus.tripId}
            onClose={() => setSelectedBus(null)}
            onStopTap={handleStopTapFromBus}
          />
        )}

        {nearbyState && !isSearchActive && !placeDetails?.fromNearby && (
          <View style={[styles.nearbyPlacesPanel, { backgroundColor: colors.surface2, borderColor: colors.border }]}>
            <View style={styles.nearbyPlacesHeader}>
              <View style={styles.nearbyPlacesTitleRow}>
                <Ionicons name="location" size={14} color={theme.colors.primary} />
                <Text style={styles.nearbyPlacesTitle}>Nearby Places</Text>
              </View>
              <TouchableOpacity
                onPress={dismissNearby}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close-circle" size={22} color={theme.colors.text} />
              </TouchableOpacity>
            </View>
            {nearbyState.loading ? (
              <ActivityIndicator
                size="small"
                color={theme.colors.primary}
                style={{ marginVertical: 14 }}
              />
            ) : nearbyState.places.length === 0 ? (
              <Text style={styles.nearbyPlacesEmpty}>No places found nearby.</Text>
            ) : (
              nearbyState.places.map((place, i) => (
                <View
                  key={place.id}
                  style={[
                    styles.nearbyPlaceRow,
                    i === nearbyState.places.length - 1 && { borderBottomWidth: 0 },
                  ]}
                >
                  <TouchableOpacity
                    style={styles.nearbyPlaceInfo}
                    activeOpacity={0.7}
                    onPress={() => handleNearbyPlaceTap(place)}
                  >
                    <View style={styles.nearbyPlaceIconBox}>
                      <Ionicons name="storefront-outline" size={14} color={theme.colors.primary} />
                    </View>
                    <View style={styles.nearbyPlaceText}>
                      <Text style={[styles.nearbyPlaceName, { color: colors.ink }]} numberOfLines={1}>
                        {place.displayName.text}
                      </Text>
                      <Text style={[styles.nearbyPlaceAddress, { color: colors.ink3 }]} numberOfLines={1}>
                        {place.formattedAddress}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.nearbyPlaceGo}
                    activeOpacity={0.85}
                    onPress={() =>
                      router.navigate({
                        pathname: "/(tabs)/routes",
                        params: {
                          destinationId: place.id,
                          destinationLat: String(place.location.latitude),
                          destinationLng: String(place.location.longitude),
                          destinationName: place.displayName.text,
                        },
                      } as never)
                    }
                  >
                    <Ionicons name="navigate" size={13} color="white" />
                    <Text style={styles.nearbyPlaceGoText}>Go</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        )}

        {placeDetails && !isSearchActive && (
          <PlaceDetailsPanel
            place={placeDetails.place}
            isFetching={placeDetails.isFetching}
            onBack={placeDetails.fromNearby ? () => setPlaceDetails(null) : undefined}
            onClose={() => {
              setPlaceDetails(null);
              setDestination(null);
              if (placeDetails.fromNearby) setNearbyState(null);
            }}
            onDirections={() => {
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
          />
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
            <Text style={[styles.sectionLabel, { color: colors.ink3 }]}>Quick Access</Text>
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
                    <Text style={[styles.quickLabel, { color: colors.ink2 }]}>{item.categoryName}</Text>
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
                    { backgroundColor: colors.surface2 },
                  ]}
                >
                  <Ionicons name="add" size={16} color={colors.ink2} />
                </View>
                <Text style={[styles.quickLabel, { color: colors.ink2 }]}>Add</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        )}

        {isExpanded && !isSearchActive && (
          <View style={[styles.nearbyWrap, { borderTopColor: colors.divider }]}>
            <View style={styles.nearbyHeader}>
              <View style={styles.nearbyTitleRow}>
                <Ionicons name="radio-button-on" size={14} color={theme.colors.primary} />
                <Text style={[styles.sectionLabel, { color: colors.ink3 }]}>Nearby Stops</Text>
              </View>
            </View>
            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {nearbyTransitStops.length === 0 ? (
                <Text style={styles.nearbyStopsEmpty}>No active stops nearby.</Text>
              ) : (
                nearbyTransitStops.map((stop, i) => {
                  const isCTrain = stop.stop_name?.toLowerCase().includes("station") ?? false;
                  const stopColor = isCTrain ? theme.colors.primary : "#E0A000";
                  return (
                    <TouchableOpacity
                      key={String(stop.teleride_number)}
                      style={[
                        styles.stopRow,
                        { borderBottomColor: colors.divider },
                        i === nearbyTransitStops.length - 1 && { borderBottomWidth: 0 },
                      ]}
                      activeOpacity={0.75}
                      onPress={() => {
                        if (stop.teleride_number == null) return;
                        setNearbyState(null);
                        setPlaceDetails(null);
                        setSelectedBus(null);
                        setSelectedStop({
                          teleride_number: stop.teleride_number,
                          stop_name: stop.stop_name ?? "Unknown Stop",
                        });
                      }}
                    >
                      <View style={[styles.stopIconBox, { backgroundColor: stopColor + "15" }]}>
                        <FontAwesome5
                          name={isCTrain ? "subway" : "bus"}
                          size={13}
                          color={stopColor}
                        />
                      </View>
                      <View style={styles.stopInfo}>
                        <Text style={[styles.stopName, { color: colors.ink }]} numberOfLines={1}>
                          {stop.stop_name ?? "Unknown Stop"}
                        </Text>
                        <Text style={[styles.stopRoute, { color: colors.ink3 }]}>Stop #{stop.teleride_number}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
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
  nearbyStopsEmpty: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    textAlign: "center",
    paddingVertical: 12,
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
  nearbyPlacesPanel: {
    marginHorizontal: theme.spacing.screen,
    marginBottom: 12,
    padding: 12,
    borderRadius: 16,
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  nearbyPlacesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  nearbyPlacesTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  nearbyPlacesTitle: {
    fontSize: 10,
    fontWeight: "700",
    color: theme.colors.text,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  nearbyPlacesEmpty: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    textAlign: "center",
    paddingVertical: 8,
  },
  nearbyPlaceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  nearbyPlaceInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  nearbyPlaceIconBox: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: theme.colors.primary + "15",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  nearbyPlaceText: { flex: 1, gap: 2 },
  nearbyPlaceName: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  nearbyPlaceAddress: {
    fontSize: theme.fontSize.caption,
    fontWeight: "500",
    color: theme.colors.text,
  },
  nearbyPlaceGo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9,
    flexShrink: 0,
  },
  nearbyPlaceGoText: {
    fontSize: 12,
    fontWeight: "700",
    color: "white",
  },

});
