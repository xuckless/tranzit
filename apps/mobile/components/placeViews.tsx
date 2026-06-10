import { useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Linking,
} from "react-native";
import { BottomSheetScrollView as ScrollView } from "@gorhom/bottom-sheet";
import { Ionicons } from "@expo/vector-icons";
import type { PlaceDetails } from "@/types/places";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";

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
  const { theme } = useTheme();
  const { colors, typography, semantic } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const openNow = place.regularOpeningHours?.openNow;
  const hours = place.regularOpeningHours?.weekdayDescriptions ?? [];

  // weekdayDescriptions: index 0 = Monday … 6 = Sunday
  // JS Date.getDay(): 0 = Sunday, 1 = Monday … 6 = Saturday
  const jsDay = new Date().getDay();
  const todayApiIndex = jsDay === 0 ? 6 : jsDay - 1;

  return (
    <View style={[styles.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Header */}
      <View style={[styles.panelHeader, { borderBottomColor: colors.border }]}>
        {onBack && (
          <TouchableOpacity
            onPress={onBack}
            style={styles.backBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="chevron-back" size={20} color={colors.ink3} />
          </TouchableOpacity>
        )}
        <View style={styles.panelHeaderLeft}>
          <View style={styles.panelIconBox}>
            <Ionicons name="location" size={16} color={colors.primary} />
          </View>
          <View style={styles.panelTitleBlock}>
            <Text style={[styles.panelTitle, { color: colors.ink }]} numberOfLines={1}>
              {place.displayName.text}
            </Text>
            {place.formattedAddress ? (
              <Text style={[styles.panelSub, { color: colors.ink3 }]} numberOfLines={1}>
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
      <View style={styles.panelContent}>
        {isFetching ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <ScrollView
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
          >
            {/* Open/Closed pill + rating */}
            {(openNow != null || place.rating != null) && (
              <View style={styles.statusRow}>
                {openNow != null && (
                  <View
                    style={[
                      styles.statusPill,
                      { backgroundColor: openNow ? semantic.openPillBg : semantic.closedPillBg },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusPillText,
                        { color: openNow ? semantic.openPillText : semantic.closedPillText },
                      ]}
                    >
                      {openNow ? "Open now" : "Closed"}
                    </Text>
                  </View>
                )}
                {place.rating != null && (
                  <View style={styles.ratingRow}>
                    <Ionicons name="star" size={12} color={colors.secondary} />
                    <Text style={[styles.ratingText, { color: colors.ink2 }]}>
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
                style={styles.infoRow}
                activeOpacity={0.7}
                onPress={() =>
                  Linking.openURL(`tel:${place.nationalPhoneNumber!.replace(/[\s()]/g, "")}`)
                }
              >
                <Ionicons name="call-outline" size={14} color={colors.ink3} />
                <Text style={[styles.infoText, { color: colors.ink2 }]}>{place.nationalPhoneNumber}</Text>
              </TouchableOpacity>
            ) : null}

            {/* Website */}
            {place.websiteUri ? (
              <TouchableOpacity
                style={styles.infoRow}
                activeOpacity={0.7}
                onPress={() => Linking.openURL(place.websiteUri!)}
              >
                <Ionicons name="globe-outline" size={14} color={colors.ink3} />
                <Text style={[styles.infoText, { color: colors.ink2 }]} numberOfLines={1}>
                  {place.websiteUri.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                </Text>
              </TouchableOpacity>
            ) : null}

            {/* Opening hours */}
            {hours.length > 0 && (
              <>
                <Text style={[styles.sectionLabel, { color: colors.ink3 }]}>Hours</Text>
                {hours.map((line, i) => (
                  <View
                    key={i}
                    style={[styles.hoursRow, { borderBottomColor: colors.border }, i === hours.length - 1 && styles.hoursRowLast]}
                  >
                    <Text style={[styles.hoursText, { color: colors.ink2 }, i === todayApiIndex && { color: colors.ink, fontWeight: "700" }]}>
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
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <TouchableOpacity
            style={styles.directionsBtn}
            activeOpacity={0.85}
            onPress={onDirections}
          >
            <Ionicons name="navigate" size={15} color={colors.onPrimary} />
            <Text style={styles.directionsBtnText}>Directions</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: AppTheme) {
  const { colors, typography, semantic, spacing, radii } = t;
  return StyleSheet.create({
    panel: {
      marginHorizontal: spacing.screen,
      marginBottom: 12,
      backgroundColor: colors.card,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: "hidden",
    },
    panelHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      padding: 12,
      gap: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
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
      backgroundColor: colors.primaryDim,
      justifyContent: "center",
      alignItems: "center",
      flexShrink: 0,
    },
    panelTitleBlock: { flex: 1 },
    panelTitle: {
      ...typography.bodyStrong,
      color: semantic.panelTitle,
    },
    panelSub: {
      ...typography.caption,
      color: colors.ink3,
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
      borderBottomColor: colors.border,
      marginBottom: 2,
    },
    statusPill: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 6,
    },
    statusPillText: {
      ...typography.badge,
    },

    ratingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
    },
    ratingText: {
      ...typography.captionStrong,
      color: colors.accentInk,
    },

    infoRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    infoText: {
      ...typography.caption,
      color: colors.ink2,
      flex: 1,
    },

    sectionLabel: {
      ...typography.micro,
      color: colors.ink3,
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginTop: 8,
      marginBottom: 2,
    },
    hoursRow: {
      paddingVertical: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    hoursRowLast: { borderBottomWidth: 0 },
    hoursText: {
      ...typography.monoBody,
      color: colors.ink2,
    },

    footer: {
      padding: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    directionsBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      backgroundColor: colors.primary,
      paddingVertical: 10,
      borderRadius: 10,
    },
    directionsBtnText: {
      ...typography.bodySmallStrong,
      color: colors.onPrimary,
    },
  });
}
