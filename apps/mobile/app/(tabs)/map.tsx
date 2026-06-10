import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Dimensions,
  Keyboard,
} from "react-native";
import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import {
  Map,
  Camera,
  UserLocation,
  GeoJSONSource,
  Layer,
  Marker,
  Images,
  type CameraRef,
  type ViewStateChangeEvent,
} from "@maplibre/maplibre-react-native";
import type { NativeSyntheticEvent } from "react-native";
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
import type { AppTheme, CategoryIconKey } from "@/styles/themes";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

const SNAP_COLLAPSED = SCREEN_HEIGHT * 0.28;
const SNAP_EXPANDED  = SCREEN_HEIGHT * 0.62;
const SNAP_FULL      = SCREEN_HEIGHT * 0.79;

const CALGARY_CENTER: [number, number] = [-114.059263, 51.070664];

const CALGARY_MAX_BOUNDS: [number, number, number, number] = [-115.5, 50.147, -112.645, 51.943];

const MIN_MARKER_ZOOM = 12;

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

const CATEGORY_ICON_NAMES: Record<string, { icon: string; key: CategoryIconKey }> = {
  home:       { icon: "home",         key: "other" },
  work:       { icon: "briefcase",    key: "work" },
  office:     { icon: "briefcase",    key: "work" },
  school:     { icon: "university",   key: "school" },
  university: { icon: "university",   key: "school" },
  gym:        { icon: "dumbbell",     key: "gym" },
  food:       { icon: "utensils",     key: "food" },
  restaurant: { icon: "utensils",     key: "food" },
  health:     { icon: "heartbeat",    key: "health" },
  hospital:   { icon: "hospital",     key: "health" },
  shopping:   { icon: "shopping-bag", key: "shopping" },
  park:       { icon: "tree",         key: "park" },
};

function quickIcon(categoryName: string, theme: AppTheme): { icon: string; color: string } {
  const entry = CATEGORY_ICON_NAMES[categoryName.toLowerCase()];
  if (!entry) {
    return { icon: "map-marker-alt", color: theme.colors.ink2 };
  }
  return {
    icon: entry.icon,
    color: theme.semantic.categoryIcons[entry.key] ?? theme.colors.primary,
  };
}

