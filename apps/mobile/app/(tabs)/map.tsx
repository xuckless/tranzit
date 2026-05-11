import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  Easing,
  ScrollView,
  TextInput,
  Dimensions,
  PanResponder,
} from "react-native";
import MapView, { Marker, Region } from "react-native-maps";
import mapStyle from "@/assets/map-style.json";
import { useState, useEffect, useRef } from "react";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/styles/theme";
import Svg, {
  Path,
  Circle,
  Defs,
  RadialGradient,
  Stop,
} from "react-native-svg";

const DELTA = {
  latitudeDelta: 0.01,
  longitudeDelta: 0.01,
};
const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const MIN_HEIGHT = SCREEN_HEIGHT * 0.3; // Exactly 30%
const MAX_HEIGHT = SCREEN_HEIGHT * 0.8;

// ─── Arc Direction Marker (Apple Maps style) ──────────────────────────────────
// A filled cone (±30° arc) pointing in the device heading direction,
// layered over an accuracy ring and a solid blue dot.
function DirectionMarker({ heading }: { heading: number }) {
  const SIZE = 80;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const DOT_R = 10;
  const ARC_R = 34;
  const HALF_SPAN = 30; // degrees either side of heading

  const toRad = (deg: number) => (deg * Math.PI) / 180;

  // SVG 0° = east (3 o'clock); compass 0° = north (12 o'clock) → subtract 90°
  const startAngle = toRad(heading - HALF_SPAN - 90);
  const endAngle = toRad(heading + HALF_SPAN - 90);

  const x1 = cx + ARC_R * Math.cos(startAngle);
  const y1 = cy + ARC_R * Math.sin(startAngle);
  const x2 = cx + ARC_R * Math.cos(endAngle);
  const y2 = cy + ARC_R * Math.sin(endAngle);

  // Pie-slice path: center → arc start → arc → close
  const arcPath = [
    `M ${cx} ${cy}`,
    `L ${x1.toFixed(3)} ${y1.toFixed(3)}`,
    `A ${ARC_R} ${ARC_R} 0 0 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`,
    "Z",
  ].join(" ");

  return (
    <Svg width={SIZE} height={SIZE}>
      <Defs>
        {/* Radial gradient fades the cone from opaque near center to transparent at tip */}
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

      {/* Direction cone */}
      <Path d={arcPath} fill="url(#coneGrad)" />

      {/* Soft accuracy halo */}
      <Circle cx={cx} cy={cy} r={DOT_R + 8} fill="rgba(0,88,188,0.10)" />

      {/* White border ring */}
      <Circle cx={cx} cy={cy} r={DOT_R + 1} fill="white" />

      {/* Solid blue dot */}
      <Circle cx={cx} cy={cy} r={DOT_R - 2} fill={theme.colors.primary} />
    </Svg>
  );
}

