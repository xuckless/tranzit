import {
  ActivityIndicator,
  Alert,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Swipeable } from "react-native-gesture-handler";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import { useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import { useSavedPlaces } from "@/hooks/useSavedPlaces";
import { useSearchHistory } from "@/hooks/useSearchHistory";
import type { SavedPlace } from "@/lib/savedPlaces";
import { SavePlaceModal } from "@/components/SavePlaceModal";
import { categoryStyle } from "@/styles/categoryStyle";
import type { AppTheme } from "@/styles/themes";

// ─── Place row ────────────────────────────────────────────────────────────────

function PlaceRow({
  place,
  onDelete,
  onOpen,
}: {
  place: SavedPlace;
  onDelete: (categoryCode: string, categoryName: string) => void;
  onOpen: (place: SavedPlace) => void;
}) {
  const { theme } = useTheme();
  const { colors } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { pastel } = categoryStyle(place.categoryName);
  const p = theme.colors.pastels[pastel];

  const renderRightActions = () => (
    <TouchableOpacity
      style={[styles.deleteAction, { backgroundColor: colors.danger }]}
      onPress={() => onDelete(place.categoryCode, place.categoryName)}
      activeOpacity={0.85}
    >
      <Ionicons name="trash-outline" size={20} color={colors.onPrimary} />
      <Text style={[styles.deleteActionText, { color: colors.onPrimary }]}>
        Delete
      </Text>
    </TouchableOpacity>
  );

  return (
    <Swipeable renderRightActions={renderRightActions} overshootRight={false}>
      <TouchableOpacity
        style={[styles.rowWrap, { backgroundColor: colors.card }]}
        activeOpacity={0.85}
        onPress={() => onOpen(place)}
        disabled={place.latitude == null || place.longitude == null}
      >
        <View style={styles.placeRow}>
          <View style={[styles.placeIconBox, { backgroundColor: p.bg }]}>
            <FontAwesome5
              name={place.categoryIcon as any}
              size={15}
              color={p.ink}
            />
          </View>

          <View style={styles.placeText}>
            <Text
              style={[styles.placeName, { color: colors.ink }]}
              numberOfLines={1}
            >
              {place.categoryName}
            </Text>
            <Text
              style={[styles.placeAddress, { color: colors.ink3 }]}
              numberOfLines={1}
            >
              {place.address}
            </Text>
          </View>

          {place.pending ? (
            <Ionicons
              name="cloud-offline-outline"
              size={18}
              color={colors.ink3}
            />
          ) : null}
        </View>
      </TouchableOpacity>
    </Swipeable>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  const { theme } = useTheme();
  const { colors } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="bookmark" size={42} color={colors.ink3} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.ink }]}>
        Nothing pinned yet
      </Text>
      <Text style={[styles.emptySubtitle, { color: colors.ink2 }]}>
        Star a stop, route, or place and it&apos;ll live here for quick access.
      </Text>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SavedScreen() {
  const { theme } = useTheme();
  const { colors } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { data, loading, error, refresh, remove } = useSavedPlaces();
  const { record: recordSearch } = useSearchHistory();
  const router = useRouter();
  const [showSaveModal, setShowSaveModal] = useState(false);

  const onOpen = (place: SavedPlace) => {
    if (place.latitude == null || place.longitude == null) return;
    recordSearch({
      placeId: place.googlePlaceId,
      address: place.address || place.categoryName,
      lat: place.latitude,
      lng: place.longitude,
      city: place.city,
      country: place.country,
    });
    router.navigate({
      pathname: "/(tabs)/routes",
      params: {
        destinationId: place.googlePlaceId ?? "",
        destinationLat: String(place.latitude),
        destinationLng: String(place.longitude),
        destinationName: place.categoryName,
      },
    } as never);
  };

  const onDelete = (categoryCode: string, categoryName: string) => {
    Alert.alert(
      "Remove saved place",
      `Remove “${categoryName}” from your saved places?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => remove(categoryCode),
        },
      ],
    );
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </SafeAreaView>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.surface }]}>
      <FlatList
        data={data}
        keyExtractor={(item) => item.categoryCode}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={[styles.pageHeader, { backgroundColor: colors.surface }]}>
            <View>
              <Text style={[styles.pageTitle, { color: colors.ink }]}>
                Saved Places
              </Text>
              <Text style={[styles.pageSubtitle, { color: colors.ink2 }]}>
                Tap a place to get there fast.
              </Text>
            </View>
            <Text style={[styles.placeCount, { color: colors.ink3 }]}>
              {data.length} {data.length === 1 ? "place" : "places"}
            </Text>
          </View>
        }
        ListEmptyComponent={<EmptyState />}
        renderItem={({ item }) => (
          <PlaceRow place={item} onDelete={onDelete} onOpen={onOpen} />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
      />

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setShowSaveModal(true)}
        activeOpacity={0.85}
      >
        <Ionicons name="add" size={26} color={colors.onPrimary} />
      </TouchableOpacity>

      <SavePlaceModal
        visible={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onSaved={refresh}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: AppTheme) {
  const { colors, typography, spacing, radii } = t;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface },
    center: { flex: 1, justifyContent: "center", alignItems: "center" },

    // Page header
    pageHeader: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
      paddingHorizontal: spacing.screen,
      paddingTop: 12,
      paddingBottom: 16,
      backgroundColor: colors.surface,
    },
    pageTitle: {
      ...typography.displayLg,
      color: colors.ink,
    },
    pageSubtitle: {
      ...typography.body,
      color: colors.ink2,
      marginTop: 2,
    },
    placeCount: {
      ...typography.bodySmall,
      fontWeight: "600",
      color: colors.ink3,
    },

    list: { paddingBottom: 80 },

    // Rows
    rowWrap: {
      marginHorizontal: spacing.screen,
      backgroundColor: colors.card,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.divider,
      overflow: "hidden",
    },
    placeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 14,
    },
    placeIconBox: {
      width: 44,
      height: 44,
      borderRadius: 14,
      justifyContent: "center",
      alignItems: "center",
      flexShrink: 0,
    },
    placeText: { flex: 1 },
    placeName: {
      ...typography.meta,
      color: colors.ink,
    },
    placeAddress: {
      ...typography.bodySmall,
      color: colors.ink3,
      marginTop: 2,
    },

    // Swipe-to-delete action
    deleteAction: {
      justifyContent: "center",
      alignItems: "center",
      gap: 2,
      width: 88,
      marginRight: spacing.screen,
      borderRadius: 18,
    },
    deleteActionText: {
      ...typography.caption,
      fontWeight: "700",
    },

    // Empty
    emptyState: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      gap: 10,
      padding: 40,
    },
    emptyIconWrap: {
      width: 90,
      height: 90,
      borderRadius: 30,
      backgroundColor: colors.surface2,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 8,
    },
    emptyTitle: {
      ...typography.titleLarge,
      color: colors.ink,
    },
    emptySubtitle: {
      ...typography.body,
      color: colors.ink2,
      textAlign: "center",
      lineHeight: 22,
      maxWidth: 280,
    },

    errorText: { ...typography.body, color: colors.error },

    // FAB
    fab: {
      position: "absolute",
      bottom: 28,
      right: 20,
      width: 56,
      height: 56,
      borderRadius: radii.fab,
      backgroundColor: colors.primary,
      justifyContent: "center",
      alignItems: "center",
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.35,
      shadowRadius: 16,
      elevation: 8,
    },
  });
}