// ─── Tile math ─────────────────────────────────────────────────────────────────

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
  const { theme } = useTheme();
  const { colors, typography, semantic, spacing, radii, shadow, mapPaint } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // gorhom sheet: absolute-height snap points (from the bottom), matching the
  // geometry of the old Animated height exactly. Index 0 = collapsed.
  const sheetRef = useRef<BottomSheet>(null);
  const snapPoints = useMemo(
    () => [SNAP_COLLAPSED, SNAP_EXPANDED, SNAP_FULL],
    [],
  );
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

  // Current camera bounds ([w, s, e, n]), refreshed when a pan/zoom settles.
  // Used only to cull the per-tick GeoJSON allocation — never the vehicle
  // data itself (handleBusTapFromStop needs the full fleet).
  const [viewBounds, setViewBounds] = useState<
    [number, number, number, number] | null
  >(null);
  const viewBoundsRef = useRef<typeof viewBounds>(null);

  const [nearbyState, setNearbyState] = useState<NearbyState | null>(null);
  const pressAbortRef = useRef<AbortController | null>(null);

  const selectedStopRef = useRef<typeof selectedStop>(null);
  const selectedBusRef = useRef<typeof selectedBus>(null);
  useEffect(() => { selectedStopRef.current = selectedStop; }, [selectedStop]);
  useEffect(() => { selectedBusRef.current = selectedBus; }, [selectedBus]);

  const layerTappedRef = useRef(false);

  // ── Load active transit stops with imminent-arrival filter ───────────────────
  useEffect(() => {
    const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
    (async () => {
      let activeStops: CalgaryTransitStop[] = [];
      try {
        const allStops = await loadAndCacheStops();
        activeStops = allStops.filter(
          (s) => s.status?.toLowerCase() === "active" && s.teleride_number != null,
        );
      } catch (e) {
        console.warn("[map] stop cache load failed", e);
        return;
      }

      let scheduled = new Set<string | null>();
      try {
        const scheduledStus = await middlewareQuery<{ stop_id: string | null }>(
          "stop_time_updates",
          {
            schedule_relationship: "neq.NO_DATA",
            or: `(arrival_time.gte.${fiveMinAgo},arrival_time.eq.-1)`,
            limit: 5000,
          },
        );
        scheduled = new Set(scheduledStus.map((s) => s.stop_id));
      } catch (e) {
        console.warn("[map] stop_time_updates gate failed; showing all active stops", e);
      }

      setTransitStops(
        scheduled.size === 0
          ? activeStops
          : activeStops.filter((s) => scheduled.has(String(s.teleride_number))),
      );
    })();
  }, []);

  // ── Stops GeoJSON ─────────────────────────────────────────────────────────────
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

  const handleRegionDidChange = useCallback(
    (e: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      const next = e.nativeEvent.bounds;
      const prev = viewBoundsRef.current;
      // Epsilon guard: ignore sub-rounding no-op events so render churn
      // doesn't invalidate the visibleVehicles memo for nothing.
      const EPS = 1e-4;
      if (prev && next.every((v, i) => Math.abs(v - prev[i]) < EPS)) return;
      viewBoundsRef.current = next;
      setViewBounds(next);
    },
    [],
  );

  // Cull vehicles to the padded viewport before allocating GeoJSON. The 50%
  // pad per side keeps just-off-screen buses present mid-pan; bounds refresh
  // at gesture end, so visible behavior matches the unfiltered version.
  const visibleVehicles = useMemo(() => {
    if (!viewBounds) return vehicles;
    const [w, s, e, n] = viewBounds;
    const padLng = (e - w) * 0.5;
    const padLat = (n - s) * 0.5;
    return vehicles.filter(
      (v) =>
        v.longitude! >= w - padLng &&
        v.longitude! <= e + padLng &&
        v.latitude! >= s - padLat &&
        v.latitude! <= n + padLat,
    );
  }, [vehicles, viewBounds]);

  const vehiclesGeoJSON = useMemo(
    () => vehiclesToGeoJSON(visibleVehicles),
    [visibleVehicles],
  );

  // ── Nearby stops (tile-filtered) ─────────────────────────────────────────────
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
  const handleStopLayerPress = useCallback((event: any) => {
    layerTappedRef.current = true;
    const feature = event?.nativeEvent?.features?.[0];
    const props = feature?.properties;
    if (!props || props.teleride_number == null) return;

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
  // Same call-site API as the old Animated implementation: callers pass the
  // pixel constant, we map it to a gorhom snap index. Drag gestures and snap
  // resolution now run on the UI thread (gesture-handler + reanimated).
  const snapTo = useCallback((target: number) => {
    setIsExpanded(target >= SNAP_EXPANDED);
    const index =
      target <= SNAP_COLLAPSED ? 0 : target <= SNAP_EXPANDED ? 1 : 2;
    sheetRef.current?.snapToIndex(index);
  }, []);

  const handleSheetChange = useCallback((index: number) => {
    setIsExpanded(index >= 1);
  }, []);

  // Stable handle renderer — an inline arrow here would be a new component
  // type every render, remounting the handle and dropping its pan gesture
  // mid-drag.
  const renderSheetHandle = useCallback(
    () => (
      <View style={styles.handleArea}>
        <View style={[styles.handle, { backgroundColor: semantic.handle }]} />
        <Text style={[styles.handleHint, { color: semantic.handleHint }]}>
          {isExpanded ? "Nearby Stops" : "Explore"}
        </Text>
      </View>
    ),
    [styles, semantic, isExpanded],
  );

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
  const onMapPress = useCallback(
    (e: any) => {
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

  const handleStopTapFromBus = useCallback(async (telerideNumber: number, stopName: string) => {
    setSelectedBus(null);
    setSelectedStop({ teleride_number: telerideNumber, stop_name: stopName });

    const active = transitStops.find((s) => s.teleride_number === telerideNumber);
    if (active?.point) {
      const coord = parseWKTPoint(active.point);
      if (coord) { flyTo(coord, 16, 600); return; }
    }

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
        mapStyle={mapPaint.baseStyle}
        onPress={onMapPress}
        onLongPress={onMapLongPress}
        onRegionDidChange={handleRegionDidChange}
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

        <UserLocation heading={true} animated={true} />

        <Images
          images={{
            tranzitBus: require("@/assets/images/tranzit_busView.png"),
          }}
        />

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
              "circle-color": mapPaint.stopCircle.color,
              "circle-stroke-color": mapPaint.stopCircle.stroke,
              "circle-stroke-width": mapPaint.stopCircle.strokeWidth,
              "circle-opacity": mapPaint.stopCircle.opacity,
            }}
          />
        </GeoJSONSource>

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
              "icon-size": mapPaint.busSymbol.iconSize,
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
              "text-size": mapPaint.busSymbol.textSize,
              "text-font": ["Noto Sans Regular"],
              "text-rotation-alignment": "viewport",
              "text-allow-overlap": true,
              "text-ignore-placement": true,
              "text-anchor": "center",
              "text-offset": [0, 0],
            }}
            paint={{
              "text-color": mapPaint.busSymbol.textColor,
              "text-halo-color": mapPaint.busSymbol.haloColor,
              "text-halo-width": mapPaint.busSymbol.haloWidth,
            }}
          />
        </GeoJSONSource>

        {destination && (
          <Marker
            id="destination-pin"
            lngLat={[destination.longitude, destination.latitude]}
            anchor="bottom"
          >
            <Ionicons name="location" size={32} color={colors.primary} />
          </Marker>
        )}
      </Map>

      <TouchableOpacity
        style={[styles.recenterButton, { backgroundColor: colors.card }]}
        onPress={fetchCurrentLocation}
        activeOpacity={0.85}
        disabled={loadingLocation}
      >
        {loadingLocation ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Ionicons name="locate" size={22} color={colors.primary} />
        )}
      </TouchableOpacity>

      {errorMsg && (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={15} color={semantic.errorBannerText} />
          <Text style={styles.errorText}>{errorMsg}</Text>
        </View>
      )}

      {/* ════════ BOTTOM SHEET ════════ */}
      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={snapPoints}
        enablePanDownToClose={false}
        // The original PanResponder sheet dragged only from the handle;
        // keeping content panning off lets every inner list scroll natively
        // at any snap height (gorhom scrollables otherwise lock until the
        // sheet reaches its top snap, and only one scrollable can register).
        enableContentPanningGesture={false}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onChange={handleSheetChange}
        backgroundStyle={[
          styles.sheetBackground,
          { backgroundColor: colors.card },
        ]}
        style={styles.sheetShadow}
        handleComponent={renderSheetHandle}
      >
        <BottomSheetView style={styles.sheetContent}>
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
                <Ionicons name="location" size={14} color={colors.primary} />
                <Text style={[styles.nearbyPlacesTitle, { color: colors.ink2 }]}>Nearby Places</Text>
              </View>
              <TouchableOpacity
                onPress={dismissNearby}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close-circle" size={22} color={colors.ink3} />
              </TouchableOpacity>
            </View>
            {nearbyState.loading ? (
              <ActivityIndicator
                size="small"
                color={colors.primary}
                style={{ marginVertical: 14 }}
              />
            ) : nearbyState.places.length === 0 ? (
              <Text style={[styles.nearbyPlacesEmpty, { color: colors.ink3 }]}>No places found nearby.</Text>
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
                      <Ionicons name="storefront-outline" size={14} color={colors.primary} />
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
                    <Ionicons name="navigate" size={13} color={colors.onPrimary} />
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
                const { icon, color } = quickIcon(item.categoryName, theme);
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
                <Ionicons name="radio-button-on" size={14} color={colors.primary} />
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
                  const stopColor = isCTrain ? colors.primary : semantic.categoryIcons.food;
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
        </BottomSheetView>
      </BottomSheet>

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

function makeStyles(t: AppTheme) {
  const { colors, typography, semantic, spacing, radii, shadow, mapPaint } = t;
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    map: { ...StyleSheet.absoluteFillObject },

    recenterButton: {
      position: "absolute",
      bottom: SNAP_COLLAPSED + 16,
      right: 16,
      width: 48,
      height: 48,
      borderRadius: 14,
      backgroundColor: colors.card,
      justifyContent: "center",
      alignItems: "center",
      shadowColor: semantic.shadow,
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
      backgroundColor: semantic.errorBannerBg,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 9,
      borderWidth: 1,
      borderColor: semantic.errorBannerBorder,
    },
    errorText: {
      ...typography.bodySmallStrong,
      color: semantic.errorBannerText,
    },

    sheetBackground: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
    },
    sheetShadow: {
      shadowColor: semantic.shadow,
      shadowOffset: { width: 0, height: -6 },
      shadowOpacity: 0.1,
      shadowRadius: 20,
      elevation: 24,
    },
    sheetContent: {
      flex: 1,
    },
    handleArea: { alignItems: "center", paddingTop: 10, paddingBottom: 6 },
    handle: {
      width: 38,
      height: 4,
      borderRadius: 2,
      marginBottom: 6,
    },
    handleHint: {
      ...typography.micro,
      letterSpacing: 0.6,
      textTransform: "uppercase",
    },

    sectionWrap: { paddingHorizontal: spacing.screen, marginBottom: 4 },
    sectionLabel: {
      ...typography.micro,
      color: colors.ink3,
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
      ...typography.badge,
      color: colors.ink2,
    },

    nearbyWrap: {
      flex: 1,
      paddingHorizontal: spacing.screen,
      paddingTop: 14,
      borderTopWidth: 1,
      borderTopColor: colors.divider,
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
      ...typography.caption,
      color: colors.ink3,
      textAlign: "center",
      paddingVertical: 12,
    },
    stopRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 11,
      borderBottomWidth: 1,
      borderBottomColor: colors.divider,
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
      ...typography.bodyStrong,
      color: colors.ink,
    },
    stopRoute: {
      ...typography.caption,
      fontWeight: "500",
      color: colors.ink3,
    },
    nearbyPlacesPanel: {
      marginHorizontal: spacing.screen,
      marginBottom: 12,
      padding: 12,
      borderRadius: 16,
      backgroundColor: colors.surface2,
      borderWidth: 1,
      borderColor: colors.border,
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
      ...typography.micro,
      color: colors.ink2,
      textTransform: "uppercase",
      letterSpacing: 0.6,
    },
    nearbyPlacesEmpty: {
      ...typography.caption,
      color: colors.ink3,
      textAlign: "center",
      paddingVertical: 8,
    },
    nearbyPlaceRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
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
      backgroundColor: colors.primaryDim,
      justifyContent: "center",
      alignItems: "center",
      flexShrink: 0,
    },
    nearbyPlaceText: { flex: 1, gap: 2 },
    nearbyPlaceName: {
      ...typography.bodyStrong,
      color: colors.ink,
    },
    nearbyPlaceAddress: {
      ...typography.caption,
      fontWeight: "500",
      color: colors.ink3,
    },
    nearbyPlaceGo: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: colors.primary,
      paddingHorizontal: 12,
      paddingVertical: 7,
      borderRadius: 9,
      flexShrink: 0,
    },
    nearbyPlaceGoText: {
      ...typography.captionStrong,
      fontWeight: "700",
      color: colors.onPrimary,
    },
  });
}
