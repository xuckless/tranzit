import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from "react-native";
import { theme } from "@/styles/theme";
import { Ionicons } from "@expo/vector-icons";
import AntDesign from "@expo/vector-icons/AntDesign";
import HorizontalView from "@/components/horizontalView";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
// import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useState } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterMode = "All" | "Bus" | "CTrain";

interface RouteCardData {
  id: string;
  label: string;
  labelBg: string;
  labelTextColor: string;
  borderColor: string;
  isLive?: boolean;
  frequency?: string;
  duration: string;
  stops: number;
  arrival: string;
  footerNote: string;
  footerNoteBg: string;
  footerNoteColor: string;
  detailsColor: string;
  durationColor: string;
  isItalicNote?: boolean;
}

// ─── Route Data ───────────────────────────────────────────────────────────────

const ROUTES: RouteCardData[] = [
  {
    id: "m1",
    label: "M1 Blue Line",
    labelBg: theme.colors.primary,
    labelTextColor: "#FFFFFF",
    borderColor: theme.colors.primary,
    frequency: "Every 4 min",
    duration: "12 min",
    stops: 3,
    arrival: "14:42",
    footerNote: "Community reported: 2 mins ago",
    footerNoteBg: "rgba(0, 112, 235, 0.10)",
    footerNoteColor: "#004493",
    detailsColor: theme.colors.primary,
    durationColor: theme.colors.primary,
  },
  {
    id: "402",
    label: "402 Rapid",
    labelBg: theme.colors.secondary,
    labelTextColor: theme.colors.selected,
    borderColor: theme.colors.secondary,
    isLive: true,
    duration: "18 min",
    stops: 8,
    arrival: "14:48",
    footerNote: '"Standing room only, bus is running hot."',
    footerNoteBg: "rgba(254, 195, 0, 0.05)",
    footerNoteColor: theme.colors.text,
    detailsColor: "#775A00",
    durationColor: "#1A1C1F",
    isItalicNote: true,
  },
  {
    id: "lr",
    label: "LR-Green",
    labelBg: "#D8E2FF",
    labelTextColor: "#001A41",
    borderColor: theme.colors.primary,
    frequency: "Every 4 min",
    duration: "22 min",
    stops: 2,
    arrival: "15:02",
    footerNote: "Community reported: 2 mins ago",
    footerNoteBg: "rgba(0, 112, 235, 0.10)",
    footerNoteColor: "#004493",
    detailsColor: theme.colors.primary,
    durationColor: theme.colors.primary,
  },
];

const FILTERS: { mode: FilterMode; icon: string }[] = [
  { mode: "All", icon: "list" },
  { mode: "Bus", icon: "bus" },
  { mode: "CTrain", icon: "subway" },
];

// ─── Route Card ───────────────────────────────────────────────────────────────

