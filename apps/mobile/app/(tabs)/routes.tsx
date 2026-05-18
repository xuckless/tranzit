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
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Keyboard,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import AntDesign from "@expo/vector-icons/AntDesign";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Location from "expo-location";
import { theme } from "@/styles/theme";
import { TranzitApiService } from "@/services/TranzitApiService";
import { usePlacesSearch } from "@/hooks/usePlacesSearch";
import { SearchResultsList } from "@/components/search/SearchResultsList";
import {
  RoutePickerSheet,
  normalizeColor,
} from "@/components/routes/RoutePickerSheet";
import { decodePolyline } from "@/utils/decodePolyline";
import { routeStore } from "@/lib/routeStore";
import type { Route, SelectedDestination } from "@/types/places";
import HorizontalView from "@/components/horizontalView";

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterMode = "All" | "Bus" | "CTrain";

interface RouteEndpoint {
  placeId?: string;
  lat: number;
  lng: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROUTE_PALETTE = ["#0058BC", "#FF5722", "#2E7D32", "#6A1B9A"];

const FILTERS: { mode: FilterMode; icon: string }[] = [
  { mode: "All", icon: "list" },
  { mode: "Bus", icon: "bus" },
  { mode: "CTrain", icon: "subway" },
];

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RouteScreen() {
  const router = useRouter();
  const {
    destinationId,
    destinationLat,
    destinationLng,
    destinationName: destNameParam,
  } = useLocalSearchParams<{
    destinationId?: string;
    destinationLat?: string;
    destinationLng?: string;
    destinationName?: string;
  }>();

  const mapRef = useRef<MapView>(null);
  const originInputRef = useRef<TextInput>(null);
  const destInputRef = useRef<TextInput>(null);
  const routeAbortRef = useRef<AbortController | null>(null);

  const [gpsLocation, setGpsLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [origin, setOrigin] = useState<RouteEndpoint | null>(null);
  const [destination, setDestination] = useState<RouteEndpoint | null>(null);
  const [originLabel, setOriginLabel] = useState("Current Location");
  const [destinationLabel, setDestinationLabel] = useState("");
  const [focusedField, setFocusedField] = useState<
    "origin" | "destination" | null
  >(null);

  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [isLoadingRoutes, setIsLoadingRoutes] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterMode>("All");

  const originSearch = usePlacesSearch(gpsLocation);
  const destSearch = usePlacesSearch(gpsLocation);

  // ── Location ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;
      const { coords } = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const loc = { latitude: coords.latitude, longitude: coords.longitude };
      setGpsLocation(loc);
      setOrigin({ lat: coords.latitude, lng: coords.longitude });
    })();
  }, []);

  // ── Init destination from navigation params ──────────────────────────────────
  useEffect(() => {
    if (!destinationId || !destinationLat || !destinationLng || !destNameParam)
      return;
    setDestination({
      placeId: destinationId,
      lat: parseFloat(destinationLat),
      lng: parseFloat(destinationLng),
    });
    setDestinationLabel(destNameParam);
  }, [destinationId, destinationLat, destinationLng, destNameParam]);

  // ── Route fetch ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!origin || !destination?.placeId) return;

    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;

    setIsLoadingRoutes(true);
    setRouteError(null);
    setRoutes([]);
    setSelectedRoute(null);

    TranzitApiService.getRoute(
      {
        origin: { lat: origin.lat, lng: origin.lng },
        destination_id: destination.placeId,
      },
      ctrl.signal,
    )
      .then((res) => {
        setRoutes(res.routes);
        setSelectedRoute(res.routes[0] ?? null);
        setIsLoadingRoutes(false);

        const fitCoords = [
          { latitude: origin.lat, longitude: origin.lng },
          { latitude: destination.lat, longitude: destination.lng },
        ];
        setTimeout(() => {
          mapRef.current?.fitToCoordinates(fitCoords, {
            edgePadding: { top: 50, right: 50, bottom: 50, left: 50 },
            animated: true,
          });
        }, 400);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setRouteError(err.message || "Failed to load routes");
        setIsLoadingRoutes(false);
      });

    return () => ctrl.abort();
  }, [origin?.lat, origin?.lng, destination?.placeId]);

  // ── Polylines ─────────────────────────────────────────────────────────────────
  // The API does not return step-level polylines — only the route-level polyline
  // is guaranteed. Each route is rendered as a single line; the selected route
  // is thicker and uses the first transit line's color (or a palette fallback).

  const routePolylines = useMemo(() => {
    return routes.map((r, i) => {
      const isSelected = r === selectedRoute;
      // Use first transit step's color for the selected route if available
      const transitStep = r.legs
        .flatMap((l) => l.steps)
        .find((s) => s.travelMode === "TRANSIT");
      const lineColor = transitStep?.transitDetails?.transitLine?.color
        ? normalizeColor(transitStep.transitDetails.transitLine.color)
        : ROUTE_PALETTE[i % ROUTE_PALETTE.length];

      return {
        coords: decodePolyline(r.polyline.encodedPolyline),
        color: isSelected ? lineColor : "#C1C6D7",
        width: isSelected ? 5 : 3,
        isDash: !isSelected,
      };
    });
  }, [routes, selectedRoute]);

  // ── Filter ────────────────────────────────────────────────────────────────────
  const filteredRoutes = useMemo(() => {
    if (activeFilter === "All") return routes;
    return routes.filter((route) => {
      const transitSteps = route.legs
        .flatMap((l) => l.steps)
        .filter((s) => s.travelMode === "TRANSIT");
      if (transitSteps.length === 0) return false;
      return transitSteps.some((s) => {
        const name = (s.transitDetails?.transitLine?.name ?? "").toLowerCase();
        const ns = (
          s.transitDetails?.transitLine?.nameShort ?? ""
        ).toLowerCase();
        if (activeFilter === "CTrain")
          return (
            name.includes("ctrain") ||
            ns.includes("ctrain") ||
            name.includes("lrt")
          );
        return (
          !name.includes("ctrain") &&
          !name.includes("lrt") &&
          !ns.includes("ctrain")
        );
      });
    });
  }, [routes, activeFilter]);

  // ── Search handlers ───────────────────────────────────────────────────────────
  const handleOriginChange = useCallback(
    (text: string) => {
      setOriginLabel(text);
      if (text.trim()) originSearch.search(text);
      else originSearch.reset();
    },
    [originSearch],
  );

  const handleDestChange = useCallback(
    (text: string) => {
      setDestinationLabel(text);
      if (text.trim()) destSearch.search(text);
      else destSearch.reset();
    },
    [destSearch],
  );

  const handleSelectOrigin = useCallback(
    (dest: SelectedDestination) => {
      setOriginLabel(dest.displayText);
      setOrigin({
        placeId: dest.placeId,
        lat: dest.coordinate.latitude,
        lng: dest.coordinate.longitude,
      });
      setFocusedField(null);
      originSearch.reset();
      Keyboard.dismiss();
    },
    [originSearch],
  );

  const handleSelectDest = useCallback(
    (dest: SelectedDestination) => {
      setDestinationLabel(dest.displayText);
      setDestination({
        placeId: dest.placeId,
        lat: dest.coordinate.latitude,
        lng: dest.coordinate.longitude,
      });
      setFocusedField(null);
      destSearch.reset();
      Keyboard.dismiss();
    },
    [destSearch],
  );

  const dismissSearch = useCallback(() => {
    setFocusedField(null);
    originSearch.reset();
    destSearch.reset();
    Keyboard.dismiss();
    if (!originLabel.trim()) setOriginLabel("Current Location");
  }, [originSearch, destSearch, originLabel]);

  const handleStart = useCallback(() => {
    if (!selectedRoute || !destination || !origin) return;
    routeStore.setSelectedRoute(selectedRoute);
    routeStore.setDestination({
      label: destinationLabel,
      lat: destination.lat,
      lng: destination.lng,
    });
    routeStore.setOrigin({
      label: originLabel,
      lat: origin.lat,
      lng: origin.lng,
    });
    router.navigate("/(tabs)/commute" as never);
  }, [
    selectedRoute,
    destination,
    origin,
    destinationLabel,
    originLabel,
    router,
  ]);

  // ── Active search state ───────────────────────────────────────────────────────
  const activeSearch = focusedField === "origin" ? originSearch : destSearch;
  const handleSelectActive =
    focusedField === "origin" ? handleSelectOrigin : handleSelectDest;

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <View style={styles.screen}>
      {/* ── Map ── */}
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={styles.map}
        showsCompass={false}
        showsMyLocationButton={false}
        initialRegion={{
          latitude: 51.044,
          longitude: -114.058,
          latitudeDelta: 0.1,
          longitudeDelta: 0.1,
        }}
      >
        {/* All route polylines — selected is thick+colored, others are muted/dashed */}
        {routePolylines.map((p, i) => (
          <Polyline
            key={`route-${i}`}
            coordinates={p.coords}
            strokeColor={p.color}
            strokeWidth={p.width}
            lineDashPattern={p.isDash ? [6, 4] : undefined}
          />
        ))}

        {/* Origin dot */}
        {origin && (
          <Marker
            coordinate={{ latitude: origin.lat, longitude: origin.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View style={styles.originDot} />
          </Marker>
        )}

        {/* Destination pin */}
        {destination && (
          <Marker
            coordinate={{ latitude: destination.lat, longitude: destination.lng }}
            anchor={{ x: 0.5, y: 1.0 }}
            tracksViewChanges={false}
            pinColor={theme.colors.primary}
          />
        )}
      </MapView>

      {/* ── Search panel ── */}
      <View style={styles.searchPanel}>
        <View style={styles.searchRows}>
          {/* Origin input */}
          <View style={styles.searchRow}>
            <AntDesign
              name="aim"
              size={17}
              color={theme.colors.primary}
              style={styles.rowIcon}
            />
            <TextInput
              ref={originInputRef}
              style={styles.searchInput}
              value={originLabel}
              onChangeText={handleOriginChange}
              onFocus={() => {
                setFocusedField("origin");
                if (originLabel === "Current Location") setOriginLabel("");
              }}
              onBlur={() => {
                if (!originLabel.trim()) setOriginLabel("Current Location");
              }}
              placeholder="Origin"
              placeholderTextColor={theme.colors.text}
              returnKeyType="search"
              blurOnSubmit={false}
              autoCorrect={false}
              autoCapitalize="none"
            />
            {originLabel.length > 0 && originLabel !== "Current Location" && (
              <TouchableOpacity
                onPress={() => {
                  setOriginLabel("Current Location");
                  setOrigin(
                    gpsLocation
                      ? {
                          lat: gpsLocation.latitude,
                          lng: gpsLocation.longitude,
                        }
                      : null,
                  );
                  originSearch.reset();
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons
                  name="close-circle"
                  size={16}
                  color={theme.colors.text}
                />
              </TouchableOpacity>
            )}
          </View>

          <View style={styles.searchDivider} />

          {/* Destination input */}
          <View style={styles.searchRow}>
            <Ionicons
              name="location"
              size={17}
              color={theme.colors.tertiary}
              style={styles.rowIcon}
            />
            <TextInput
              ref={destInputRef}
              style={styles.searchInput}
              value={destinationLabel}
              onChangeText={handleDestChange}
              onFocus={() => setFocusedField("destination")}
              placeholder="Where to?"
              placeholderTextColor={theme.colors.text}
              returnKeyType="search"
              blurOnSubmit={false}
              autoCorrect={false}
              autoCapitalize="none"
            />
            {destinationLabel.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  setDestinationLabel("");
                  setDestination(null);
                  destSearch.reset();
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons
                  name="close-circle"
                  size={16}
                  color={theme.colors.text}
                />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {focusedField && (
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={dismissSearch}
            activeOpacity={0.75}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Content area ── */}
      {focusedField ? (
        // ── Search results ──
        <View style={styles.searchResultsArea}>
          {activeSearch.state.status === "loading" && (
            <ActivityIndicator
              style={{ marginTop: 24 }}
              size="small"
              color={theme.colors.primary}
            />
          )}
          {activeSearch.state.status === "success" && (
            <SearchResultsList
              results={activeSearch.state.results}
              onSelect={handleSelectActive}
            />
          )}
          {activeSearch.state.status === "empty" && (
            <Text style={styles.emptyText}>
              No results for "{activeSearch.state.query}"
            </Text>
          )}
        </View>
      ) : (
        // ── Route results ──
        <View style={styles.routeArea}>
          {isLoadingRoutes && (
            <View style={styles.centerState}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text style={styles.stateText}>Finding routes…</Text>
            </View>
          )}

          {!isLoadingRoutes && routeError && (
            <View style={styles.centerState}>
              <Ionicons
                name="warning-outline"
                size={36}
                color={theme.colors.error}
              />
              <Text style={styles.stateText}>Could not find routes</Text>
              <Text style={styles.stateSubText}>{routeError}</Text>
            </View>
          )}

          {!isLoadingRoutes && !routeError && routes.length === 0 && (
            <View style={styles.centerState}>
              <Ionicons
                name="navigate-outline"
                size={36}
                color={theme.colors.text}
              />
              <Text style={styles.stateText}>
                {destination ? "No routes found" : "Set a destination to see routes"}
              </Text>
            </View>
          )}

          {!isLoadingRoutes && !routeError && routes.length > 0 && (
            <>
              {/* Filter chips */}
              <HorizontalView
                style={{
                  paddingHorizontal: theme.spacing.screen,
                  paddingVertical: theme.spacing.element,
                  gap: theme.spacing.element,
                }}
              >
                {FILTERS.map(({ mode, icon }) => {
                  const isActive = activeFilter === mode;
                  return (
                    <TouchableOpacity
                      key={mode}
                      style={[
                        styles.modeChip,
                        isActive && styles.modeChipActive,
                      ]}
                      onPress={() => setActiveFilter(mode)}
                      activeOpacity={0.8}
                    >
                      <FontAwesome5
                        name={icon as any}
                        size={12}
                        color={
                          isActive ? theme.colors.selected : theme.colors.text
                        }
                      />
                      <Text
                        style={[
                          styles.modeChipText,
                          isActive && styles.modeChipTextActive,
                        ]}
                      >
                        {mode}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </HorizontalView>

              {/* Route list using RoutePickerSheet */}
              <View style={styles.routeListWrap}>
                {filteredRoutes.length > 0 ? (
                  <RoutePickerSheet
                    routes={filteredRoutes}
                    onSelectRoute={(r) => setSelectedRoute(r)}
                  />
                ) : (
                  <Text style={[styles.emptyText, { marginTop: 16 }]}>
                    No {activeFilter} routes available
                  </Text>
                )}
              </View>
            </>
          )}
        </View>
      )}

      {/* ── Start Journey button ── */}
      {selectedRoute && !focusedField && (
        <View style={styles.startWrap}>
          <TouchableOpacity
            style={styles.startBtn}
            onPress={handleStart}
            activeOpacity={0.85}
          >
            <Ionicons name="navigate" size={18} color="white" />
            <Text style={styles.startBtnText}>Start Journey</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#F9F9FE",
  },

  // ── Map ──
  map: {
    height: 220,
  },
  originDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.colors.primary,
    borderWidth: 3,
    borderColor: "white",
  },

  // ── Search panel ──
  searchPanel: {
    backgroundColor: "white",
    marginHorizontal: theme.spacing.screen,
    marginTop: -20,
    borderRadius: 20,
    paddingHorizontal: theme.spacing.card,
    paddingVertical: theme.spacing.element + 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchRows: {
    flex: 1,
    gap: 2,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
  },
  rowIcon: {
    width: 22,
    textAlign: "center",
  },
  searchInput: {
    flex: 1,
    fontSize: theme.fontSize.body,
    fontWeight: "600",
    color: "#1A1C1F",
  },
  searchDivider: {
    height: 1,
    backgroundColor: theme.colors.muted,
    marginLeft: 30,
  },
  cancelBtn: {
    paddingLeft: 8,
  },
  cancelText: {
    fontSize: theme.fontSize.body,
    fontWeight: "600",
    color: theme.colors.primary,
  },

  // ── Search results area ──
  searchResultsArea: {
    flex: 1,
    paddingHorizontal: theme.spacing.screen,
    paddingTop: theme.spacing.element,
  },
  emptyText: {
    fontSize: theme.fontSize.body,
    color: theme.colors.text,
    textAlign: "center",
    marginTop: 24,
  },

  // ── Route area ──
  routeArea: {
    flex: 1,
    paddingTop: theme.spacing.element,
  },
  centerState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    paddingBottom: 40,
  },
  stateText: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "600",
    color: "#1A1C1F",
    textAlign: "center",
  },
  stateSubText: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    textAlign: "center",
    maxWidth: 260,
  },

  // ── Filter chips ──
  modeChip: {
    backgroundColor: theme.colors.background,
    borderRadius: 30,
    paddingHorizontal: theme.spacing.card,
    paddingVertical: theme.spacing.element,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  modeChipActive: {
    backgroundColor: theme.colors.secondary,
  },
  modeChipText: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: theme.colors.text,
  },
  modeChipTextActive: {
    color: theme.colors.selected,
  },

  // ── Route list ──
  routeListWrap: {
    flex: 1,
    paddingBottom: 80,
  },

  // ── Start button ──
  startWrap: {
    position: "absolute",
    bottom: 16,
    left: theme.spacing.screen,
    right: theme.spacing.screen,
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  startBtn: {
    backgroundColor: theme.colors.primary,
    borderRadius: 18,
    paddingVertical: 16,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
  },
  startBtnText: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "800",
    color: "white",
    letterSpacing: 0.3,
  },
});
