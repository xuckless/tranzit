import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { theme } from "@/styles/theme";
import { useTheme } from "@/contexts/ThemeContext";
import { TranzitApiService } from "@/services/TranzitApiService";
import type { AutocompletePrediction } from "@/types/places";
import {
  getAllCategories,
  insertCategory,
  linkPlaceToCategory,
  upsertPlace,
} from "@/lib/db";

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
  const { colors } = useTheme();

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

  // ── Form ──
  const [label, setLabel] = useState("");
  const [categories, setCategories] = useState<
    Array<{ id: number; catName: string }>
  >([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(
    null
  );
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [isDefault, setIsDefault] = useState(false);

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
    setLabel("");
    setSelectedCategoryId(null);
    setIsCreatingCategory(false);
    setNewCategoryName("");
    setIsDefault(false);
    setSaveError(null);
    getAllCategories().then(setCategories).catch(() => {});
  }, [visible, preselectedPlace]);

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

  const handleSelectCategory = useCallback((id: number) => {
    setSelectedCategoryId(id);
    setIsCreatingCategory(false);
    setNewCategoryName("");
  }, []);

  const handleNewCategoryChip = useCallback(() => {
    setSelectedCategoryId(null);
    setIsCreatingCategory(true);
  }, []);

  const canSave = (() => {
    if (!chosenPlace) return false;
    if (isCreatingCategory) return newCategoryName.trim().length > 0;
    return selectedCategoryId !== null;
  })();

  const handleSave = async () => {
    if (!canSave || !chosenPlace) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      let categoryId: number;
      let categoryName: string;

      if (isCreatingCategory) {
        categoryId = await insertCategory(newCategoryName.trim());
        categoryName = newCategoryName.trim();
      } else {
        categoryId = selectedCategoryId!;
        categoryName = categories.find((c) => c.id === categoryId)!.catName;
      }

      await upsertPlace(
        chosenPlace.googlePlaceId,
        chosenPlace.address,
        chosenPlace.latitude,
        chosenPlace.longitude
      );
      await linkPlaceToCategory(
        categoryId,
        categoryName,
        chosenPlace.googlePlaceId,
        label.trim() || null,
        isDefault
      );

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
        <View style={[styles.sheet, { backgroundColor: colors.card }]}>
          {/* Handle */}
          <View style={styles.handleRow}>
            <View style={[styles.handle, { backgroundColor: colors.divider }]} />
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
                      color={theme.colors.primary}
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
                        color="#8a8f9e"
                      />
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              {isResolvingSelection ? (
                <ActivityIndicator
                  size="small"
                  color={theme.colors.primary}
                  style={{ marginTop: 32 }}
                />
              ) : (
                <FlatList
                  data={searchResults}
                  keyExtractor={(r) => r.place_id}
                  keyboardShouldPersistTaps="handled"
                  style={styles.resultsList}
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
                          color={theme.colors.primary}
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
              <View style={styles.placeCard}>
                <View style={styles.placeIconBox}>
                  <Ionicons
                    name="location"
                    size={18}
                    color={theme.colors.primary}
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
              </View>

              {/* Label input */}
              <View style={styles.field}>
                <Text style={[styles.fieldLabel, { color: colors.ink3, opacity: 1 }]}>Label (optional)</Text>
                <TextInput
                  style={[styles.textInput, { color: colors.ink, backgroundColor: colors.surface2, borderColor: colors.border }]}
                  value={label}
                  onChangeText={setLabel}
                  placeholder="e.g. Mom's House, My Office…"
                  placeholderTextColor={colors.ink3}
                  returnKeyType="done"
                  maxLength={60}
                />
              </View>

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
                    const selected = selectedCategoryId === cat.id;
                    return (
                      <TouchableOpacity
                        key={cat.id}
                        style={[
                          styles.categoryChip,
                          selected && styles.categoryChipSelected,
                        ]}
                        onPress={() => handleSelectCategory(cat.id)}
                        activeOpacity={0.75}
                      >
                        <Text
                          style={[
                            styles.categoryChipText,
                            selected && styles.categoryChipTextSelected,
                          ]}
                        >
                          {cat.catName}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}

                  {/* + New chip */}
                  <TouchableOpacity
                    style={[
                      styles.categoryChip,
                      isCreatingCategory && styles.categoryChipSelected,
                    ]}
                    onPress={handleNewCategoryChip}
                    activeOpacity={0.75}
                  >
                    <Ionicons
                      name="add"
                      size={14}
                      color={
                        isCreatingCategory ? "white" : theme.colors.primary
                      }
                    />
                    <Text
                      style={[
                        styles.categoryChipText,
                        isCreatingCategory && styles.categoryChipTextSelected,
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

              {/* Default toggle */}
              <View style={styles.toggleRow}>
                <View style={styles.toggleText}>
                  <Text style={[styles.toggleLabel, { color: colors.ink }]}>
                    Set as default for this category
                  </Text>
                  <Text style={[styles.toggleSub, { color: colors.ink3, opacity: 1 }]}>
                    Appears in Quick Access on the Map
                  </Text>
                </View>
                <Switch
                  value={isDefault}
                  onValueChange={setIsDefault}
                  trackColor={{
                    false: theme.colors.muted,
                    true: theme.colors.primary + "88",
                  }}
                  thumbColor={isDefault ? theme.colors.primary : "#ccc"}
                />
              </View>

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
                  <ActivityIndicator size="small" color="white" />
                ) : (
                  <>
                    <Ionicons name="bookmark" size={16} color="white" />
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

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  keyboardView: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "white",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: "85%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 20,
  },
  handleRow: { alignItems: "center", paddingTop: 10, paddingBottom: 4 },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#DEDEDE",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing.screen,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.muted,
  },
  title: {
    fontSize: theme.fontSize.subtitle,
    fontWeight: "700",
    color: theme.colors.text,
    flex: 1,
    textAlign: "center",
  },

  // ── Search ──
  searchRow: {
    paddingHorizontal: theme.spacing.screen,
    paddingVertical: 12,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.colors.neutral,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 46,
    borderWidth: 1,
    borderColor: theme.colors.muted,
  },
  searchInput: {
    flex: 1,
    fontSize: theme.fontSize.body,
    color: theme.colors.text,
  },
  resultsList: { maxHeight: 320 },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: theme.spacing.screen,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.muted,
  },
  resultIconBox: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: theme.colors.primary + "12",
    justifyContent: "center",
    alignItems: "center",
  },
  resultText: { flex: 1 },
  resultName: {
    fontSize: theme.fontSize.body,
    fontWeight: "600",
    color: theme.colors.text,
  },
  resultAddress: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    opacity: 0.55,
    marginTop: 1,
  },
  emptyResults: {
    textAlign: "center",
    padding: 24,
    color: theme.colors.text,
    opacity: 0.45,
    fontSize: theme.fontSize.body,
  },

  // ── Details ──
  detailsContent: {
    paddingHorizontal: theme.spacing.screen,
    paddingBottom: 12,
    gap: 20,
  },
  placeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.colors.primary + "0D",
    borderRadius: theme.borderRadius.card,
    padding: 12,
    marginTop: 16,
  },
  placeIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: theme.colors.primary + "18",
    justifyContent: "center",
    alignItems: "center",
  },
  placeTextBlock: { flex: 1 },
  placeName: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: theme.colors.text,
  },
  placeAddress: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    opacity: 0.55,
    marginTop: 2,
  },
  field: { gap: 8 },
  fieldLabel: {
    fontSize: theme.fontSize.caption,
    fontWeight: "700",
    letterSpacing: 0.6,
    color: theme.colors.text,
    opacity: 0.5,
    textTransform: "uppercase",
  },
  textInput: {
    height: 46,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.element,
    paddingHorizontal: 14,
    fontSize: theme.fontSize.body,
    color: theme.colors.text,
    backgroundColor: theme.colors.neutral,
  },
  categoryRow: { gap: 8, paddingVertical: 2 },
  categoryChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
    borderColor: theme.colors.primary,
  },
  categoryChipSelected: {
    backgroundColor: theme.colors.primary,
  },
  categoryChipText: {
    fontSize: theme.fontSize.caption,
    fontWeight: "600",
    color: theme.colors.primary,
  },
  categoryChipTextSelected: {
    color: "white",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  toggleText: { flex: 1, marginRight: 12 },
  toggleLabel: {
    fontSize: theme.fontSize.body,
    fontWeight: "600",
    color: theme.colors.text,
  },
  toggleSub: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    opacity: 0.5,
    marginTop: 2,
  },
  saveError: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.error,
    textAlign: "center",
  },

  // ── Save button ──
  saveRow: {
    padding: theme.spacing.screen,
    paddingBottom: Platform.OS === "ios" ? 28 : theme.spacing.screen,
    borderTopWidth: 1,
    borderTopColor: theme.colors.muted,
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: theme.colors.primary,
    borderRadius: theme.borderRadius.card,
    height: 50,
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: "white",
  },
});
