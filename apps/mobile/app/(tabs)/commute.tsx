import React, { useState, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  SafeAreaView,
  StatusBar,
  Animated,
  Dimensions,
} from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import { theme } from "@/styles/theme";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

// ─── Types ────────────────────────────────────────────────────────────────────

type CrowdAnswer = "packed" | "clearing" | null;

interface Stop {
  id: string;
  name: string;
  time?: string;
  eta?: string;
  status: "departed" | "current" | "upcoming" | "destination";
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const STOPS: Stop[] = [
  {
    id: "1",
    name: "Times Square - 42 St",
    time: "Departed 08:33",
    status: "departed",
  },
  {
    id: "2",
    name: "Grand Central - 42 St",
    status: "current",
  },
  {
    id: "3",
    name: "Vernon Blvd - Jackson Av",
    time: "08:41",
    eta: "3 min",
    status: "upcoming",
  },
  {
    id: "4",
    name: "Queens Plaza",
    time: "08:45",
    status: "destination",
  },
];

// Route polyline coords (NYC subway approximate)
const ROUTE_COORDS = [
  { latitude: 40.7549, longitude: -73.987 }, // Times Square
  { latitude: 40.7527, longitude: -73.9772 }, // Grand Central
  { latitude: 40.7441, longitude: -73.9526 }, // Vernon Blvd
  { latitude: 40.7488, longitude: -73.9327 }, // Queens Plaza
];

const COMPLETED_COORDS = [
  { latitude: 40.7549, longitude: -73.987 },
  { latitude: 40.7527, longitude: -73.9772 },
];

const NAV_ITEMS = [
  { label: "Map", icon: "map-outline" },
  { label: "Routes", icon: "navigate-outline" },
  { label: "Saved", icon: "bookmark-outline" },
  { label: "Report", icon: "flag-outline" },
  { label: "Commute", icon: "time-outline", active: true },
];

// ─── Stop Indicator ───────────────────────────────────────────────────────────

function StopItem({
  stop,
  index,
  total,
}: {
  stop: Stop;
  index: number;
  total: number;
}) {
  const isDeparted = stop.status === "departed";
  const isCurrent = stop.status === "current";
  const isDestination = stop.status === "destination";

  const dotBg = isCurrent
    ? "#F9F9FE"
    : isDestination
      ? theme.colors.secondary
      : isDeparted
        ? theme.colors.primary
        : "#C1C6D7";

  const dotBorder = isCurrent
    ? theme.colors.primary
    : isDestination
      ? "#F9F9FE"
      : "#F9F9FE";

  return (
    <View style={styles.stopRow}>
      {/* Dot */}
      <View style={styles.stopDotWrapper}>
        <View
          style={[
            styles.stopDot,
            {
              backgroundColor: dotBg,
              borderColor: dotBorder,
              borderWidth: 4,
            },
            isCurrent && styles.stopDotCurrentRing,
          ]}
        >
          {isDeparted && <Ionicons name="checkmark" size={10} color="white" />}
          {isDestination && (
            <Ionicons name="location" size={11} color={theme.colors.selected} />
          )}
          {isCurrent && <View style={styles.stopDotCurrentInner} />}
        </View>
      </View>

      {/* Content */}
      {isCurrent ? (
        <View style={styles.currentStopCard}>
          <Text style={styles.currentStopName}>{stop.name}</Text>
          <Text style={styles.currentStopLabel}>Current Stop</Text>
        </View>
      ) : (
        <View style={styles.stopContent}>
          <Text
            style={[styles.stopName, isDeparted && styles.stopNameDeparted]}
          >
            {stop.name}
          </Text>
          {isDeparted && <Text style={styles.stopMeta}>{stop.time}</Text>}
          {stop.status === "upcoming" && (
            <Text style={styles.stopMeta}>
              {stop.time} ({stop.eta})
            </Text>
          )}
          {isDestination && (
            <Text style={styles.stopMeta}>Destination • {stop.time}</Text>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function CommuteScreen() {
  const [crowdAnswer, setCrowdAnswer] = useState<CrowdAnswer>(null);
  const mapRef = useRef<MapView>(null);

  const PROGRESS_STEPS = 3;
  const completedSteps = 1;

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="dark-content" backgroundColor="#F9F9FE" />

      <ScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        {/* ── Live Map ── */}
        <View style={styles.mapContainer}>
          <MapView
            ref={mapRef}
            provider={PROVIDER_GOOGLE}
            style={styles.map}
            initialRegion={{
              latitude: 40.7505,
              longitude: -73.968,
              latitudeDelta: 0.04,
              longitudeDelta: 0.04,
            }}
            showsUserLocation
            showsCompass={false}
            showsMyLocationButton={false}
          >
            {/* Completed segment */}
            <Polyline
              coordinates={COMPLETED_COORDS}
              strokeColor={theme.colors.primary}
              strokeWidth={5}
            />
            {/* Remaining segment */}
            <Polyline
              coordinates={ROUTE_COORDS.slice(1)}
              strokeColor="#C1C6D7"
              strokeWidth={4}
              lineDashPattern={[8, 6]}
            />
            {/* Stop markers */}
            {ROUTE_COORDS.map((coord, i) => (
              <Marker key={i} coordinate={coord} anchor={{ x: 0.5, y: 0.5 }}>
                <View
                  style={[
                    styles.mapDot,
                    i === 0 && styles.mapDotDone,
                    i === 1 && styles.mapDotCurrent,
                    i === ROUTE_COORDS.length - 1 && styles.mapDotDest,
                  ]}
                />
              </Marker>
            ))}
          </MapView>

          {/* LIVE badge */}
          <View style={styles.liveBadge}>
            <View style={styles.liveBadgeDot} />
            <Text style={styles.liveBadgeText}>LIVE</Text>
          </View>
        </View>

        <View style={styles.content}>
          {/* ── Journey Header Card ── */}
          <View style={styles.journeyCard}>
            <View style={styles.journeyCardTop}>
              <View>
                <Text style={styles.journeyDestination}>To: Queens Plaza</Text>
                <Text style={styles.journeyEta}>Arriving in 12 min</Text>
              </View>
              <View style={styles.arrivalBadge}>
                <Text style={styles.arrivalBadgeText}>08:45</Text>
              </View>
            </View>

            {/* Progress bar */}
            <View style={styles.progressRow}>
              {Array.from({ length: PROGRESS_STEPS }).map((_, i) => (
                <View
                  key={i}
                  style={[
                    styles.progressSegment,
                    i < completedSteps && styles.progressSegmentDone,
                  ]}
                >
                  {i === 0 && <View style={styles.progressThumb} />}
                </View>
              ))}
            </View>

            {/* Segment labels */}
            <View style={styles.progressLabels}>
              <Text
                style={[styles.progressLabel, { color: theme.colors.primary }]}
              >
                Walking
              </Text>
              <Text style={styles.progressLabel}>Waiting</Text>
              <Text style={styles.progressLabel}>Riding</Text>
            </View>
          </View>

          {/* ── Better Route Alert ── */}
          <View style={styles.alertCard}>
            <View style={styles.alertCardTop}>
              <View style={styles.alertTitleRow}>
                <View style={styles.alertIconBubble}>
                  <Ionicons name="swap-horizontal" size={18} color="white" />
                </View>
                <Text style={styles.alertTitle}>
                  {"Better Route\nAvailable"}
                </Text>
              </View>
              <View style={styles.recommendedBadge}>
                <Text style={styles.recommendedText}>RECOMMENDED</Text>
              </View>
            </View>

            <Text style={styles.alertBody}>
              The 7 Train is experiencing a{" "}
              <Text style={styles.alertHighlight}>10 min delay</Text>.
            </Text>

            <View style={styles.switchRouteRow}>
              <View>
                <Text style={styles.switchRouteTitle}>
                  Switch to the E Train
                </Text>
                <View style={styles.switchRouteEta}>
                  <Ionicons
                    name="flash"
                    size={13}
                    color={theme.colors.selected}
                  />
                  <Text style={styles.switchRouteEtaText}>
                    Arrive 5 mins earlier
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.switchButton}
                activeOpacity={0.85}
              >
                <Text style={styles.switchButtonText}>{"Switch\nRoute"}</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* ── Route Progress ── */}
          <View style={styles.progressCard}>
            <View style={styles.sectionLabelRow}>
              <Ionicons
                name="navigate"
                size={15}
                color={theme.colors.primary}
              />
              <Text style={styles.sectionLabel}>ROUTE PROGRESS</Text>
            </View>

            <View style={styles.stopList}>
              {/* Vertical track */}
              <View style={styles.trackBg} />
              <View style={styles.trackDone} />

              {STOPS.map((stop, i) => (
                <StopItem
                  key={stop.id}
                  stop={stop}
                  index={i}
                  total={STOPS.length}
                />
              ))}
            </View>
          </View>

          {/* ── Boarding Instruction ── */}
          <View style={styles.boardingCard}>
            <View style={styles.boardingIcon}>
              <Ionicons name="train" size={28} color={theme.colors.primary} />
            </View>
            <View style={styles.boardingContent}>
              <Text style={styles.boardingCategory}>BOARDING INSTRUCTION</Text>
              <Text style={styles.boardingTitle}>
                {"Board the 7 Train\ntowards Flushing"}
              </Text>
              <Text style={styles.boardingTip}>
                Use the middle stairs for the fastest transfer.
              </Text>
            </View>
          </View>

          {/* ── Community Check-in ── */}
          <View style={styles.communityCard}>
            <View style={styles.communityHeader}>
              <MaterialCommunityIcons
                name="account-group"
                size={22}
                color={theme.colors.selected}
              />
              <Text style={styles.communityTitle}>Community Check-in</Text>
            </View>
            <Text style={styles.communityQuestion}>
              Is the 7 Train still{" "}
              <Text style={{ color: "#BA1A1A" }}>Very Crowded</Text>?
            </Text>

            <View style={styles.communityOptions}>
              <TouchableOpacity
                style={[
                  styles.communityOption,
                  crowdAnswer === "packed" && styles.communityOptionSelected,
                ]}
                onPress={() => setCrowdAnswer("packed")}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="people"
                  size={24}
                  color={
                    crowdAnswer === "packed" ? theme.colors.primary : "#1A1C1F"
                  }
                />
                <Text
                  style={[
                    styles.communityOptionText,
                    crowdAnswer === "packed" && { color: theme.colors.primary },
                  ]}
                >
                  Yes, Packed
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.communityOption,
                  crowdAnswer === "clearing" && styles.communityOptionSelected,
                ]}
                onPress={() => setCrowdAnswer("clearing")}
                activeOpacity={0.8}
              >
                <Ionicons
                  name="happy-outline"
                  size={24}
                  color={
                    crowdAnswer === "clearing"
                      ? theme.colors.primary
                      : "#1A1C1F"
                  }
                />
                <Text
                  style={[
                    styles.communityOptionText,
                    crowdAnswer === "clearing" && {
                      color: theme.colors.primary,
                    },
                  ]}
                >
                  No, Clearing
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.thankButton} activeOpacity={0.85}>
              <FontAwesome5
                name="thumbs-up"
                size={16}
                color={theme.colors.selected}
              />
              <Text style={styles.thankButtonText}>Thank a Driver</Text>
            </TouchableOpacity>
          </View>

          {/* ── Stats Row ── */}
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Ionicons
                name="speedometer-outline"
                size={18}
                color={theme.colors.primary}
              />
              <Text style={styles.statLabel}>Avg Speed</Text>
              <Text style={styles.statValue}>24 mph</Text>
            </View>
            <View style={styles.statCard}>
              <MaterialCommunityIcons
                name="leaf"
                size={18}
                color={theme.colors.tertiary}
              />
              <Text style={styles.statLabel}>CO₂ Saved</Text>
              <Text style={styles.statValue}>1.2 kg</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#F9F9FE",
  },
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: theme.spacing.screen,
    gap: theme.spacing.card,
    flexDirection: "column",
  },

