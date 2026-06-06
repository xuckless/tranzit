import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Linking,
} from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import type { PlaceDetails } from "@/types/places";
import { theme } from "@/styles/theme";
import { useTheme } from "@/contexts/ThemeContext";

// ─── PlaceDetailsPanel ────────────────────────────────────────────────────────

interface PlaceDetailsPanelProps {
  place: PlaceDetails;
  isFetching: boolean;
  onClose: () => void;
  onDirections: () => void;
  onBack?: () => void;
}

export function PlaceDetailsPanel({
  place,
  isFetching,
  onClose,
  onDirections,
  onBack,
}: PlaceDetailsPanelProps) {
  const { colors } = useTheme();
  const openNow = place.regularOpeningHours?.openNow;
  const hours = place.regularOpeningHours?.weekdayDescriptions ?? [];

  // weekdayDescriptions: index 0 = Monday … 6 = Sunday
  // JS Date.getDay(): 0 = Sunday, 1 = Monday … 6 = Saturday
  const jsDay = new Date().getDay();
  const todayApiIndex = jsDay === 0 ? 6 : jsDay - 1;

  return (
    <View style={[s.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Header */}
      <View style={[s.panelHeader, { borderBottomColor: colors.border }]}>
        {onBack && (
          <TouchableOpacity
            onPress={onBack}
            style={s.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="chevron-back" size={20} color={colors.ink3} />
          </TouchableOpacity>
        )}
        <View style={s.panelHeaderLeft}>
          <View style={s.panelIconBox}>
            <Ionicons name="location" size={16} color={theme.colors.primary} />
          </View>
          <View style={s.panelTitleBlock}>
            <Text style={[s.panelTitle, { color: colors.ink }]} numberOfLines={1}>
              {place.displayName.text}
            </Text>
            {place.formattedAddress ? (
              <Text style={[s.panelSub, { color: colors.ink3 }]} numberOfLines={1}>
                {place.formattedAddress}
              </Text>
            ) : null}
          </View>
        </View>
        <TouchableOpacity
          onPress={onClose}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close-circle" size={22} color={colors.ink3} />
        </TouchableOpacity>
      </View>

      {/* Scrollable content — fixed height so ScrollView is bounded */}
      <View style={s.panelContent}>
        {isFetching ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : (
          <ScrollView
            style={s.scroll}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            {/* Open/Closed pill + rating */}
            {(openNow != null || place.rating != null) && (
              <View style={s.statusRow}>
                {openNow != null && (
                  <View style={[s.statusPill, openNow ? s.pillOpen : s.pillClosed]}>
                    <Text style={[s.statusPillText, openNow ? s.pillOpenText : s.pillClosedText]}>
                      {openNow ? "Open now" : "Closed"}
                    </Text>
                  </View>
                )}
                {place.rating != null && (
                  <View style={s.ratingRow}>
                    <Ionicons name="star" size={12} color={theme.colors.secondary} />
                    <Text style={[s.ratingText, { color: colors.ink2 }]}>
                      {place.rating.toFixed(1)}
                      {place.userRatingCount != null
                        ? `  (${place.userRatingCount.toLocaleString()})`
                        : ""}
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* Phone */}
            {place.nationalPhoneNumber ? (
              <TouchableOpacity
                style={s.infoRow}
                activeOpacity={0.7}
                onPress={() =>
                  Linking.openURL(`tel:${place.nationalPhoneNumber!.replace(/[\s()]/g, "")}`)
                }
              >
                <Ionicons name="call-outline" size={14} color={colors.ink3} />
                <Text style={[s.infoText, { color: colors.ink2 }]}>{place.nationalPhoneNumber}</Text>
              </TouchableOpacity>
            ) : null}

            {/* Website */}
            {place.websiteUri ? (
              <TouchableOpacity
                style={s.infoRow}
                activeOpacity={0.7}
                onPress={() => Linking.openURL(place.websiteUri!)}
              >
                <Ionicons name="globe-outline" size={14} color={colors.ink3} />
                <Text style={[s.infoText, { color: colors.ink2 }]} numberOfLines={1}>
                  {place.websiteUri.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </Text>
              </TouchableOpacity>
            ) : null}

            {/* Opening hours */}
            {hours.length > 0 && (
              <>
                <Text style={[s.sectionLabel, { color: colors.ink3 }]}>Hours</Text>
                {hours.map((line, i) => (
                  <View
                    key={i}
                    style={[s.hoursRow, { borderBottomColor: colors.border }, i === hours.length - 1 && s.hoursRowLast]}
                  >
                    <Text style={[s.hoursText, { color: colors.ink2 }, i === todayApiIndex && { color: colors.ink, fontWeight: "700" }]}>
                      {line}
                    </Text>
                  </View>
                ))}
              </>
            )}
          </ScrollView>
        )}
      </View>

      {/* Directions button */}
      {!isFetching && (
        <View style={[s.footer, { borderTopColor: colors.border }]}>
          <TouchableOpacity
            style={s.directionsBtn}
            activeOpacity={0.85}
            onPress={onDirections}
          >
            <Ionicons name="navigate" size={15} color="white" />
            <Text style={s.directionsBtnText}>Directions</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  panel: {
    marginHorizontal: theme.spacing.screen,
    marginBottom: 12,
    backgroundColor: "white",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  backBtn: {
    flexShrink: 0,
  },
  panelHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  panelIconBox: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: theme.colors.primary + "15",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  panelTitleBlock: { flex: 1 },
  panelTitle: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  panelSub: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    marginTop: 1,
  },

  // Fixed height matches the bus/stop panel pattern so ScrollView is bounded
  panelContent: {
    height: 200,
    paddingHorizontal: 12,
    paddingVertical: 6,
    justifyContent: "center",
  },
  scroll: { flex: 1 },

  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    marginBottom: 2,
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  pillOpen: { backgroundColor: "#D5EAE0" },
  pillClosed: { backgroundColor: "#FFEDEA" },
  statusPillText: { fontSize: 11, fontWeight: "700" },
  pillOpenText: { color: "#2A6A45" },
  pillClosedText: { color: "#BA1A1A" },

  ratingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  ratingText: {
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.accentInk,
  },

  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  infoText: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    flex: 1,
  },

  sectionLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: theme.colors.text,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 8,
    marginBottom: 2,
  },
  hoursRow: {
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  hoursRowLast: { borderBottomWidth: 0 },
  hoursText: {
    fontSize: 11,
    color: theme.colors.text,
  },
  hoursTodayText: {
    fontWeight: "700",
    color: "#1A1C1F",
  },

  footer: {
    padding: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  directionsBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: theme.colors.primary,
    paddingVertical: 10,
    borderRadius: 10,
  },
  directionsBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "white",
  },
});