function RouteCard({ route }: { route: RouteCardData }) {
  return (
    <View style={[styles.routeCard, { borderLeftColor: route.borderColor }]}>
      {/* Body */}
      <View style={styles.routeCardBody}>
        {/* Badge row */}
        <View style={styles.routeCardBadgeRow}>
          <View style={[styles.routeBadge, { backgroundColor: route.labelBg }]}>
            <Text
              style={[styles.routeBadgeText, { color: route.labelTextColor }]}
            >
              {route.label}
            </Text>
          </View>

          {route.isLive ? (
            <View style={styles.liveChip}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          ) : (
            <View style={styles.frequencyRow}>
              <Ionicons
                name="time-outline"
                size={14}
                color={theme.colors.text}
              />
              <Text style={styles.frequencyText}>{route.frequency}</Text>
            </View>
          )}
        </View>

        {/* Duration + arrival */}
        <View style={styles.routeCardMainRow}>
          <Text style={[styles.routeDuration, { color: route.durationColor }]}>
            {route.duration} · {route.stops} stops
          </Text>
          <View style={styles.arrivalBlock}>
            <Text style={styles.arrivalTime}>{route.arrival}</Text>
            <Text style={styles.arrivalLabel}>Arrival</Text>
          </View>
        </View>
      </View>

      {/* Footer */}
      <View
        style={[
          styles.routeCardFooter,
          { backgroundColor: route.footerNoteBg },
        ]}
      >
        <Text
          style={[
            styles.footerNote,
            { color: route.footerNoteColor },
            route.isItalicNote && { fontStyle: "italic" },
          ]}
          numberOfLines={1}
        >
          {route.footerNote}
        </Text>
        <TouchableOpacity style={styles.detailsButton} activeOpacity={0.7}>
          <Text style={[styles.detailsText, { color: route.detailsColor }]}>
            Details
          </Text>
          <Ionicons
            name="chevron-forward"
            size={14}
            color={route.detailsColor}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Walking Card ─────────────────────────────────────────────────────────────

function WalkingCard() {
  return (
    <View style={styles.walkingCard}>
      <View style={styles.walkingHeader}>
        <FontAwesome5 name="walking" size={16} color={theme.colors.tertiary} />
        <Text style={styles.walkingLabel}>Walking</Text>
      </View>
      <Text style={styles.walkingDuration}>28 min</Text>
      <Text style={styles.walkingDistance}>2.1 km path</Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function RouteScreen() {
  const [activeFilter, setActiveFilter] = useState<FilterMode>("All");

  return (
    <View style={styles.screen}>
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
        {/* Location search panel */}
        <View style={styles.locationControlPanel}>
          <View style={[styles.searchBarIndicator, styles.searchBarActive]}>
            <AntDesign name="aim" size={22} color={theme.colors.primary} />
            <Text style={styles.searchBarText}>Current Location</Text>
          </View>
          <View style={styles.searchBarIndicator}>
            <Ionicons
              name="location-outline"
              size={22}
              color={theme.colors.primary}
            />
            <Text style={styles.searchBarText}>Central Station Plaza</Text>
          </View>
        </View>

        {/* Mode filter chips */}
        <HorizontalView
          style={{
            marginLeft: theme.spacing.screen,
            gap: theme.spacing.element,
          }}
        >
          {FILTERS.map(({ mode, icon }) => {
            const isActive = activeFilter === mode;
            return (
              <TouchableOpacity
                key={mode}
                style={[
                  styles.modeFilterCard,
                  isActive && styles.modeFilterCardActive,
                ]}
                onPress={() => setActiveFilter(mode)}
                activeOpacity={0.8}
              >
                <FontAwesome5
                  name={icon as any}
                  size={14}
                  color={isActive ? theme.colors.selected : theme.colors.text}
                />
                <Text
                  style={[
                    styles.modeFilterText,
                    isActive && styles.modeFilterTextActive,
                  ]}
                >
                  {mode}
                </Text>
              </TouchableOpacity>
            );
          })}
        </HorizontalView>

        {/* Results */}
        <View style={styles.routeResultPanel}>
          <Text style={styles.title}>Recommended Routes</Text>

          {ROUTES.map((route) => (
            <RouteCard key={route.id} route={route} />
          ))}

          <WalkingCard />
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

  // ── Location panel ──
  locationControlPanel: {
    backgroundColor: theme.colors.background,
    borderRadius: 20,
    gap: theme.spacing.element,
    margin: theme.spacing.screen,
    paddingHorizontal: theme.spacing.screen,
    paddingVertical: theme.spacing.screen,
  },
  searchBarIndicator: {
    borderRadius: 50,
    backgroundColor: theme.colors.muted,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.element,
    padding: theme.spacing.element + 4,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  searchBarActive: {
    borderColor: theme.colors.primary,
    borderWidth: 2,
  },
  searchBarText: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "500",
    color: "#1A1C1F",
  },

  // ── Filter chips ──
  modeFilterCard: {
    backgroundColor: theme.colors.background,
    borderRadius: 30,
    paddingHorizontal: theme.spacing.card,
    paddingVertical: theme.spacing.card - 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  modeFilterCardActive: {
    backgroundColor: theme.colors.secondary,
  },
  modeFilterText: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: theme.colors.text,
  },
  modeFilterTextActive: {
    color: theme.colors.selected,
  },

  // ── Section ──
  routeResultPanel: {
    margin: theme.spacing.screen,
  },
  title: {
    fontSize: theme.fontSize.title,
    fontWeight: "700",
    marginBottom: theme.spacing.card,
    color: "#1A1C1F",
  },

  // ── Route card ──
  routeCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    borderLeftWidth: 6,
    marginBottom: theme.spacing.card,
    overflow: "hidden",
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 4,
  },
  routeCardBody: {
    padding: theme.spacing.card,
    gap: theme.spacing.element,
  },
  routeCardBadgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing.card,
  },
  routeBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  routeBadgeText: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
  },
  frequencyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  frequencyText: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
  },
  liveChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: theme.colors.primary,
  },
  liveText: {
    fontSize: theme.fontSize.caption,
    fontWeight: "700",
    color: theme.colors.primary,
    letterSpacing: 0.5,
  },
  routeCardMainRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  routeDuration: {
    fontSize: 22,
    fontWeight: "800",
  },
  arrivalBlock: {
    alignItems: "flex-end",
  },
  arrivalTime: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  arrivalLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
  },
  routeCardFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: theme.spacing.card,
    paddingVertical: 10,
  },
  footerNote: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    flex: 1,
    marginRight: theme.spacing.element,
  },
  detailsButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  detailsText: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
  },

  // ── Walking card ──
  walkingCard: {
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    borderTopWidth: 6,
    borderTopColor: theme.colors.tertiary,
    padding: theme.spacing.card,
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 4,
    gap: 2,
  },
  walkingHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  walkingLabel: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: theme.colors.tertiary,
  },
  walkingDuration: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  walkingDistance: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.text,
  },

  // ── Bottom nav ──
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