// Helper Component for Quick Actions
function QuickAction({
  icon,
  label,
  color,
}: {
  icon: any;
  label: string;
  color: string;
}) {
  return (
    <TouchableOpacity style={styles.actionItem}>
      <View style={[styles.actionIcon, { backgroundColor: color + "15" }]}>
        <Ionicons name={icon} size={22} color={color} />
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function MapScreen() {
  const mapRef = useRef<MapView>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [heading, setHeading] = useState(0);
  const [loadingLocation, setLoadingLocation] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(true);

  // Track raw heading value to compute shortest-path rotation
  const headingRef = useRef(0);

  const smoothHeading = (newRaw: number) => {
    let delta = newRaw - headingRef.current;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    headingRef.current += delta;
    setHeading(headingRef.current);
  };

  // ── Permissions ────────────────────────────────────────────────────────
  const requestLocationPermission = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      setErrorMsg("Permission to access location was denied.");
      return;
    }
    setHasPermission(true);
  };

  // ── One-shot fetch (also used by re-center button) ─────────────────────
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
      if (coords.heading != null && coords.heading >= 0) {
        smoothHeading(coords.heading);
      }

      mapRef.current?.animateToRegion(newRegion, 800);
    } catch (error) {
      console.log("Error fetching current location:", error);
      setErrorMsg("Could not get your location. Please try again.");
    } finally {
      setLoadingLocation(false);
    }
  };

  // ── Live position + heading watches ───────────────────────────────────
  useEffect(() => {
    if (!hasPermission) return;

    let posSub: Location.LocationSubscription;
    let headSub: Location.LocationSubscription;

    (async () => {
      // Position watch — updates marker coordinate every 2 m
      posSub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          distanceInterval: 2,
          timeInterval: 1000,
        },
        ({ coords }) => {
          setRegion((prev) => ({
            ...(prev ?? DELTA),
            latitude: coords.latitude,
            longitude: coords.longitude,
          }));
          if (coords.heading != null && coords.heading >= 0) {
            smoothHeading(coords.heading);
          }
        },
      );

      // Heading watch — smoother compass rotation independent of movement
      headSub = await Location.watchHeadingAsync(
        ({ trueHeading, magHeading }) => {
          const h = trueHeading >= 0 ? trueHeading : magHeading;
          smoothHeading(h);
        },
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

  // ── Animation Setup ──
  const translateY = useRef(new Animated.Value(0)).current;
  const lastOffset = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // If the user is dragging down and we are at the top, or dragging up and we are at the bottom
        // Mathematical check to see if vertical drag is intentional
        return Math.abs(gestureState.dy) > 5;
      },
      onPanResponderMove: (_, gestureState) => {
        let newTranslate = lastOffset.current + gestureState.dy;

        // Constraints
        if (newTranslate > 0) newTranslate = 0;
        if (newTranslate < -(MAX_HEIGHT - MIN_HEIGHT)) {
          newTranslate = -(MAX_HEIGHT - MIN_HEIGHT);
        }

        translateY.setValue(newTranslate);
      },
      onPanResponderRelease: (_, gestureState) => {
        const totalTravel = MAX_HEIGHT - MIN_HEIGHT;
        // Snap logic: Check velocity or distance
        const shouldExpand = gestureState.dy < -50 || gestureState.vy < -0.5;
        const shouldCollapse = gestureState.dy > 50 || gestureState.vy > 0.5;

        let finalValue = 0;
        if (shouldExpand) {
          finalValue = -totalTravel;
        } else if (shouldCollapse) {
          finalValue = 0;
        } else {
          // If neither, snap to whichever is closer
          finalValue = lastOffset.current;
        }

        Animated.spring(translateY, {
          toValue: finalValue,
          useNativeDriver: true,
          damping: 20,
          stiffness: 100,
        }).start();

        lastOffset.current = finalValue;
      },
    }),
  ).current;

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        customMapStyle={mapStyle}
        style={styles.map}
        showsUserLocation={false} // replaced by our custom marker
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
            flat // marker stays axis-aligned with the map (doesn't tilt with camera)
            tracksViewChanges={false}
          >
            <DirectionMarker heading={heading} />
          </Marker>
        )}
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

      {/* ── Bottom Dashboard Modal ── */}
      <Animated.View
        {...panResponder.panHandlers} // Attach to the whole container
        style={[
          styles.modalContent,
          { transform: [{ translateY: translateY }] },
        ]}
      >
        {/* Header/Handle Area: This is the touch target for dragging */}
        <View {...panResponder.panHandlers} style={styles.dragHandleContainer}>
          <View style={styles.modalHandle} />
        </View>
        {/*
                  PointerEvents="box-none" allows the ScrollView to be touched,
                  but the PanResponder on the parent still detects the drag.
              */}
        <View style={{ flex: 1 }} pointerEvents="box-none">
          <ScrollView
            // This is key: we disable scrolling if we're not fully expanded
            // to prevent the "scroll vs drag" conflict.
            scrollEnabled={lastOffset.current < 0}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 40 }}
          >
            {/* 1. Search Bar */}
            <View style={styles.searchContainer}>
              <Ionicons name="search" size={20} color={theme.colors.neutral} />
              <TextInput
                placeholder="Search destinations..."
                style={styles.searchInput}
                editable={true}
              />
            </View>

            {/* 2. Quick Access */}
            <View style={styles.quickAccessRow}>
              <QuickAction icon="home" label="Home" color="#4CAF50" />
              <QuickAction icon="briefcase" label="Work" color="#2196F3" />
              <QuickAction icon="star" label="Saved" color="#FFC107" />
              <QuickAction icon="time" label="Recent" color="#666" />
            </View>

            {/* 3. Content */}
            <Text style={styles.sectionHeader}>Nearby Routes</Text>
            <TouchableOpacity style={styles.recentCard}>
              <View style={styles.recentIconBox}>
                <Ionicons name="bus" size={20} color="white" />
              </View>
              <View style={styles.recentInfo}>
                <Text style={styles.recentTitle}>Blue Line - Westbound</Text>
                <Text style={styles.recentSubtitle}>
                  Every 10 mins • 200m away
                </Text>
              </View>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Animated.View>

      {/* ── Error banner ── */}
      {errorMsg && (
        <View style={styles.errorBanner}>
          <Ionicons name="warning-outline" size={15} color="#BA1A1A" />
          <Text style={styles.errorText}>{errorMsg}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.neutral,
  },
  map: {
    width: "100%",
    height: "75%",
  },

  // ── Re-center button ──
  recenterButton: {
    position: "absolute",
    bottom: 120,
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
  errorText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#BA1A1A",
  },
  // ── Modal Styles ──
  modalContent: {
    position: "absolute",
    bottom: 0,
    width: "100%",
    height: MAX_HEIGHT, // The full possible height
    backgroundColor: "white",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    // Start by showing only the bottom MIN_HEIGHT
    marginBottom: -(MAX_HEIGHT - MIN_HEIGHT),
    elevation: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
  },
  dragHandleContainer: {
    width: "100%",
    paddingVertical: 15, // Large touch area for the handle
    alignItems: "center",
  },
  modalHandle: {
    width: 40,
    height: 5,
    backgroundColor: "#E0E0E0",
    borderRadius: 3,
  },
  sectionHeader: {
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 10,
    color: "#333",
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F5F5F5",
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 45,
    marginBottom: 20,
  },
  searchInput: {
    flex: 1,
    marginLeft: 10,
    fontSize: 16,
    fontWeight: "500",
  },
  quickAccessRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  actionItem: {
    alignItems: "center",
    flex: 1,
  },
  actionIcon: {
    width: 50,
    height: 50,
    borderRadius: 25,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 4,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: "#666",
  },
  recentCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FAFAFA",
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: "#F0F0F0",
  },
  recentIconBox: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: theme.colors.primary,
    justifyContent: "center",
    alignItems: "center",
  },
  recentInfo: {
    flex: 1,
    marginLeft: 12,
  },
  recentTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#333",
  },
  recentSubtitle: {
    fontSize: 12,
    color: "#888",
    marginTop: 2,
  },
});