  // ── Header ──
  header: {
    backgroundColor: "#F9F9FE",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 2,
    zIndex: 10,
  },
  headerInner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: theme.spacing.screen,
    paddingVertical: theme.spacing.element,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  logoCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#0070EB",
    justifyContent: "center",
    alignItems: "center",
  },
  logoText: {
    fontSize: 28,
    fontWeight: "800",
    color: theme.colors.primary,
    letterSpacing: -0.5,
  },

  // ── Map ──
  mapContainer: {
    height: 240,
    backgroundColor: theme.colors.muted,
    marginBottom: theme.spacing.card,
    position: "relative",
  },
  map: {
    ...StyleSheet.absoluteFillObject,
  },
  liveBadge: {
    position: "absolute",
    top: 14,
    right: 14,
    backgroundColor: "#BA1A1A",
    borderRadius: 99,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 5,
    gap: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  liveBadgeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "white",
  },
  liveBadgeText: {
    color: "white",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  mapDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#C1C6D7",
    borderWidth: 2,
    borderColor: "white",
  },
  mapDotDone: {
    backgroundColor: theme.colors.primary,
  },
  mapDotCurrent: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.colors.primary,
    borderWidth: 4,
    borderColor: "white",
  },
  mapDotDest: {
    backgroundColor: theme.colors.secondary,
  },

  // ── Journey Card ──
  journeyCard: {
    backgroundColor: "#F9F9FE",
    borderRadius: 24,
    borderLeftWidth: 6,
    borderLeftColor: theme.colors.secondary,
    padding: theme.spacing.card,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    marginTop: 4,
  },
  journeyCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 20,
  },
  journeyDestination: {
    fontSize: 22,
    fontWeight: "800",
    color: "#1A1C1F",
  },
  journeyEta: {
    fontSize: theme.fontSize.subtitle,
    fontStyle: "italic",
    color: theme.colors.text,
    marginTop: 2,
  },
  arrivalBadge: {
    backgroundColor: "#E8E8ED",
    borderRadius: 99,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  arrivalBadgeText: {
    fontSize: 20,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  progressRow: {
    flexDirection: "row",
    gap: 4,
    alignItems: "center",
    marginBottom: 8,
  },
  progressSegment: {
    flex: 1,
    height: 10,
    backgroundColor: "#C1C6D7",
    borderRadius: 99,
    position: "relative",
    justifyContent: "center",
  },
  progressSegmentDone: {
    backgroundColor: "#0070EB",
  },
  progressThumb: {
    position: "absolute",
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.colors.primary,
    borderWidth: 4,
    borderColor: "white",
    zIndex: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 3,
  },
  progressLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  progressLabel: {
    flex: 1,
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
  },

  // ── Alert Card ──
  alertCard: {
    backgroundColor: "#FFDF99",
    borderRadius: 24,
    borderLeftWidth: 6,
    borderLeftColor: "#775A00",
    padding: theme.spacing.card + 8,
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  alertCardTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  alertTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  alertIconBubble: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#775A00",
    justifyContent: "center",
    alignItems: "center",
  },
  alertTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#251A00",
    lineHeight: 24,
  },
  recommendedBadge: {
    backgroundColor: "rgba(255,255,255,0.4)",
    borderRadius: 99,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  recommendedText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#251A00",
    letterSpacing: 0.4,
  },
  alertBody: {
    fontSize: theme.fontSize.subtitle,
    color: "#251A00",
    lineHeight: 22,
  },
  alertHighlight: {
    color: "#BA1A1A",
    fontWeight: "600",
  },
  switchRouteRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.3)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
    padding: theme.spacing.card,
  },
  switchRouteTitle: {
    fontSize: theme.fontSize.subtitle,
    color: "#1A1C1F",
    lineHeight: 22,
  },
  switchRouteEta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 4,
  },
  switchRouteEtaText: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.selected,
  },
  switchButton: {
    backgroundColor: theme.colors.secondary,
    borderRadius: 99,
    paddingHorizontal: 20,
    paddingVertical: 12,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  switchButtonText: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "700",
    color: theme.colors.selected,
    textAlign: "center",
    lineHeight: 22,
  },

  // ── Route Progress Card ──
  progressCard: {
    backgroundColor: "#F3F3F8",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "#E2E2E7",
    padding: theme.spacing.card + 8,
    gap: 20,
  },
  sectionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  sectionLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  stopList: {
    position: "relative",
    gap: 24,
  },
  trackBg: {
    position: "absolute",
    left: 11,
    top: 8,
    width: 4,
    bottom: 8,
    backgroundColor: "#C1C6D7",
    borderRadius: 99,
  },
  trackDone: {
    position: "absolute",
    left: 11,
    top: 8,
    width: 4,
    height: 56, // covers first 2 stops
    backgroundColor: theme.colors.primary,
    borderRadius: 99,
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  stopDotWrapper: {
    width: 26,
    alignItems: "center",
  },
  stopDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  stopDotCurrentRing: {
    borderColor: theme.colors.primary,
    borderWidth: 4,
    backgroundColor: "#F9F9FE",
  },
  stopDotCurrentInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.primary,
  },
  stopContent: {
    flex: 1,
    gap: 2,
  },
  stopName: {
    fontSize: theme.fontSize.subtitle,
    color: "#1A1C1F",
    lineHeight: 22,
  },
  stopNameDeparted: {
    textDecorationLine: "line-through",
    opacity: 0.6,
    color: theme.colors.text,
  },
  stopMeta: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
    fontStyle: "italic",
  },
  currentStopCard: {
    flex: 1,
    backgroundColor: "rgba(0, 112, 235, 0.10)",
    borderRadius: 16,
    borderLeftWidth: 4,
    borderLeftColor: theme.colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 2,
  },
  currentStopName: {
    fontSize: theme.fontSize.subtitle,
    color: theme.colors.primary,
    lineHeight: 22,
  },
  currentStopLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.primary,
  },

  // ── Boarding Card ──
  boardingCard: {
    backgroundColor: "#0070EB",
    borderRadius: 24,
    padding: theme.spacing.card + 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    shadowColor: "#0058BC",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 6,
  },
  boardingIcon: {
    width: 64,
    height: 64,
    borderRadius: 16,
    backgroundColor: "white",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  boardingContent: {
    flex: 1,
    gap: 4,
  },
  boardingCategory: {
    fontSize: 11,
    fontWeight: "600",
    color: "rgba(254, 252, 255, 0.8)",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  boardingTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#FEFCFF",
    lineHeight: 26,
  },
  boardingTip: {
    fontSize: theme.fontSize.subtitle,
    color: "rgba(254,252,255,0.9)",
    lineHeight: 22,
    marginTop: 2,
  },

  // ── Community Card ──
  communityCard: {
    backgroundColor: "#F3F3F8",
    borderRadius: 24,
    borderWidth: 2,
    borderColor: "#C1C6D7",
    padding: theme.spacing.card + 8,
    gap: 14,
  },
  communityHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  communityTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  communityQuestion: {
    fontSize: theme.fontSize.subtitle,
    color: theme.colors.text,
    lineHeight: 24,
  },
  communityOptions: {
    flexDirection: "row",
    gap: theme.spacing.element,
  },
  communityOption: {
    flex: 1,
    backgroundColor: "#E2E2E7",
    borderRadius: 20,
    paddingVertical: 20,
    alignItems: "center",
    gap: 6,
    borderWidth: 2,
    borderColor: "transparent",
  },
  communityOptionSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: "rgba(0, 88, 188, 0.08)",
  },
  communityOptionText: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "600",
    color: "#1A1C1F",
  },
  thankButton: {
    backgroundColor: theme.colors.secondary,
    borderRadius: 99,
    paddingVertical: 18,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 3,
  },
  thankButtonText: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "700",
    color: theme.colors.selected,
  },

  // ── Stats ──
  statsRow: {
    flexDirection: "row",
    gap: theme.spacing.element,
  },
  statCard: {
    flex: 1,
    backgroundColor: theme.colors.muted,
    borderRadius: 20,
    padding: theme.spacing.card,
    gap: 4,
  },
  statLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
    marginTop: 6,
  },
  statValue: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1A1C1F",
  },

  // ── Bottom Nav ──
  bottomNav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: theme.colors.muted,
    paddingHorizontal: theme.spacing.screen,
    paddingTop: theme.spacing.element + 2,
    paddingBottom: theme.spacing.element + 2,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 12,
  },
  navItem: {
    alignItems: "center",
    paddingHorizontal: theme.spacing.element,
    paddingVertical: 6,
    borderRadius: 14,
    gap: 2,
  },
  navItemActive: {
    backgroundColor: theme.colors.secondary,
  },
  navLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
  },
  navLabelActive: {
    color: theme.colors.selected,
  },
});
