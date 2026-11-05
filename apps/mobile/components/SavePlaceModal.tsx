import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/contexts/AuthContext";
import { useRecentSearches } from "@/hooks/useSearchHistory";
import { TranzitApiService } from "@/services/TranzitApiService";
import type { AutocompletePrediction } from "@/types/places";
import type { RecentSearch } from "@/lib/searchHistory";
import {
  fetchSavedPlaces,
  savePlace,
  type SavedPlace,
} from "@/lib/savedPlaces";
import type { AppTheme } from "@/styles/themes";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PreselectedPlace {
  googlePlaceId: string;
  displayName: string;
  address: string;
  latitude: number;
  longitude: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
  preselectedPlace?: PreselectedPlace | null;
  userLocation?: { latitude: number; longitude: number } | null;
}

interface ChosenPlace {
  googlePlaceId: string;
  displayName: string;
  address: string;
  latitude: number;
  longitude: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SavePlaceModal({
  visible,
  onClose,
  onSaved,
  preselectedPlace,
  userLocation,
}: Props) {
  const { theme } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const { recents, refresh: refreshRecents } = useRecentSearches();
  const { colors, typography, semantic, spacing, radii, shadow } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);

  // ── Phase ──
  const [phase, setPhase] = useState<"search" | "details">(
    preselectedPlace ? "details" : "search"
  );

  // ── Search ──
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<AutocompletePrediction[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isResolvingSelection, setIsResolvingSelection] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Chosen place ──
  const [chosenPlace, setChosenPlace] = useState<ChosenPlace | null>(
    preselectedPlace ?? null
  );

  // ── Form ── (one address per category, so no per-place label/default)
  const [categories, setCategories] = useState<SavedPlace[]>([]);
  const [selectedCategoryName, setSelectedCategoryName] = useState<
    string | null
  >(null);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");

