import {
  ActivityIndicator,
  SectionList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome5 from "@expo/vector-icons/FontAwesome5";
import { useState } from "react";
import { theme, PASTELS } from "@/styles/theme";
import { useTheme } from "@/contexts/ThemeContext";
import { useSavedPlaces } from "@/hooks/useSavedPlaces";
import type { SavedPlace } from "@/lib/db";
import { SavePlaceModal } from "@/components/SavePlaceModal";
// ─── Category → pastel + icon ─────────────────────────────────────────────────

type PastelKey = keyof typeof PASTELS;

const CATEGORY_STYLE: Record<string, { icon: string; pastel: PastelKey }> = {
  home: { icon: "home", pastel: "lavender" },
  work: { icon: "briefcase", pastel: "sky" },
  office: { icon: "briefcase", pastel: "sky" },
  school: { icon: "university", pastel: "butter" },
  university: { icon: "university", pastel: "butter" },
  gym: { icon: "dumbbell", pastel: "rose" },
  food: { icon: "utensils", pastel: "peach" },
  restaurant: { icon: "utensils", pastel: "peach" },
  health: { icon: "heartbeat", pastel: "rose" },
  hospital: { icon: "hospital", pastel: "rose" },
  shopping: { icon: "shopping-bag", pastel: "lavender" },
  park: { icon: "tree", pastel: "mint" },
};

function categoryStyle(name: string): { icon: string; pastel: PastelKey } {
  return (
    CATEGORY_STYLE[name.toLowerCase()] ?? {
      icon: "map-marker-alt",
      pastel: "sky",
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
  const { colors } = useTheme();
  const { icon, pastel } = categoryStyle(categoryName);
  const p = PASTELS[pastel];
  const displayName = place.label ?? place.address;
  const subtitle = place.label ? place.address : null;

  return (
    <TouchableOpacity
      style={styles.placeRow}
      activeOpacity={0.75}
      onPress={() => {}}
    >
      <View style={[styles.placeIconBox, { backgroundColor: p.bg }]}>
        <FontAwesome5 name={icon as any} size={15} color={p.ink} />
      </View>

      <View style={styles.placeText}>
        <Text
          style={[styles.placeName, { color: colors.ink }]}
          numberOfLines={1}
        >
          {displayName}
        </Text>
        {subtitle && (
          <Text
            style={[styles.placeAddress, { color: colors.ink3 }]}
            numberOfLines={1}
          >
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
          color={place.isDefault ? theme.colors.accent : theme.colors.ink3}
        />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name="bookmark" size={42} color={theme.colors.ink3} />
      </View>
      <Text style={styles.emptyTitle}>Nothing pinned yet</Text>
      <Text style={styles.emptySubtitle}>
        Star a stop, route, or place and it'll live here for quick access.
      </Text>
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
  const { colors } = useTheme();
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
    <View style={[styles.screen, { backgroundColor: colors.surface }]}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.googlePlaceId}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
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
              {sections.reduce((n, s) => n + s.data.length, 0)} places
            </Text>
          </View>
        }
        ListEmptyComponent={<EmptyState />}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.ink3 }]}>
              {section.title.toUpperCase()}
            </Text>
          </View>
        )}
        renderItem={({ item, section }) => (
          <View
            style={[
              styles.rowWrap,
              { backgroundColor: colors.card, borderColor: colors.divider },
            ]}
          >
            <PlaceRow
              place={item}
              categoryName={section.title}
              categoryId={section.categoryId}
              onSetDefault={markDefault}
            />
          </View>
        )}
        SectionSeparatorComponent={() => <View style={{ height: 12 }} />}
        ItemSeparatorComponent={() => (
          <View
            style={[
              styles.itemSeparator,
              { backgroundColor: colors.divider },
            ]}
          />
        )}
      />

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
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.surface },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },

  // Page header
  pageHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.screen,
    paddingTop: 12,
    paddingBottom: 16,
    backgroundColor: theme.colors.surface,
  },
  pageTitle: {
    fontSize: 30,
    fontWeight: "800",
    color: theme.colors.ink,
    letterSpacing: -0.8,
  },
  pageSubtitle: {
    fontSize: 14,
    color: theme.colors.ink2,
    marginTop: 2,
  },
  placeCount: {
    fontSize: 13,
    fontWeight: "600",
    color: theme.colors.ink3,
  },

  list: { paddingBottom: 80 },

  // Section
  sectionHeader: {
    paddingHorizontal: theme.spacing.screen,
    paddingTop: 8,
    paddingBottom: 6,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.4,
    color: theme.colors.ink3,
    textTransform: "uppercase",
  },

  // Rows
  rowWrap: {
    marginHorizontal: theme.spacing.screen,
    backgroundColor: theme.colors.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.divider,
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
    fontSize: 15.5,
    fontWeight: "700",
    color: theme.colors.ink,
    letterSpacing: -0.2,
  },
  placeAddress: {
    fontSize: 13,
    color: theme.colors.ink3,
    marginTop: 2,
  },
  itemSeparator: {
    height: 1,
    backgroundColor: theme.colors.divider,
    marginLeft: 14 + 44 + 12,
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
    backgroundColor: theme.colors.surface2,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: theme.colors.ink,
    letterSpacing: -0.3,
  },
  emptySubtitle: {
    fontSize: 14,
    color: theme.colors.ink2,
    textAlign: "center",
    lineHeight: 22,
    maxWidth: 280,
  },

  errorText: { fontSize: 14, color: theme.colors.error },

  // FAB
  fab: {
    position: "absolute",
    bottom: 28,
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: theme.colors.primary,
    justifyContent: "center",
    alignItems: "center",
    shadowColor: theme.colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
});
