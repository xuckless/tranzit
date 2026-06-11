import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    ActivityIndicator,
    Keyboard,
} from "react-native";
import {
    Map,
    Camera,
    GeoJSONSource,
    Layer,
    Marker,
    type CameraRef,
} from "@maplibre/maplibre-react-native";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import AntDesign from "@expo/vector-icons/AntDesign";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import * as Location from "expo-location";
import { useTheme } from "@/contexts/ThemeContext";
import { TranzitApiService } from "@/services/TranzitApiService";
import { useDestinationSearch } from "@/hooks/useDestinationSearch";
import { DestinationSuggestionsList } from "@/components/search/DestinationSuggestionsList";
import {
    RoutePickerSheet,
    normalizeColor,
    formatDistance,
} from "@/components/routes/RoutePickerSheet";
import { decodePolyline } from "@/utils/decodePolyline";
import { routeStore } from "@/lib/routeStore";
import { groupRoutes, routeUsesTrain, routeWalkDistance } from "@/lib/routeRanking";
import type { Route, SearchSuggestion } from "@/types/places";
import HorizontalView from "@/components/horizontalView";
import type { AppTheme } from "@/styles/themes";

const CALGARY_CENTER: [number, number] = [-114.058, 51.044];

// ─── Types ────────────────────────────────────────────────────────────────────

interface RouteEndpoint {
    placeId?: string;
    lat: number;
    lng: number;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RouteScreen() {
    const router = useRouter();
    const { theme } = useTheme();
    const { colors, typography, semantic, spacing, radii, shadow, mapPaint } =
        theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);
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

    const cameraRef = useRef<CameraRef>(null);
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
    const [activeFilter, setActiveFilter] = useState<string>("All");
    const [isStarting, setIsStarting] = useState(false);
    const [startError, setStartError] = useState<string | null>(null);

    const originSearch = useDestinationSearch(gpsLocation);
    const destinationSearch = useDestinationSearch(gpsLocation);

