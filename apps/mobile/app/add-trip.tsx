import { useCallback, useMemo, useState } from "react";
import {
    View,
    Text,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    ScrollView,
    Keyboard,
    Platform,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { useAuth } from "@/contexts/AuthContext";
import { saveEvent } from "@/lib/plannerEvents";
import { computePreRoute, persistPreRoute, takePlannedRoute } from "@/lib/preRoutes";
import { useDestinationSearch } from "@/hooks/useDestinationSearch";
import { DestinationSuggestionsList } from "@/components/search/DestinationSuggestionsList";
import { TranzitApiService } from "@/services/TranzitApiService";
import type { SearchSuggestion } from "@/types/places";
import { Stepper } from "@/components/planner/Stepper";
import {
    buildRRule,
    REPEAT_OPTIONS,
    type RepeatKind,
} from "@/components/planner/recurrence";
import {
    dayStart,
    formatClock,
    formatDuration,
    isoForDay,
    localDayKey,
    DAY_MIN,
    SNAP_MIN,
} from "@/components/planner/trip";

const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));

/** Minutes-of-day → Date (today's date, time-of-day only matters). */
const dateFromMin = (min: number): Date => {
    const d = new Date();
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    return d;
};

export default function AddTripScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);
    const { user } = useAuth();

    // The day this event lands on — passed by the planner (the viewed day). The
    // Routes screen's "Leave Later" also prefills name/location/coords here.
    const params = useLocalSearchParams<{
        date?: string;
        name?: string;
        locationLabel?: string;
        lat?: string;
        lng?: string;
        placeId?: string;
    }>();
    const dayKey =
        typeof params.date === "string" && params.date
            ? params.date
            : localDayKey(new Date());

    const [name, setName] = useState(params.name ?? "");
    const [location, setLocation] = useState(params.locationLabel ?? "");
    const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
        () => {
            const lat = parseFloat(params.lat ?? "");
            const lng = parseFloat(params.lng ?? "");
            return Number.isFinite(lat) && Number.isFinite(lng)
                ? { lat, lng }
                : null;
        },
    );
    const [placeId, setPlaceId] = useState<string | null>(
        params.placeId || null,
    );
    const [notes, setNotes] = useState("");
    const [durMin, setDurMin] = useState(60);
    const [saving, setSaving] = useState(false);
    // Repeat → stored as an RRULE in recurrence_rule (components/planner/recurrence.ts).
    const [repeat, setRepeat] = useState<RepeatKind>("never");
    const [untilKey, setUntilKey] = useState<string | null>(null);
    const [showUntilPicker, setShowUntilPicker] = useState(false);

    const [startMin, setStartMin] = useState(() => {
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        return clamp(Math.round(mins / SNAP_MIN) * SNAP_MIN, 0, DAY_MIN);
    });
    const [showStartPicker, setShowStartPicker] = useState(false);

    // Location search: picking a suggestion attaches coordinates (enables
    // pre-routing + leave-now reminders); free text stays a plain label.
    const locationSearch = useDestinationSearch(null);

    const handleLocationChange = useCallback(
        (text: string) => {
            setLocation(text);
            setCoords(null);
            setPlaceId(null);
            locationSearch.search(text);
        },
        [locationSearch],
    );

    const handleSelectLocation = useCallback(
        async (s: SearchSuggestion) => {
            Keyboard.dismiss();
            locationSearch.reset();
            setLocation(s.mainText);
            setPlaceId(s.placeId);
            if (s.location) {
                setCoords({ lat: s.location.latitude, lng: s.location.longitude });
                return;
            }
            try {
                const details = await TranzitApiService.getPlaceDetails(s.placeId);
                setCoords({
                    lat: details.location.latitude,
                    lng: details.location.longitude,
                });
            } catch (e) {
                if (__DEV__) console.warn("[add-trip] details fetch failed", e);
                // keep the label as free text — no coords, no travel features
            }
        },
        [locationSearch],
    );

    const handleCreate = async () => {
        if (saving) return;
        setSaving(true);
        try {
            if (user) {
                const start = isoForDay(dayKey, startMin);
                const end = new Date(
                    new Date(start).getTime() + durMin * 60000,
                ).toISOString();
                const saved = await saveEvent({
                    user,
                    event: {
                        name: name.trim() || "New event",
                        location: location.trim() || null,
                        locationLat: coords?.lat ?? null,
                        locationLng: coords?.lng ?? null,
                        placeId,
                        notes: notes.trim() || null,
                        start,
                        end,
                        recurrenceRule: buildRRule(repeat, untilKey),
                    },
                });
                // "Leave Later" flow: the route the user already picked becomes the
                // pre-route as-is; otherwise compute one in the background.
                const stash = takePlannedRoute();
                if (stash && coords) {
                    await persistPreRoute(user, saved, stash.itinerary).catch(
                        () => {},
                    );
                } else if (coords) {
                    void computePreRoute(user, saved, []).catch(() => {});
                }
            }
        } finally {
            router.back();
        }
    };

    return (
        <View style={styles.screen}>
            {/* Transactional header */}
            <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
                <TouchableOpacity
                    style={styles.headerSide}
                    onPress={() => router.back()}
                    hitSlop={8}
                >
                    <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <Text style={styles.headerTitle}>Add Event</Text>
                <View style={styles.headerSide} />
            </View>

            <ScrollView
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                {/* Header row — event icon + name input */}
                <View style={styles.headerRow}>
                    <View style={styles.headerIcon}>
                        <MaterialIcons
                            name="event"
                            size={20}
                            color={colors.onPrimary}
                        />
                    </View>
                    <View style={{ flex: 1 }}>
                        <TextInput
                            style={styles.titleInput}
                            value={name}
                            onChangeText={setName}
                            placeholder="Event name"
                            placeholderTextColor={colors.ink3}
                        />
                    </View>
                </View>

                {/* Location — search attaches coords; free text stays a label */}
                <View style={styles.fieldBlock}>
                    <Text style={styles.fieldLabel}>Location</Text>
                    <View style={styles.inputRow}>
                        <Ionicons
                            name={coords ? "location" : "location-outline"}
                            size={16}
                            color={coords ? colors.primary : colors.ink3}
                            style={styles.rowIcon}
                        />
                        <TextInput
                            style={styles.input}
                            value={location}
                            onChangeText={handleLocationChange}
                            placeholder="Search a place or address"
                            placeholderTextColor={colors.ink3}
                            autoCorrect={false}
                        />
                    </View>
                    {locationSearch.suggestions.length > 0 && (
                        <View style={styles.suggestions}>
                            <DestinationSuggestionsList
                                suggestions={locationSearch.suggestions}
                                onSelect={handleSelectLocation}
                            />
                        </View>
                    )}
                </View>

                {/* Start + Duration — tap the start time for the native picker */}
                <View style={styles.steppers}>
                    <Stepper
                        label="Start"
                        value={formatClock(startMin)}
                        onPressValue={() => setShowStartPicker((v) => !v)}
                        onDec={() =>
                            setStartMin((v) =>
                                clamp(v - SNAP_MIN, 0, DAY_MIN - durMin),
                            )
                        }
                        onInc={() =>
                            setStartMin((v) =>
                                clamp(v + SNAP_MIN, 0, DAY_MIN - durMin),
                            )
                        }
                    />
                    {showStartPicker && (
                        <DateTimePicker
                            value={dateFromMin(startMin)}
                            mode="time"
                            display={
                                Platform.OS === "ios" ? "spinner" : "default"
                            }
                            minuteInterval={SNAP_MIN}
                            onChange={(event, date) => {
                                if (Platform.OS === "android")
                                    setShowStartPicker(false);
                                if (event.type === "set" && date) {
                                    const mins =
                                        date.getHours() * 60 +
                                        date.getMinutes();
                                    setStartMin(
                                        clamp(mins, 0, DAY_MIN - durMin),
                                    );
                                }
                            }}
                        />
                    )}
                    <Stepper
                        label="Duration"
                        value={formatDuration(durMin)}
                        onDec={() =>
                            setDurMin((v) =>
                                clamp(v - SNAP_MIN, SNAP_MIN, DAY_MIN - startMin),
                            )
                        }
                        onInc={() =>
                            setDurMin((v) =>
                                clamp(v + SNAP_MIN, SNAP_MIN, DAY_MIN - startMin),
                            )
                        }
                    />
                </View>

                {/* Repeat — Never / Daily / Weekdays / Weekly / Monthly, optional end date */}
                <View style={styles.fieldBlock}>
                    <Text style={styles.fieldLabel}>Repeat</Text>
                    <View style={styles.chipRow}>
                        {REPEAT_OPTIONS.map((o) => {
                            const active = o.kind === repeat;
                            return (
                                <TouchableOpacity
                                    key={o.kind}
                                    style={[
                                        styles.chip,
                                        active && styles.chipActive,
                                    ]}
                                    activeOpacity={0.85}
                                    onPress={() => {
                                        setRepeat(o.kind);
                                        if (o.kind === "never") {
                                            setUntilKey(null);
                                            setShowUntilPicker(false);
                                        }
                                    }}
                                >
                                    <Text
                                        style={[
                                            styles.chipText,
                                            active && styles.chipTextActive,
                                        ]}
                                    >
                                        {o.label}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                    {repeat !== "never" && (
                        <>
                            <View style={styles.inputRow}>
                                <Ionicons
                                    name="flag-outline"
                                    size={16}
                                    color={colors.ink3}
                                    style={styles.rowIcon}
                                />
                                <TouchableOpacity
                                    style={{ flex: 1 }}
                                    onPress={() =>
                                        setShowUntilPicker((v) => !v)
                                    }
                                    activeOpacity={0.85}
                                >
                                    <Text style={styles.input}>
                                        {untilKey
                                            ? `Ends ${dayStart(
                                                  untilKey,
                                              ).toLocaleDateString(undefined, {
                                                  weekday: "short",
                                                  month: "short",
                                                  day: "numeric",
                                                  year: "numeric",
                                              })}`
                                            : "Never ends — tap to set an end date"}
                                    </Text>
                                </TouchableOpacity>
                                {!!untilKey && (
                                    <TouchableOpacity
                                        hitSlop={8}
                                        onPress={() => {
                                            setUntilKey(null);
                                            setShowUntilPicker(false);
                                        }}
                                    >
                                        <Ionicons
                                            name="close-circle"
                                            size={18}
                                            color={colors.ink3}
                                        />
                                    </TouchableOpacity>
                                )}
                            </View>
                            {showUntilPicker && (
                                <DateTimePicker
                                    value={dayStart(untilKey ?? dayKey)}
                                    mode="date"
                                    minimumDate={dayStart(dayKey)}
                                    display={
                                        Platform.OS === "ios"
                                            ? "inline"
                                            : "default"
                                    }
                                    onChange={(event, date) => {
                                        if (Platform.OS === "android")
                                            setShowUntilPicker(false);
                                        if (event.type === "set" && date)
                                            setUntilKey(localDayKey(date));
                                    }}
                                />
                            )}
                        </>
                    )}
                </View>

                {/* Notes */}
                <View style={styles.fieldBlock}>
                    <Text style={styles.fieldLabel}>Notes</Text>
                    <TextInput
                        style={[styles.input, styles.notesInput]}
                        value={notes}
                        onChangeText={setNotes}
                        placeholder="Add notes"
                        placeholderTextColor={colors.ink3}
                        multiline
                    />
                </View>
            </ScrollView>

            {/* Footer */}
            <View
                style={[
                    styles.footer,
                    { paddingBottom: insets.bottom > 0 ? insets.bottom : 16 },
                ]}
            >
                <TouchableOpacity
                    style={[styles.createBtn, saving && { opacity: 0.6 }]}
                    onPress={handleCreate}
                    disabled={saving}
                    activeOpacity={0.85}
                >
                    <Text style={styles.createBtnText}>Create Event</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
}

function makeStyles(t: AppTheme) {
    const { colors, typography, spacing, radii } = t;
    return StyleSheet.create({
        screen: { flex: 1, backgroundColor: colors.surface },

        header: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: spacing.screen,
            paddingBottom: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
            backgroundColor: colors.surface,
        },
        headerSide: { width: 64 },
        cancelText: {
            ...typography.bodyStrong,
            color: colors.primary,
        },
        headerTitle: {
            ...typography.title,
            color: colors.ink,
        },

        content: {
            padding: spacing.screen,
            gap: spacing.card,
        },

        headerRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.element + 2,
        },
        headerIcon: {
            width: 40,
            height: 40,
            borderRadius: radii.chip,
            backgroundColor: colors.primary,
            justifyContent: "center",
            alignItems: "center",
        },
        titleInput: {
            ...typography.title,
            color: colors.ink,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            paddingVertical: 2,
        },

        fieldBlock: { gap: 6 },
        fieldLabel: {
            ...typography.fieldLabel,
            color: colors.ink2,
        },
        inputRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.element,
            backgroundColor: colors.surface2,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radii.element,
            paddingHorizontal: 12,
        },
        rowIcon: { width: 20, textAlign: "center" },
        suggestions: {
            maxHeight: 280,
            backgroundColor: colors.surface2,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radii.element,
            paddingHorizontal: 8,
        },
        input: {
            flex: 1,
            ...typography.body,
            color: colors.ink,
            paddingVertical: 10,
        },
        notesInput: {
            backgroundColor: colors.surface2,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radii.element,
            paddingHorizontal: 12,
            minHeight: 72,
            textAlignVertical: "top",
        },

        chipRow: {
            flexDirection: "row",
            flexWrap: "wrap",
            gap: spacing.element,
        },
        chip: {
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: radii.pill,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface2,
        },
        chipActive: {
            borderColor: colors.primary,
            backgroundColor: colors.primary,
        },
        chipText: {
            ...typography.captionStrong,
            color: colors.ink2,
        },
        chipTextActive: {
            color: colors.onPrimary,
        },

        steppers: {
            backgroundColor: colors.surface2,
            borderRadius: radii.card,
            borderWidth: 1,
            borderColor: colors.border,
            paddingHorizontal: spacing.card,
        },

        footer: {
            paddingHorizontal: spacing.screen,
            paddingTop: 12,
            borderTopWidth: 1,
            borderTopColor: colors.divider,
            backgroundColor: colors.surface,
        },
        createBtn: {
            backgroundColor: colors.primary,
            borderRadius: radii.button,
            paddingVertical: 16,
            alignItems: "center",
            justifyContent: "center",
        },
        createBtnText: {
            ...typography.subtitleStrong,
            fontWeight: "800",
            color: colors.onPrimary,
            letterSpacing: 0.3,
        },
    });
}
