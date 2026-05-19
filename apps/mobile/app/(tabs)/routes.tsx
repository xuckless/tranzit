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
import { useFocusEffect } from "@react-navigation/native";
import * as Location from "expo-location";
import { theme } from "@/styles/theme";
import { TranzitApiService } from "@/services/TranzitApiService";
import { useDestinationSearch } from "@/hooks/useDestinationSearch";
import { DestinationSuggestionsList } from "@/components/search/DestinationSuggestionsList";
import {
  RoutePickerSheet,
  normalizeColor,
} from "@/components/routes/RoutePickerSheet";
import { decodePolyline } from "@/utils/decodePolyline";
import { routeStore } from "@/lib/routeStore";
import type { Route, SearchSuggestion } from "@/types/places";
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

  const originSearch = useDestinationSearch(gpsLocation);
  const destinationSearch = useDestinationSearch(gpsLocation);

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

  // ── Restore cached routes when local state is empty (e.g. after exit from commute) ──
  useFocusEffect(
    useCallback(() => {
      if (routes.length > 0) return;
      const cached = routeStore.getRoutes();
      if (cached.length === 0) return;

      setRoutes(cached);
      const cachedSelected = routeStore.getSelectedRoute() ?? cached[0] ?? null;
      setSelectedRoute(cachedSelected);

      const cachedDest = routeStore.getDestination();
      const cachedOrigin = routeStore.getOrigin();
      if (cachedDest) {
        setDestinationLabel(cachedDest.label);
        setDestination({
          lat: cachedDest.lat,
          lng: cachedDest.lng,
          placeId: cachedDest.placeId,
        });
      }
      if (cachedOrigin) {
        setOriginLabel(cachedOrigin.label || "Current Location");
        setOrigin({
          lat: cachedOrigin.lat,
          lng: cachedOrigin.lng,
          placeId: cachedOrigin.placeId,
        });
      }
    }, [routes.length]),
  );

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

  // ── Abort in-flight route request on unmount ──────────────────────────────────
  useEffect(() => {
    return () => {
      routeAbortRef.current?.abort();
    };
  }, []);

  // ── Clear routes when destination is removed ──────────────────────────────────
  useEffect(() => {
    if (!destination) {
      setRoutes([]);
      setSelectedRoute(null);
      setRouteError(null);
      routeAbortRef.current?.abort();
    }
  }, [destination]);

  // ── Route fetch (manual) ──────────────────────────────────────────────────────
  const handleFindRoutes = useCallback(() => {
    const effectiveOrigin =
      origin ??
      (gpsLocation
        ? { lat: gpsLocation.latitude, lng: gpsLocation.longitude }
        : null);
    if (!effectiveOrigin || !destination?.placeId) return;

    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;

    setIsLoadingRoutes(true);
    setRouteError(null);
    setRoutes([]);
    setSelectedRoute(null);
    Keyboard.dismiss();
    setFocusedField(null);

    TranzitApiService.getRoute(
      {
        origin: { lat: effectiveOrigin.lat, lng: effectiveOrigin.lng },
        destination_id: destination.placeId,
      },
      ctrl.signal,
    )
      .then((res) => {
        const fetchedRoutes = res.routes ?? [];
        setRoutes(fetchedRoutes);
        const firstRoute = fetchedRoutes[0] ?? null;
        setSelectedRoute(firstRoute);
        setIsLoadingRoutes(false);

        // Cache for restoration after commute exit
        routeStore.setRoutes(fetchedRoutes);
        routeStore.setSelectedRoute(firstRoute);
        routeStore.setOrigin({
          label: originLabel,
          lat: effectiveOrigin.lat,
          lng: effectiveOrigin.lng,
          placeId: origin?.placeId,
        });
        routeStore.setDestination({
          label: destinationLabel,
          lat: destination.lat,
          lng: destination.lng,
          placeId: destination.placeId,
        });

        if (fetchedRoutes.length > 0) {
          const fitCoords = [
            { latitude: effectiveOrigin.lat, longitude: effectiveOrigin.lng },
            { latitude: destination.lat, longitude: destination.lng },
          ];
          setTimeout(() => {
            mapRef.current?.fitToCoordinates(fitCoords, {
              edgePadding: { top: 50, right: 50, bottom: 50, left: 50 },
              animated: true,
            });
          }, 400);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        const msg =
          err instanceof Error ? err.message : "Failed to load routes";
        setRouteError(msg);
        setIsLoadingRoutes(false);
      });
  }, [origin, gpsLocation, destination]);

  // ── Polylines ─────────────────────────────────────────────────────────────────
  // The API does not return step-level polylines — only the route-level polyline
  // is guaranteed. Each route is rendered as a single line; the selected route
  // is thicker and uses the first transit line's color (or a palette fallback).

  const routePolylines = useMemo(() => {
    return routes.flatMap((r, i) => {
      const encoded = r.polyline?.encodedPolyline;
      if (!encoded) return [];
      let coords: { latitude: number; longitude: number }[];
      try {
        coords = decodePolyline(encoded);
      } catch {
        return [];
      }
      if (coords.length === 0) return [];

      const isSelected = r === selectedRoute;
      const transitStep = (r.legs ?? [])
        .flatMap((l) => l.steps ?? [])
        .find((s) => s.travelMode === "TRANSIT");
      const lineColor = transitStep?.transitDetails?.transitLine?.color
        ? normalizeColor(transitStep.transitDetails.transitLine.color)
        : ROUTE_PALETTE[i % ROUTE_PALETTE.length];

      return [
        {
          coords,
          color: isSelected ? lineColor : "#C1C6D7",
          width: isSelected ? 5 : 3,
          isDash: !isSelected,
        },
      ];
    });
  }, [routes, selectedRoute]);

  // ── Filter ────────────────────────────────────────────────────────────────────
  const filteredRoutes = useMemo(() => {
    if (activeFilter === "All") return routes;
    return routes.filter((route) => {
      const transitSteps = (route.legs ?? [])
        .flatMap((l) => l.steps ?? [])
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

  const handleSelectOrigin = useCallback(
    async (suggestion: SearchSuggestion) => {
      setFocusedField(null);
      originSearch.reset();
      Keyboard.dismiss();
      setOriginLabel(suggestion.mainText);
      if (suggestion.location) {
        setOrigin({
          placeId: suggestion.placeId,
          lat: suggestion.location.latitude,
          lng: suggestion.location.longitude,
        });
      } else {
        try {
          const details = await TranzitApiService.getPlaceDetails(
            suggestion.placeId,
          );
          setOrigin({
            placeId: suggestion.placeId,
            lat: details.location.latitude,
            lng: details.location.longitude,
          });
        } catch (e) {
          console.error("[routes] origin details fetch failed:", e);
          setRouteError("Could not load origin. Please try again.");
        }
      }
    },
    [originSearch],
  );

  const handleDestChange = useCallback(
    (text: string) => {
      setDestinationLabel(text);
      if (text.trim()) destinationSearch.search(text);
      else destinationSearch.reset();
    },
    [destinationSearch],
  );

  // /search results already have coordinates — use them directly.
  // Autocomplete-only results (no location) require a POST /details call.
  const handleSelectDest = useCallback(
    async (suggestion: SearchSuggestion) => {
      setFocusedField(null);
      destinationSearch.reset();
      Keyboard.dismiss();
      setDestinationLabel(suggestion.mainText);
      if (suggestion.location) {
        setDestination({
          placeId: suggestion.placeId,
          lat: suggestion.location.latitude,
          lng: suggestion.location.longitude,
        });
      } else {
        try {
          const details = await TranzitApiService.getPlaceDetails(
            suggestion.placeId,
          );
          setDestination({
            placeId: suggestion.placeId,
            lat: details.location.latitude,
            lng: details.location.longitude,
          });
        } catch (e) {
          console.error("[routes] destination details fetch failed:", e);
          setRouteError("Could not load destination. Please try again.");
        }
      }
    },
    [destinationSearch],
  );

  const dismissSearch = useCallback(() => {
    setFocusedField(null);
    originSearch.reset();
    destinationSearch.reset();
    Keyboard.dismiss();
    if (!originLabel.trim()) setOriginLabel("Current Location");
  }, [originSearch, destinationSearch, originLabel]);

  const handleStart = useCallback(() => {
    if (!selectedRoute || !destination || !origin) return;
    routeStore.setSelectedRoute(selectedRoute);
    routeStore.setDestination({
      label: destinationLabel,
      lat: destination.lat,
      lng: destination.lng,
      placeId: destination.placeId,
    });
    routeStore.setOrigin({
      label: originLabel,
      lat: origin.lat,
      lng: origin.lng,
      placeId: origin.placeId,
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
            coordinate={{
              latitude: destination.lat,
              longitude: destination.lng,
            }}
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
              onFocus={() => {
                setFocusedField("destination");
                originSearch.reset();
              }}
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
                  destinationSearch.reset();
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

          {/* Find Routes button — only when not in search mode and destination is entered */}
          {!focusedField && destinationLabel.length > 0 && (
            <>
              <View style={styles.searchDivider} />
              <TouchableOpacity
                style={[
                  styles.findRoutesBtn,
                  !destination?.placeId && styles.findRoutesBtnDisabled,
                ]}
                onPress={handleFindRoutes}
                disabled={!destination?.placeId}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="search"
                  size={14}
                  color={destination?.placeId ? "white" : theme.colors.text}
                />
                <Text
                  style={[
                    styles.findRoutesBtnText,
                    !destination?.placeId && styles.findRoutesBtnTextDisabled,
                  ]}
                >
                  Find Routes
                </Text>
              </TouchableOpacity>
            </>
          )}
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
      {focusedField === "destination" ? (
        // ── Destination: instant /search + delayed /autocomplete/json merged ──
        <View
          style={[
            styles.searchResultsArea,
            { paddingHorizontal: theme.spacing.screen },
          ]}
        >
          {destinationSearch.status === "loading" && (
            <ActivityIndicator
              style={{ marginTop: 24 }}
              size="small"
              color={theme.colors.primary}
            />
          )}
          {destinationSearch.status === "success" && (
            <DestinationSuggestionsList
              suggestions={destinationSearch.suggestions}
              onSelect={handleSelectDest}
            />
          )}
          {destinationSearch.status === "empty" && (
            <Text style={styles.emptyText}>No results found</Text>
          )}
        </View>
      ) : focusedField === "origin" ? (
        // ── Origin: same dual-source search as destination ──
        <View
          style={[
            styles.searchResultsArea,
            { paddingHorizontal: theme.spacing.screen },
          ]}
        >
          {originSearch.status === "loading" && (
            <ActivityIndicator
              style={{ marginTop: 24 }}
              size="small"
              color={theme.colors.primary}
            />
          )}
          {originSearch.status === "success" && (
            <DestinationSuggestionsList
              suggestions={originSearch.suggestions}
              onSelect={handleSelectOrigin}
            />
          )}
          {originSearch.status === "empty" && (
            <Text style={styles.emptyText}>No results found</Text>
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
                {destination
                  ? "No routes found"
                  : "Set a destination to see routes"}
              </Text>
            </View>
          )}

          {!isLoadingRoutes && !routeError && routes.length > 0 && (
            <>
              {/* Filter chips */}
              <HorizontalView
                style={{
                  backgroundColor: "black",
                  paddingHorizontal: theme.spacing.screen,
                  paddingVertical: 6,
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
                    selectedRoute={selectedRoute}
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

  findRoutesBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: theme.colors.primary,
    borderRadius: 10,
    paddingVertical: 9,
    marginTop: 4,
  },
  findRoutesBtnDisabled: {
    backgroundColor: theme.colors.muted,
  },
  findRoutesBtnText: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: "white",
  },
  findRoutesBtnTextDisabled: {
    color: theme.colors.text,
  },

  // ── Search results area ──
  searchResultsArea: {
    flex: 1,
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
