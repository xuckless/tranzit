import {
  ActivityIndicator,
  SafeAreaView,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import { useState } from "react";
import { theme } from "@/styles/theme";
import { useSavedPlaces } from "@/hooks/useSavedPlaces";
import type { SavedPlace } from "@/lib/db";
import { SavePlaceModal } from "@/components/SavePlaceModal";

// ─── Category → icon/color ────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, { icon: string; color: string }> = {
  home:       { icon: "home",           color: theme.colors.primary },
  work:       { icon: "briefcase",      color: "#0070EB" },
  office:     { icon: "briefcase",      color: "#0070EB" },
  school:     { icon: "university",     color: theme.colors.selected },
  university: { icon: "university",     color: theme.colors.selected },
  gym:        { icon: "dumbbell",       color: theme.colors.tertiary },
  food:       { icon: "utensils",       color: "#E0A000" },
  restaurant: { icon: "utensils",       color: "#E0A000" },
  health:     { icon: "heartbeat",      color: "#D32F2F" },
  hospital:   { icon: "hospital",       color: "#D32F2F" },
  shopping:   { icon: "shopping-bag",   color: "#9C27B0" },
  park:       { icon: "tree",           color: "#388E3C" },
};

function categoryIcon(name: string) {
  return (
    CATEGORY_ICONS[name.toLowerCase()] ?? {
      icon: "map-marker-alt",
      color: theme.colors.text,
    }
  );
}

// ─── Place row ────────────────────────────────────────────────────────────────

function PlaceRow({
  place,
  categoryName,
  categoryId,
  onSetDefault,
}: {
  place: SavedPlace;
  categoryName: string;
  categoryId: number;
  onSetDefault: (categoryId: number, placeId: string) => void;
}) {
  const { icon, color } = categoryIcon(categoryName);
  const displayName = place.label ?? place.address;
  const subtitle = place.label ? place.address : null;

  return (
    <View style={styles.placeRow}>
      <View style={[styles.placeIconBox, { backgroundColor: color + "18" }]}>
        <FontAwesome5 name={icon as any} size={14} color={color} />
      </View>

      <View style={styles.placeText}>
        <Text style={styles.placeName} numberOfLines={1}>
          {displayName}
        </Text>
        {subtitle && (
          <Text style={styles.placeAddress} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>

      <TouchableOpacity
        onPress={() => onSetDefault(categoryId, place.googlePlaceId)}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        activeOpacity={0.7}
      >
        <Ionicons
          name={place.isDefault ? "star" : "star-outline"}
          size={20}
          color={
            place.isDefault ? theme.colors.secondary : theme.colors.border
          }
        />
      </TouchableOpacity>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

type Section = {
  title: string;
  categoryId: number;
  data: SavedPlace[];
};

export default function SavedScreen() {
  const { data, loading, error, markDefault, refresh } = useSavedPlaces();
  const [showSaveModal, setShowSaveModal] = useState(false);

  const sections: Section[] = data
    .filter((cat) => cat.places.length > 0)
    .map((cat) => ({
      title: cat.catName,
      categoryId: cat.id,
      data: cat.places,
    }));

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={theme.colors.primary} />
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
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Saved Places</Text>
      </View>

      {sections.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons
            name="bookmark-outline"
            size={48}
            color={theme.colors.border}
          />
          <Text style={styles.emptyTitle}>No saved places yet</Text>
          <Text style={styles.emptySubtitle}>
            Tap + to search for a place and save it to a category.
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.googlePlaceId}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>
                {section.title.toUpperCase()}
              </Text>
            </View>
          )}
          renderItem={({ item, section }) => (
            <PlaceRow
              place={item}
              categoryName={section.title}
              categoryId={section.categoryId}
              onSetDefault={markDefault}
            />
          )}
          SectionSeparatorComponent={() => (
            <View style={styles.sectionSeparator} />
          )}
          ItemSeparatorComponent={() => <View style={styles.itemSeparator} />}
        />
      )}

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => setShowSaveModal(true)}
        activeOpacity={0.85}
      >
        <Ionicons name="add" size={26} color="white" />
      </TouchableOpacity>

      <SavePlaceModal
        visible={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onSaved={refresh}
      />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.neutral },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },

  header: {
    paddingHorizontal: theme.spacing.screen,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: "white",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.muted,
  },
  headerTitle: {
    fontSize: theme.fontSize.title,
    fontWeight: "700",
    color: theme.colors.text,
  },

  list: { paddingBottom: 40 },

  sectionHeader: {
    paddingHorizontal: theme.spacing.screen,
    paddingTop: 20,
    paddingBottom: 6,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: theme.colors.text,
    opacity: 0.5,
  },
  sectionSeparator: { height: 8 },

  placeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "white",
    paddingHorizontal: theme.spacing.screen,
    paddingVertical: 14,
  },
  placeIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  placeText: { flex: 1 },
  placeName: {
    fontSize: theme.fontSize.body,
    fontWeight: "600",
    color: theme.colors.text,
  },
  placeAddress: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    opacity: 0.55,
    marginTop: 2,
  },
  itemSeparator: {
    height: 1,
    backgroundColor: theme.colors.muted,
    marginLeft: theme.spacing.screen + 36 + 12,
  },

  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    padding: 40,
  },
  emptyTitle: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "700",
    color: theme.colors.text,
  },
  emptySubtitle: {
    fontSize: theme.fontSize.body,
    color: theme.colors.text,
    opacity: 0.55,
    textAlign: "center",
    lineHeight: 20,
  },
  errorText: { fontSize: theme.fontSize.body, color: theme.colors.error },

  fab: {
    position: "absolute",
    bottom: 28,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.colors.primary,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
  },
});