  // ── Save ──
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ─── Reset on open/close ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!visible) return;
    setPhase(preselectedPlace ? "details" : "search");
    setChosenPlace(preselectedPlace ?? null);
    setSearchQuery("");
    setSearchResults([]);
    setIsResolvingSelection(false);
    setSelectionError(null);
    setSelectedCategoryName(null);
    setIsCreatingCategory(false);
    setNewCategoryName("");
    setSaveError(null);
    refreshRecents();
    if (user) fetchSavedPlaces(user).then(setCategories).catch(() => {});
  }, [visible, preselectedPlace, user, refreshRecents]);

  // ─── Search debounce ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    debounceTimer.current = setTimeout(async () => {
      searchAbort.current?.abort();
      const controller = new AbortController();
      searchAbort.current = controller;
      setIsSearching(true);
      try {
        const predictions = await TranzitApiService.getAutocompletePredictions(
          searchQuery,
          controller.signal,
        );
        setSearchResults(predictions);
      } catch {
        // AbortError is expected on fast typing
      } finally {
        setIsSearching(false);
      }
    }, 400);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [searchQuery, userLocation]);

  // ─── Handlers ────────────────────────────────────────────────────────────────

  const handleSelectResult = useCallback(async (prediction: AutocompletePrediction) => {
    setIsResolvingSelection(true);
    setSelectionError(null);
    try {
      const details = await TranzitApiService.getPlaceDetails(prediction.place_id);
      setChosenPlace({
        googlePlaceId: details.id,
        displayName: details.displayName.text,
        address: details.formattedAddress || details.displayName.text,
        latitude: details.location.latitude,
        longitude: details.location.longitude,
      });
      setSearchQuery("");
      setSearchResults([]);
      setPhase("details");
    } catch {
      setSelectionError("Could not load place details. Please try again.");
    } finally {
      setIsResolvingSelection(false);
    }
  }, []);

  // Tapping a recent skips the network — coords are already stored.
  const handleSelectRecent = useCallback((r: RecentSearch) => {
    if (r.lat == null || r.lng == null) return;
    setChosenPlace({
      googlePlaceId: r.placeId ?? "",
      displayName: r.mainText,
      address: r.address,
      latitude: r.lat,
      longitude: r.lng,
    });
    setSearchQuery("");
    setSearchResults([]);
    setPhase("details");
  }, []);

  const recentsWithCoords = useMemo(
    () => recents.filter((r) => r.lat != null && r.lng != null),
    [recents],
  );
  const showRecents =
    searchQuery.trim() === "" && recentsWithCoords.length > 0;

  const handleSelectCategory = useCallback((name: string) => {
    setSelectedCategoryName(name);
    setIsCreatingCategory(false);
    setNewCategoryName("");
  }, []);

  const handleNewCategoryChip = useCallback(() => {
    setSelectedCategoryName(null);
    setIsCreatingCategory(true);
  }, []);

  const canSave = (() => {
    if (!chosenPlace) return false;
    if (isCreatingCategory) return newCategoryName.trim().length > 0;
    return selectedCategoryName !== null;
  })();

  const handleSave = async () => {
    if (!canSave || !chosenPlace) return;
    if (!user) {
      setSaveError("You need to be signed in to save places.");
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      const categoryName = isCreatingCategory
        ? newCategoryName.trim()
        : selectedCategoryName!;

      // Best-effort: persists to the user DB and mirrors locally. A remote
      // failure keeps the place pending rather than throwing, so this resolves.
      await savePlace({
        user,
        categoryName,
        place: {
          googlePlaceId: chosenPlace.googlePlaceId,
          address: chosenPlace.address,
          latitude: chosenPlace.latitude,
          longitude: chosenPlace.longitude,
        },
      });

      onSaved();
      onClose();
    } catch {
      setSaveError("Could not save place. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      {/* Backdrop */}
      <Pressable style={styles.backdrop} onPress={onClose} />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardView}
        pointerEvents="box-none"
      >
        <View
          style={[
            styles.sheet,
            { backgroundColor: colors.card },
            phase === "search" && {
              flex: 1,
              marginTop: insets.top,
              maxHeight: "100%",
            },
          ]}
        >
          {/* Handle */}
          <View style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: semantic.handle }]} />
          </View>

          {/* Header */}
          <View style={[styles.header, { borderBottomColor: colors.divider }]}>
            {phase === "details" && !preselectedPlace && (
              <TouchableOpacity
                onPress={() => setPhase("search")}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons
                  name="arrow-back"
                  size={20}
                  color={colors.ink}
                />
              </TouchableOpacity>
            )}
            <Text style={[styles.title, { color: colors.ink }]}>Save Place</Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons
                name="close"
                size={22}
                color={colors.ink3}
              />
            </TouchableOpacity>
          </View>

          {/* ── Search phase ─────────────────────────────────────────────── */}
          {phase === "search" && (
            <>
              <View style={styles.searchRow}>
                <View style={[styles.searchBox, { backgroundColor: colors.surface2, borderColor: colors.divider }]}>
                  {isSearching ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.primary}
                    />
                  ) : (
                    <Ionicons name="search" size={18} color={colors.ink3} />
                  )}
                  <TextInput
                    style={[styles.searchInput, { color: colors.ink }]}
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    placeholder="Search for a place…"
                    placeholderTextColor={colors.ink3}
                    autoFocus
                    returnKeyType="search"
                    autoCorrect={false}
                    autoCapitalize="none"
                  />
                  {searchQuery.length > 0 && (
                    <TouchableOpacity
                      onPress={() => setSearchQuery("")}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons
                        name="close-circle"
                        size={18}
                        color={colors.ink2}
                      />
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {isResolvingSelection ? (
                <ActivityIndicator
                  size="small"
                  color={colors.primary}
                  style={{ marginTop: 32 }}
                />
              ) : showRecents ? (
                <FlatList
                  data={recentsWithCoords}
                  keyExtractor={(r) => r.placeKey}
                  keyboardShouldPersistTaps="handled"
                  style={[styles.resultsList, { flex: 1, maxHeight: "100%" }]}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={[styles.resultRow, { borderBottomColor: colors.divider }]}
                      onPress={() => handleSelectRecent(item)}
                      activeOpacity={0.75}
                    >
                      <View style={styles.resultIconBox}>
                        <Ionicons
                          name="time-outline"
                          size={16}
                          color={colors.primary}
                        />
                      </View>
                      <View style={styles.resultText}>
                        <Text style={[styles.resultName, { color: colors.ink }]} numberOfLines={1}>
                          {item.mainText}
                        </Text>
                        <Text style={[styles.resultAddress, { color: colors.ink3 }]} numberOfLines={1}>
                          {item.secondaryText ?? item.address}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )}
                />
              ) : (
                <FlatList
                  data={searchResults}
                  keyExtractor={(r) => r.place_id}
                  keyboardShouldPersistTaps="handled"
                  style={[
                    styles.resultsList,
                    phase === "search" && { flex: 1, maxHeight: "100%" },
                  ]}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      style={[styles.resultRow, { borderBottomColor: colors.divider }]}
                      onPress={() => handleSelectResult(item)}
                      activeOpacity={0.75}
                    >
                      <View style={styles.resultIconBox}>
                        <Ionicons
                          name="location-outline"
                          size={16}
                          color={colors.primary}
                        />
                      </View>
                      <View style={styles.resultText}>
                        <Text style={[styles.resultName, { color: colors.ink }]} numberOfLines={1}>
                          {item.structured_formatting.main_text}
                        </Text>
                        <Text style={[styles.resultAddress, { color: colors.ink3 }]} numberOfLines={1}>
                          {item.structured_formatting.secondary_text ?? item.description}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  )}
                  ListEmptyComponent={
                    selectionError ? (
                      <Text style={[styles.emptyResults, { color: colors.ink3 }]}>{selectionError}</Text>
                    ) : searchQuery.length > 0 && !isSearching ? (
                      <Text style={[styles.emptyResults, { color: colors.ink3 }]}>No results found.</Text>
                    ) : null
                  }
                />
              )}
            </>
          )}

          {/* ── Details phase ─────────────────────────────────────────────── */}
          {phase === "details" && chosenPlace && (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.detailsContent}
              showsVerticalScrollIndicator={false}
            >
              {/* Selected place card */}
              <Animated.View
                entering={FadeIn.duration(220)}
                style={styles.placeCard}
              >
                <View style={styles.placeIconBox}>
                  <Ionicons
                    name="location"
                    size={18}
                    color={colors.primary}
                  />
                </View>
                <View style={styles.placeTextBlock}>
                  <Text style={[styles.placeName, { color: colors.ink }]} numberOfLines={1}>
                    {chosenPlace.displayName}
                  </Text>
                  <Text style={[styles.placeAddress, { color: colors.ink3 }]} numberOfLines={1}>
                    {chosenPlace.address}
                  </Text>
                </View>
              </Animated.View>

              {/* Category picker */}
              <View style={styles.field}>
                <Text style={[styles.fieldLabel, { color: colors.ink3, opacity: 1 }]}>Category</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.categoryRow}
                  keyboardShouldPersistTaps="handled"
                >
                  {categories.map((cat) => {
                    const selected = selectedCategoryName === cat.categoryName;
                    return (
                      <TouchableOpacity
                        key={cat.categoryCode}
                        style={[
                          styles.categoryChip,
                          { borderColor: colors.primary },
                          selected && { backgroundColor: colors.primary },
                        ]}
                        onPress={() => handleSelectCategory(cat.categoryName)}
                        activeOpacity={0.75}
                      >
                        <Text
                          style={[
                            styles.categoryChipText,
                            { color: selected ? colors.onPrimary : colors.primary },
                          ]}
                        >
                          {cat.categoryName}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}

                  {/* + New chip */}
                  <TouchableOpacity
                    style={[
                      styles.categoryChip,
                      { borderColor: colors.primary },
                      isCreatingCategory && { backgroundColor: colors.primary },
                    ]}
                    onPress={handleNewCategoryChip}
                    activeOpacity={0.75}
                  >
                    <Ionicons
                      name="add"
                      size={14}
                      color={isCreatingCategory ? colors.onPrimary : colors.primary}
                    />
                    <Text
                      style={[
                        styles.categoryChipText,
                        { color: isCreatingCategory ? colors.onPrimary : colors.primary },
                      ]}
                    >
                      New
                    </Text>
                  </TouchableOpacity>
                </ScrollView>

                {/* New category name input */}
                {isCreatingCategory && (
                  <TextInput
                    style={[styles.textInput, { marginTop: 10, color: colors.ink, backgroundColor: colors.surface2, borderColor: colors.border }]}
                    value={newCategoryName}
                    onChangeText={setNewCategoryName}
                    placeholder="Category name…"
                    placeholderTextColor={colors.ink3}
                    returnKeyType="done"
                    autoFocus
                    maxLength={40}
                  />
                )}
              </View>

              {/* Overwrite hint — one address per category */}
              {selectedCategoryName !== null && !isCreatingCategory && (
                <Text style={[styles.overwriteNote, { color: colors.ink3 }]}>
                  This replaces the address saved under “{selectedCategoryName}”.
                </Text>
              )}

              {/* Error */}
              {saveError && (
                <Text style={styles.saveError}>{saveError}</Text>
              )}
            </ScrollView>
          )}

          {/* Save button — only in details phase */}
          {phase === "details" && (
            <View style={[styles.saveRow, { borderTopColor: colors.divider }]}>
              <TouchableOpacity
                style={[styles.saveBtn, !canSave && styles.saveBtnDisabled]}
                onPress={handleSave}
                disabled={!canSave || isSaving}
                activeOpacity={0.85}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color={colors.onPrimary} />
                ) : (
                  <>
                    <Ionicons name="bookmark" size={16} color={colors.onPrimary} />
                    <Text style={styles.saveBtnText}>Save Place</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: AppTheme) {
  const { colors, typography, semantic, spacing, radii, shadow } = t;
  return StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: semantic.backdrop,
    },
    keyboardView: {
      flex: 1,
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      maxHeight: "85%",
      ...shadow.floating,
      shadowColor: semantic.shadow,
    },
    handleRow: { alignItems: "center", paddingTop: 10, paddingBottom: 4 },
    handle: {
      width: 36,
      height: 4,
      borderRadius: 2,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.screen,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.muted,
    },
    title: {
      ...typography.subtitleStrong,
      flex: 1,
      textAlign: "center",
    },

    // ── Search ──
    searchRow: {
      paddingHorizontal: spacing.screen,
      paddingVertical: 12,
    },
    searchBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.element,
      borderRadius: radii.chip,
      paddingHorizontal: 12,
      height: 46,
      borderWidth: 1,
    },
    searchInput: {
      flex: 1,
      ...typography.body,
      color: colors.ink,
    },
    resultsList: { maxHeight: 320 },
    resultRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: spacing.screen,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.muted,
    },
    resultIconBox: {
      width: 32,
      height: 32,
      borderRadius: 8,
      backgroundColor: colors.primaryDim,
      justifyContent: "center",
      alignItems: "center",
    },
    resultText: { flex: 1 },
    resultName: {
      ...typography.bodyStrong,
      color: colors.ink,
    },
    resultAddress: {
      ...typography.caption,
      color: colors.ink3,
      opacity: 0.55,
      marginTop: 1,
    },
    emptyResults: {
      textAlign: "center",
      padding: 24,
      color: colors.ink3,
      opacity: 0.45,
      ...typography.body,
    },

    // ── Details ──
    detailsContent: {
      paddingHorizontal: spacing.screen,
      paddingBottom: 12,
      gap: 20,
    },
    placeCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.primaryDim,
      borderRadius: radii.card,
      padding: 12,
      marginTop: 16,
    },
    placeIconBox: {
      width: 36,
      height: 36,
      borderRadius: 10,
      backgroundColor: colors.primaryDim,
      justifyContent: "center",
      alignItems: "center",
    },
    placeTextBlock: { flex: 1 },
    placeName: {
      ...typography.bodyStrong,
      color: colors.ink,
    },
    placeAddress: {
      ...typography.caption,
      color: colors.ink3,
      opacity: 0.55,
      marginTop: 2,
    },
    field: { gap: 8 },
    fieldLabel: {
      ...typography.captionStrong,
      letterSpacing: 0.6,
      color: colors.ink3,
      opacity: 0.5,
      textTransform: "uppercase",
    },
    textInput: {
      height: 46,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radii.element,
      paddingHorizontal: 14,
      ...typography.body,
      color: colors.ink,
      backgroundColor: colors.surface2,
    },
    categoryRow: { gap: spacing.element, paddingVertical: 2 },
    categoryChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 20,
      borderWidth: 1.5,
      borderColor: colors.primary,
    },
    categoryChipText: {
      ...typography.captionStrong,
      color: colors.primary,
    },
    overwriteNote: {
      ...typography.caption,
      color: colors.ink3,
      opacity: 0.7,
    },
    saveError: {
      ...typography.caption,
      color: colors.error,
      textAlign: "center",
    },

    // ── Save button ──
    saveRow: {
      padding: spacing.screen,
      paddingBottom: Platform.OS === "ios" ? 28 : spacing.screen,
      borderTopWidth: 1,
      borderTopColor: colors.muted,
    },
    saveBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.element,
      backgroundColor: colors.primary,
      borderRadius: radii.card,
      height: 50,
    },
    saveBtnDisabled: { opacity: 0.4 },
    saveBtnText: {
      ...typography.bodyStrong,
      color: colors.onPrimary,
    },
  });
}