    // ── Location ─────────────────────────────────────────────────────────────────
    useEffect(() => {
        (async () => {
            const { status } =
                await Location.requestForegroundPermissionsAsync();
            if (status !== "granted") return;
            const { coords } = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.Balanced,
            });
            const loc = {
                latitude: coords.latitude,
                longitude: coords.longitude,
            };
            setGpsLocation(loc);
            setOrigin({ lat: coords.latitude, lng: coords.longitude });
        })();
    }, []);

    // ── Restore cached routes when local state is empty ──────────────────────────
    useFocusEffect(
        useCallback(() => {
            if (routes.length > 0) return;
            const cached = routeStore.getRoutes();
            if (cached.length === 0) return;

            setRoutes(cached);
            const cachedSelected =
                routeStore.getSelectedRoute() ?? cached[0] ?? null;
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

    useEffect(() => {
        if (
            !destinationId ||
            !destinationLat ||
            !destinationLng ||
            !destNameParam
        )
            return;
        setDestination({
            placeId: destinationId,
            lat: parseFloat(destinationLat),
            lng: parseFloat(destinationLng),
        });
        setDestinationLabel(destNameParam);
    }, [destinationId, destinationLat, destinationLng, destNameParam]);

    useEffect(() => {
        return () => {
            routeAbortRef.current?.abort();
        };
    }, []);

    useEffect(() => {
        if (!destination) {
            setRoutes([]);
            setSelectedRoute(null);
            setRouteError(null);
            routeAbortRef.current?.abort();
        }
    }, [destination]);

    // ── Route fetch ───────────────────────────────────────────────────────────────
    const handleFindRoutes = useCallback(() => {
        const effectiveOrigin =
            origin ??
            (gpsLocation
                ? { lat: gpsLocation.latitude, lng: gpsLocation.longitude }
                : null);
        if (!effectiveOrigin || !destination) return;

        routeAbortRef.current?.abort();
        const ctrl = new AbortController();
        routeAbortRef.current = ctrl;

        setIsLoadingRoutes(true);
        setRouteError(null);
        setRoutes([]);
        setSelectedRoute(null);
        setActiveFilter("All");
        Keyboard.dismiss();
        setFocusedField(null);

        // ── Routing engine select ────────────────────────────────────────────
        // OTP (active): plans from coordinates, no Place ID required. The fetched
        // routes are tagged source:"opentrip", so handleStart() posts the OTP
        // contract automatically — switching engines needs no change there.
        const routesPromise = TranzitApiService.getOTPRoute(
            {
                origin: { lat: effectiveOrigin.lat, lng: effectiveOrigin.lng },
                destination: { lat: destination.lat, lng: destination.lng },
                num_itineraries: 10,
            },
            ctrl.signal,
        );
        // ── Google Routes (standby) ──────────────────────────────────────────
        // To switch engines: comment out the OTP block above and uncomment this.
        // Routes come back tagged source:"google-maps-api"; handleStart() then
        // posts the Google (Place ID) contract. Needs destination.placeId.
        // const routesPromise = TranzitApiService.getRoute(
        //     {
        //         origin: { lat: effectiveOrigin.lat, lng: effectiveOrigin.lng },
        //         destination_id: destination.placeId,
        //     },
        //     ctrl.signal,
        // );

        routesPromise
            .then((res) => {
                const fetchedRoutes = res.routes ?? [];
                setRoutes(fetchedRoutes);
                const firstRoute = fetchedRoutes[0] ?? null;
                setSelectedRoute(firstRoute);
                setIsLoadingRoutes(false);

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
                    const lats = [effectiveOrigin.lat, destination.lat];
                    const lngs = [effectiveOrigin.lng, destination.lng];
                    const bounds: [number, number, number, number] = [
                        Math.min(...lngs),
                        Math.min(...lats),
                        Math.max(...lngs),
                        Math.max(...lats),
                    ];
                    setTimeout(() => {
                        cameraRef.current?.fitBounds(bounds, {
                            duration: 800,
                            padding: {
                                top: 50,
                                right: 50,
                                bottom: 50,
                                left: 50,
                            },
                        });
                    }, 400);
                }
            })
            .catch((err: unknown) => {
                if (err instanceof Error && err.name === "AbortError") return;
                const msg =
                    err instanceof Error
                        ? err.message
                        : "Failed to load routes";
                setRouteError(msg);
                setIsLoadingRoutes(false);
            });
    }, [origin, gpsLocation, destination, originLabel, destinationLabel]);

    // ── Polyline GeoJSON ──────────────────────────────────────────────────────────
    const routesGeoJSON = useMemo(() => {
        const features = routes.flatMap((r, i) => {
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
                ? normalizeColor(
                      transitStep.transitDetails.transitLine.color,
                      theme.colors.primary,
                  )
                : semantic.routePalette[i % semantic.routePalette.length];

            return [
                {
                    type: "Feature" as const,
                    properties: {
                        color: isSelected
                            ? lineColor
                            : semantic.unselectedPolyline,
                        width: isSelected ? 5 : 3,
                        isSelected,
                    },
                    geometry: {
                        type: "LineString" as const,
                        coordinates: coords.map(
                            (c) =>
                                [c.longitude, c.latitude] as [number, number],
                        ),
                    },
                },
            ];
        });

        return { type: "FeatureCollection" as const, features };
    }, [
        routes,
        selectedRoute,
        theme.colors.primary,
        semantic.routePalette,
        semantic.unselectedPolyline,
    ]);

    // ── Grouping / ranking ────────────────────────────────────────────────────────
    // Routes are sectioned by the line(s) they ride ("201", "201+30", "Walk"),
    // each section ascending by first bus departure. (Built in routeRanking —
    // the MapLibre `Map` import shadows the Map constructor in this file.)
    const { meta: routeMeta, groups: routeGroups } = useMemo(
        () => groupRoutes(routes),
        [routes],
    );

    // Fastest = earliest arrival at the destination, across all routes.
    const overallFastest = useMemo(() => {
        let best: Route | null = null;
        for (const r of routes) {
            if (!best || routeMeta.get(r)!.arrival < routeMeta.get(best)!.arrival)
                best = r;
        }
        return best;
    }, [routes, routeMeta]);

    // Least walking = minimum total walk distance, across all routes.
    const leastWalkingRoute = useMemo(() => {
        let best: Route | null = null;
        for (const r of routes) {
            if (!best || routeWalkDistance(r) < routeWalkDistance(best)) best = r;
        }
        return best;
    }, [routes]);

    const filterChips = useMemo(() => {
        const keys = [...routeGroups.entries()]
            .map(([key, arr]) => {
                const icon = arr.some(routeUsesTrain)
                    ? "subway"
                    : key === "Walk"
                      ? "walking"
                      : "bus";
                const bestArrival = Math.min(
                    ...arr.map((r) => routeMeta.get(r)!.arrival),
                );
                const bestRoute =
                    arr.find((r) => routeMeta.get(r)!.arrival === bestArrival) ??
                    arr[0];
                const walkDist =
                    icon === "walking"
                        ? formatDistance(routeWalkDistance(bestRoute))
                        : undefined;
                return { key, best: bestArrival, icon, walkDist };
            })
            .sort((a, b) => a.best - b.best)
            .map(({ key, icon, walkDist }) => ({ key, icon, walkDist }));
        return [
            { key: "All", icon: "list", walkDist: undefined as string | undefined },
            ...keys,
        ];
    }, [routeGroups, routeMeta]);

    const filteredRoutes = useMemo(() => {
        const arrival = (r: Route) => routeMeta.get(r)?.arrival ?? Infinity;
        if (activeFilter === "All") {
            // Curated view: the overall fastest + the fastest of each section.
            const picks = new Set<Route>();
            if (overallFastest) picks.add(overallFastest);
            for (const arr of routeGroups.values()) {
                let best: Route | null = null;
                for (const r of arr)
                    if (!best || arrival(r) < arrival(best)) best = r;
                if (best) picks.add(best);
            }
            return [...picks].sort((a, b) => arrival(a) - arrival(b));
        }
        return routeGroups.get(activeFilter) ?? [];
    }, [activeFilter, routeGroups, overallFastest, routeMeta]);

    // ── Search handlers ───────────────────────────────────────────────────────────
    // Editing either endpoint invalidates any routes on screen. Clearing the
    // routeStore too is load-bearing: the focus-restore effect above would
    // otherwise resurrect the cached results the moment local state empties.
    const clearStaleResults = useCallback(() => {
        if (routes.length === 0 && !selectedRoute && !routeError) return;
        setRoutes([]);
        setSelectedRoute(null);
        setRouteError(null);
        setActiveFilter("All");
        routeStore.setRoutes([]);
    }, [routes.length, selectedRoute, routeError]);

    const handleOriginChange = useCallback(
        (text: string) => {
            setOriginLabel(text);
            clearStaleResults();
            if (text.trim()) originSearch.search(text);
            else originSearch.reset();
        },
        [originSearch, clearStaleResults],
    );

    const handleSelectOrigin = useCallback(
        async (suggestion: SearchSuggestion) => {
            setFocusedField(null);
            originSearch.reset();
            Keyboard.dismiss();
            setOriginLabel(suggestion.mainText);
            setRoutes([]);
            setSelectedRoute(null);
            setRouteError(null);
            routeStore.setRoutes([]);
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
            clearStaleResults();
            if (text.trim()) destinationSearch.search(text);
            else destinationSearch.reset();
        },
        [destinationSearch, clearStaleResults],
    );

    const handleSelectDest = useCallback(
        async (suggestion: SearchSuggestion) => {
            setFocusedField(null);
            destinationSearch.reset();
            Keyboard.dismiss();
            setDestinationLabel(suggestion.mainText);
            setRoutes([]);
            setSelectedRoute(null);
            setRouteError(null);
            routeStore.setRoutes([]);
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
                    console.error(
                        "[routes] destination details fetch failed:",
                        e,
                    );
                    setRouteError(
                        "Could not load destination. Please try again.",
                    );
                }
            }
        },
        [destinationSearch],
    );

    const dismissSearch = useCallback(() => {
        Keyboard.dismiss();
        setFocusedField(null);
        originSearch.reset();
        destinationSearch.reset();
        setOriginLabel("Current Location");
        setOrigin(
            gpsLocation
                ? { lat: gpsLocation.latitude, lng: gpsLocation.longitude }
                : null,
        );
        setDestinationLabel("");
        setDestination(null);
        setRoutes([]);
        setSelectedRoute(null);
        setRouteError(null);
        routeStore.clear();
        router.navigate("/(tabs)/map" as never);
    }, [originSearch, destinationSearch, gpsLocation, router]);

    const handleStart = useCallback(async () => {
        const effectiveOrigin =
            origin ??
            (gpsLocation
                ? { lat: gpsLocation.latitude, lng: gpsLocation.longitude }
                : null);
        if (!selectedRoute || !destination || !effectiveOrigin) return;

        // The OTP path resolves stops from coordinates and reroutes from coords, so
        // it does not need a Place ID; the Google path does. Branch the POST body on
        // the engine that produced the route (tagged by parseRouteResponse()).
        const isOTP = selectedRoute.source === "opentrip";
        if (!isOTP && !destination.placeId) return;

        setIsStarting(true);
        setStartError(null);

        try {
            const routeSaveUrl = process.env.EXPO_PUBLIC_ROUTE_SAVE_URL;
            if (!routeSaveUrl) throw new Error("ROUTE_SAVE_URL not configured");

            const body = isOTP
                ? {
                      source: "opentrip",
                      // Raw OTP itinerary — carries trip_id + stop ids/coords that
                      // the normalized Route drops and Route Save's OTP path needs.
                      route: selectedRoute.otpItinerary ?? selectedRoute,
                      destination: {
                          lat: destination.lat,
                          lng: destination.lng,
                      },
                      origin: {
                          lat: effectiveOrigin.lat,
                          lng: effectiveOrigin.lng,
                      },
                  }
                : {
                      // Google Routes: the canonical route IS the raw Google route,
                      // and Route Save needs the Place ID to reroute.
                      route: selectedRoute,
                      destination_place_id: destination.placeId,
                      origin: {
                          lat: effectiveOrigin.lat,
                          lng: effectiveOrigin.lng,
                      },
                  };

            const resp = await fetch(`${routeSaveUrl}/trips`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (!resp.ok) {
                const body = await resp.text().catch(() => "");
                throw new Error(`${resp.status}${body ? `: ${body}` : ""}`);
            }

            const { session_id, ws_url } = (await resp.json()) as {
                session_id: string;
                ws_url: string;
            };

            routeStore.setSelectedRoute(selectedRoute);
            routeStore.setDestination({
                label: destinationLabel,
                lat: destination.lat,
                lng: destination.lng,
                placeId: destination.placeId,
            });
            routeStore.setOrigin({
                label: originLabel,
                lat: effectiveOrigin.lat,
                lng: effectiveOrigin.lng,
                placeId: origin?.placeId,
            });
            routeStore.setTripSession({ sessionId: session_id, wsUrl: ws_url });

            router.navigate("/(tabs)/commute" as never);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            setStartError(`Could not start trip: ${msg}`);
        } finally {
            setIsStarting(false);
        }
    }, [
        selectedRoute,
        destination,
        origin,
        gpsLocation,
        destinationLabel,
        originLabel,
        router,
    ]);

    // ─── Render ──────────────────────────────────────────────────────────────────
    return (
        <View style={[styles.screen, { backgroundColor: colors.surface }]}>
            <Map
                style={styles.map}
                mapStyle={mapPaint.baseStyle}
                compass={false}
                logo={false}
                attribution={true}
            >
                <Camera
                    ref={cameraRef}
                    initialViewState={{
                        center: CALGARY_CENTER,
                        zoom: 11,
                    }}
                />

                <GeoJSONSource id="routes-source" data={routesGeoJSON}>
                    <Layer
                        id="routes-line-selected"
                        type="line"
                        filter={["==", ["get", "isSelected"], true]}
                        paint={{
                            "line-color": ["get", "color"],
                            "line-width": ["get", "width"],
                        }}
                        layout={{
                            "line-cap": "round",
                            "line-join": "round",
                        }}
                    />
                    <Layer
                        id="routes-line-unselected"
                        type="line"
                        filter={["==", ["get", "isSelected"], false]}
                        paint={{
                            "line-color": ["get", "color"],
                            "line-width": ["get", "width"],
                            "line-dasharray": [2, 1.5],
                        }}
                        layout={{
                            "line-cap": "round",
                            "line-join": "round",
                        }}
                    />
                </GeoJSONSource>

                {origin && (
                    <Marker
                        id="origin-marker"
                        lngLat={[origin.lng, origin.lat]}
                        anchor="center"
                    >
                        <View style={styles.originDot} />
                    </Marker>
                )}

                {destination && (
                    <Marker
                        id="destination-marker"
                        lngLat={[destination.lng, destination.lat]}
                        anchor="bottom"
                    >
                        <Ionicons
                            name="location"
                            size={32}
                            color={colors.primary}
                        />
                    </Marker>
                )}
            </Map>

            {/* ── Search panel ── */}
            <View
                style={[styles.searchPanel, { backgroundColor: colors.card }]}
            >
                <View style={styles.searchRows}>
                    <View style={styles.searchRow}>
                        <AntDesign
                            name="aim"
                            size={17}
                            color={colors.primary}
                            style={styles.rowIcon}
                        />
                        <TextInput
                            ref={originInputRef}
                            style={[styles.searchInput, { color: colors.ink }]}
                            value={originLabel}
                            onChangeText={handleOriginChange}
                            onFocus={() => {
                                setFocusedField("origin");
                                if (originLabel === "Current Location")
                                    setOriginLabel("");
                            }}
                            onBlur={() => {
                                if (!originLabel.trim())
                                    setOriginLabel("Current Location");
                            }}
                            placeholder="Origin"
                            placeholderTextColor={colors.ink2}
                            returnKeyType="search"
                            blurOnSubmit={false}
                            autoCorrect={false}
                            autoCapitalize="none"
                        />
                        {originLabel.length > 0 &&
                            originLabel !== "Current Location" && (
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
                                        setRoutes([]);
                                        setSelectedRoute(null);
                                        setRouteError(null);
                                        routeStore.setRoutes([]);
                                    }}
                                    hitSlop={{
                                        top: 8,
                                        bottom: 8,
                                        left: 8,
                                        right: 8,
                                    }}
                                >
                                    <Ionicons
                                        name="close-circle"
                                        size={16}
                                        color={colors.ink2}
                                    />
                                </TouchableOpacity>
                            )}
                    </View>

                    <View
                        style={[
                            styles.searchDivider,
                            { backgroundColor: colors.divider },
                        ]}
                    />

                    <View style={styles.searchRow}>
                        <Ionicons
                            name="location"
                            size={17}
                            color={colors.tertiary}
                            style={styles.rowIcon}
                        />
                        <TextInput
                            ref={destInputRef}
                            style={[styles.searchInput, { color: colors.ink }]}
                            value={destinationLabel}
                            onChangeText={handleDestChange}
                            onFocus={() => {
                                setFocusedField("destination");
                                originSearch.reset();
                            }}
                            placeholder="Where to?"
                            placeholderTextColor={colors.ink2}
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
                                    setRoutes([]);
                                    setSelectedRoute(null);
                                    setRouteError(null);
                                    routeStore.setRoutes([]);
                                }}
                                hitSlop={{
                                    top: 8,
                                    bottom: 8,
                                    left: 8,
                                    right: 8,
                                }}
                            >
                                <Ionicons
                                    name="close-circle"
                                    size={16}
                                    color={colors.ink2}
                                />
                            </TouchableOpacity>
                        )}
                    </View>

                    {!focusedField && destinationLabel.length > 0 && (
                        <>
                            <View
                                style={[
                                    styles.searchDivider,
                                    { backgroundColor: colors.divider },
                                ]}
                            />
                            <TouchableOpacity
                                style={[
                                    styles.findRoutesBtn,
                                    !destination &&
                                        styles.findRoutesBtnDisabled,
                                ]}
                                onPress={handleFindRoutes}
                                disabled={!destination}
                                activeOpacity={0.8}
                            >
                                <Ionicons
                                    name="search"
                                    size={14}
                                    color={
                                        destination
                                            ? colors.onPrimary
                                            : colors.ink3
                                    }
                                />
                                <Text
                                    style={[
                                        styles.findRoutesBtnText,
                                        !destination &&
                                            styles.findRoutesBtnTextDisabled,
                                    ]}
                                >
                                    Find Routes
                                </Text>
                            </TouchableOpacity>
                        </>
                    )}
                </View>

                <TouchableOpacity
                    style={styles.cancelBtn}
                    onPress={dismissSearch}
                    activeOpacity={0.75}
                >
                    <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
            </View>

            {/* ── Content area ── */}
            {focusedField === "destination" ? (
                <View
                    style={[
                        styles.searchResultsArea,
                        { paddingHorizontal: spacing.screen },
                    ]}
                >
                    {destinationSearch.status === "loading" && (
                        <ActivityIndicator
                            style={{ marginTop: 24 }}
                            size="small"
                            color={colors.primary}
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
                <View
                    style={[
                        styles.searchResultsArea,
                        { paddingHorizontal: spacing.screen },
                    ]}
                >
                    {originSearch.status === "loading" && (
                        <ActivityIndicator
                            style={{ marginTop: 24 }}
                            size="small"
                            color={colors.primary}
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
                <View style={styles.routeArea}>
                    {isLoadingRoutes && (
                        <View style={styles.centerState}>
                            <ActivityIndicator
                                size="large"
                                color={colors.primary}
                            />
                            <Text style={styles.stateText}>
                                Finding routes…
                            </Text>
                        </View>
                    )}

                    {!isLoadingRoutes && routeError && (
                        <View style={styles.centerState}>
                            <Ionicons
                                name="warning-outline"
                                size={36}
                                color={colors.error}
                            />
                            <Text style={styles.stateText}>
                                Could not find routes
                            </Text>
                            <Text style={styles.stateSubText}>
                                {routeError}
                            </Text>
                        </View>
                    )}

                    {!isLoadingRoutes && !routeError && routes.length === 0 && (
                        <View style={styles.centerState}>
                            <Ionicons
                                name="navigate-outline"
                                size={36}
                                color={colors.ink2}
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
                            <HorizontalView
                                style={{
                                    paddingHorizontal: spacing.screen,
                                    paddingVertical: 6,
                                    gap: spacing.element,
                                }}
                            >
                                {filterChips.map(({ key, icon, walkDist }) => {
                                    const isActive = activeFilter === key;
                                    return (
                                        <TouchableOpacity
                                            key={key}
                                            style={[
                                                styles.modeChip,
                                                isActive &&
                                                    styles.modeChipActive,
                                            ]}
                                            onPress={() =>
                                                setActiveFilter(key)
                                            }
                                            activeOpacity={0.8}
                                        >
                                            <FontAwesome5
                                                name={icon as any}
                                                size={12}
                                                color={
                                                    isActive
                                                        ? colors.selected
                                                        : colors.ink2
                                                }
                                            />
                                            <Text
                                                style={[
                                                    styles.modeChipText,
                                                    isActive &&
                                                        styles.modeChipTextActive,
                                                ]}
                                            >
                                                {key}
                                            </Text>
                                            {walkDist && (
                                                <Text
                                                    style={[
                                                        styles.modeChipDist,
                                                        isActive &&
                                                            styles.modeChipDistActive,
                                                    ]}
                                                >
                                                    {walkDist}
                                                </Text>
                                            )}
                                        </TouchableOpacity>
                                    );
                                })}
                            </HorizontalView>

                            <View style={styles.routeListWrap}>
                                {filteredRoutes.length > 0 ? (
                                    <RoutePickerSheet
                                        routes={filteredRoutes}
                                        selectedRoute={selectedRoute}
                                        fastestRoute={overallFastest}
                                        leastWalkingRoute={leastWalkingRoute}
                                        onSelectRoute={(r) =>
                                            setSelectedRoute(r)
                                        }
                                    />
                                ) : (
                                    <Text
                                        style={[
                                            styles.emptyText,
                                            { marginTop: 16 },
                                        ]}
                                    >
                                        No {activeFilter} routes available
                                    </Text>
                                )}
                            </View>
                        </>
                    )}
                </View>
            )}

            {selectedRoute && !focusedField && (
                <View style={styles.startWrap}>
                    {startError && (
                        <Text style={styles.startErrorText}>{startError}</Text>
                    )}
                    <TouchableOpacity
                        style={[
                            styles.startBtn,
                            isStarting && styles.startBtnDisabled,
                        ]}
                        onPress={handleStart}
                        disabled={isStarting}
                        activeOpacity={0.85}
                    >
                        {isStarting ? (
                            <ActivityIndicator
                                size="small"
                                color={colors.onPrimary}
                            />
                        ) : (
                            <Ionicons
                                name="navigate"
                                size={18}
                                color={colors.onPrimary}
                            />
                        )}
                        <Text style={styles.startBtnText}>
                            {isStarting ? "Starting…" : "Start Journey"}
                        </Text>
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
}


// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: AppTheme) {
    const { colors, typography, semantic, spacing, radii, shadow } = t;
    return StyleSheet.create({
        screen: { flex: 1, backgroundColor: colors.surface },
        map: { height: 220 },
        originDot: {
            width: 14,
            height: 14,
            borderRadius: 7,
            backgroundColor: colors.primary,
            borderWidth: 3,
            borderColor: colors.onPrimary,
        },

        searchPanel: {
            backgroundColor: colors.card,
            marginHorizontal: spacing.screen,
            marginTop: -20,
            borderRadius: 20,
            paddingHorizontal: spacing.card,
            paddingVertical: spacing.element + 4,
            ...shadow.card,
            shadowColor: semantic.shadow,
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.1,
            shadowRadius: 12,
            elevation: 6,
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.element,
        },
        searchRows: { flex: 1, gap: 2 },
        searchRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.element,
            paddingVertical: 6,
        },
        rowIcon: { width: 22, textAlign: "center" },
        searchInput: {
            flex: 1,
            ...typography.bodyStrong,
            color: colors.ink,
        },
        searchDivider: {
            height: 1,
            backgroundColor: colors.divider,
            marginLeft: 30,
        },
        cancelBtn: { paddingLeft: spacing.element },
        cancelText: {
            ...typography.bodyStrong,
            color: colors.primary,
        },

        findRoutesBtn: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            backgroundColor: colors.primary,
            borderRadius: 10,
            paddingVertical: 9,
            marginTop: 4,
        },
        findRoutesBtnDisabled: { backgroundColor: colors.muted },
        findRoutesBtnText: {
            ...typography.bodyStrong,
            color: colors.onPrimary,
        },
        findRoutesBtnTextDisabled: { color: colors.ink2 },

        searchResultsArea: { flex: 1, paddingTop: spacing.element },
        emptyText: {
            ...typography.body,
            color: colors.ink2,
            textAlign: "center",
            marginTop: 24,
        },

        routeArea: { flex: 1, paddingTop: spacing.element },
        centerState: {
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            gap: 10,
            paddingBottom: 40,
        },
        stateText: {
            ...typography.subtitleStrong,
            color: colors.ink,
            textAlign: "center",
        },
        stateSubText: {
            ...typography.caption,
            color: colors.ink2,
            textAlign: "center",
            maxWidth: 260,
        },

        modeChip: {
            backgroundColor: colors.surface2,
            borderRadius: 30,
            paddingHorizontal: spacing.card,
            paddingVertical: spacing.element,
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
        },
        modeChipActive: { backgroundColor: colors.secondary },
        modeChipText: {
            ...typography.bodyStrong,
            color: colors.ink,
        },
        modeChipTextActive: { color: colors.selected },
        modeChipDist: { ...typography.caption, color: colors.ink3 },
        modeChipDistActive: { color: colors.selected },

        routeListWrap: { flex: 1, paddingBottom: 80 },

        startWrap: {
            position: "absolute",
            bottom: 16,
            left: spacing.screen,
            right: spacing.screen,
            shadowColor: colors.primary,
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.3,
            shadowRadius: 12,
            elevation: 8,
        },
        startBtn: {
            backgroundColor: colors.primary,
            borderRadius: radii.button,
            paddingVertical: 16,
            flexDirection: "row",
            justifyContent: "center",
            alignItems: "center",
            gap: 10,
        },
        startBtnText: {
            ...typography.subtitleStrong,
            fontWeight: "800",
            color: colors.onPrimary,
            letterSpacing: 0.3,
        },
        startBtnDisabled: { opacity: 0.6 },
        startErrorText: {
            ...typography.captionStrong,
            color: colors.error,
            textAlign: "center",
            marginBottom: 8,
        },
    });
}
