import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  ScrollView,
  Dimensions,
  PanResponder,
  Animated,
} from "react-native";
import MapView, { Marker, Region } from "react-native-maps";
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

// Sheet snap heights (distance from bottom of screen)
const SNAP_COLLAPSED = SCREEN_HEIGHT * 0.28;
const SNAP_EXPANDED = SCREEN_HEIGHT * 0.62;

const DELTA = { latitudeDelta: 0.01, longitudeDelta: 0.01 };

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
  const sheetAnim = useRef(new Animated.Value(SNAP_COLLAPSED)).current;
  const lastSnap = useRef(SNAP_COLLAPSED);
  const headingRef = useRef(0);

  const [region, setRegion] = useState<Region | null>(null);
  const [heading, setHeading] = useState(0);
  const [loadingLocation, setLoadingLocation] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [isExpanded, setIsExpanded] = useState(false);

  // ── Heading ─────────────────────────────────────────────────────────────
  const smoothHeading = (raw: number) => {
    let d = raw - headingRef.current;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    headingRef.current += d;
    setHeading(headingRef.current);
  };

  // ── Sheet snapping ───────────────────────────────────────────────────────
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

  // ── Pan responder (attached only to handle) ──────────────────────────────
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

  // ── Location ────────────────────────────────────────────────────────────
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
      const newRegion: Region = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        ...DELTA,
      };
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
          setRegion((p) => ({
            ...(p ?? DELTA),
            latitude: coords.latitude,
            longitude: coords.longitude,
          }));
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

  return (
    <View style={styles.container}>
      {/* ── Map (fills space above sheet) ── */}
      <MapView
        ref={mapRef}
        customMapStyle={mapStyle}
        style={styles.map}
        showsUserLocation={false}
        showsCompass={true}
        initialRegion={{
          latitude: 51.070664,
          longitude: -114.059263,
          ...DELTA,
        }}
      >
        {region && (
          <Marker
            coordinate={{
              latitude: region.latitude,
              longitude: region.longitude,
            }}
            anchor={{ x: 0.5, y: 0.5 }}
            flat
            tracksViewChanges={false}
          >
            <DirectionMarker heading={heading} />
          </Marker>
        )}
      </MapView>

      {/* ── Re-center (floats above sheet) ── */}
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

      {/* ── Error banner ── */}
      {errorMsg && (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={15} color="#BA1A1A" />
          <Text style={styles.errorText}>{errorMsg}</Text>
        </View>
      )}

      {/* ════════════════════════════════════════
          BOTTOM SHEET
      ════════════════════════════════════════ */}
      <Animated.View style={[styles.sheet, { height: sheetAnim }]}>
        {/* Drag handle — only this area triggers the pan */}
        <View {...panResponder.panHandlers} style={styles.handleArea}>
          <View style={styles.handle} />
          {/* Mini label that hints at drag */}
          <Text style={styles.handleHint}>
            {isExpanded ? "Nearby Stops" : "Explore"}
          </Text>
        </View>

        {/* ── Search row ── */}
        <View style={styles.searchRow}>
          <View style={styles.searchBar}>
            <Ionicons name="search" size={18} color={theme.colors.text} />
            <TextInput
              style={styles.searchInput}
              placeholder="Where do you want to go?"
              placeholderTextColor="#9EA4B0"
              value={searchQuery}
              onChangeText={setSearchQuery}
              onFocus={() => snapTo(SNAP_EXPANDED)}
              returnKeyType="search"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery("")}>
                <Ionicons
                  name="close-circle"
                  size={18}
                  color={theme.colors.text}
                />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={styles.filterBtn}
            activeOpacity={0.8}
            onPress={() => snapTo(isExpanded ? SNAP_COLLAPSED : SNAP_EXPANDED)}
          >
            <Ionicons
              name={isExpanded ? "chevron-down" : "options-outline"}
              size={20}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
        </View>

        {/* ── Quick access chips ── */}
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

        {/* ── Nearby stops (only when expanded) ── */}
        {isExpanded && (
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

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.colors.neutral },

  map: {
    ...StyleSheet.absoluteFillObject, // full screen; sheet overlays it
  },

  // ── Floating buttons ──
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

  // ── Bottom sheet ──
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

  handleArea: {
    alignItems: "center",
    paddingTop: 10,
    paddingBottom: 6,
  },
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

  // ── Search ──
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: theme.spacing.screen,
    marginBottom: 14,
  },
  searchBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.colors.muted,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  searchInput: {
    flex: 1,
    fontSize: theme.fontSize.body,
    color: "#1A1C1F",
    padding: 0,
  },
  filterBtn: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: theme.colors.muted,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },

  // ── Quick access ──
  sectionWrap: {
    paddingHorizontal: theme.spacing.screen,
    marginBottom: 4,
  },
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
});
