import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Alert,
    Linking,
    Platform,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { TripEventCard } from "@/components/planner/TripEventCard";
import { TripDetailSheet } from "@/components/planner/TripDetailSheet";
import { usePlannerEvents } from "@/hooks/usePlannerEvents";
import type { SaveEventInput } from "@/lib/plannerEvents";
import {
    eventOnDay,
    localDayKey,
    minutesOfDay,
    shiftEvent,
    formatHourLabel,
    HOUR_HEIGHT,
    GUTTER_WIDTH,
    TOTAL_HEIGHT,
} from "@/components/planner/trip";

const addDays = (d: Date, n: number): Date => {
    const next = new Date(d);
    next.setDate(next.getDate() + n);
    return next;
};

export default function PlannerScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);
    const scrollRef = useRef<ScrollView>(null);

    const { data, save, remove, importDevice, refresh } = usePlannerEvents();

    const [selectedDate, setSelectedDate] = useState(() => new Date());
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [showDatePicker, setShowDatePicker] = useState(false);

    const dayKey = localDayKey(selectedDate);
    const dayEvents = useMemo(
        () => data.filter((e) => eventOnDay(e, dayKey)),
        [data, dayKey],
    );
    const selectedEvent = useMemo(
        () => data.find((e) => e.eventId === selectedId) ?? null,
        [data, selectedId],
    );

    const isToday = dayKey === localDayKey(new Date());
    const now = useMemo(() => new Date(), []);
    const currentTimeTop =
        (now.getHours() + now.getMinutes() / 60) * HOUR_HEIGHT;
    const dateLabel = selectedDate.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
    });

    // Refresh from the mirror/user DB whenever the tab regains focus (e.g. after
    // creating an event on the Add screen).
    useFocusEffect(
        useCallback(() => {
            refresh();
        }, [refresh]),
    );

    // Open the timeline near the morning commute rather than at midnight.
    useEffect(() => {
        const id = setTimeout(() => {
            scrollRef.current?.scrollTo({
                y: 8 * HOUR_HEIGHT - 20,
                animated: false,
            });
        }, 0);
        return () => clearTimeout(id);
    }, []);

    const handleSelect = useCallback((id: string) => setSelectedId(id), []);

    const handleDrag = useCallback(
        (id: string, deltaMin: number) => {
            if (deltaMin === 0) return;
            const ev = data.find((e) => e.eventId === id);
            if (!ev) return;
            const shifted = shiftEvent(ev, deltaMin);
            if (shifted === ev) return;
            save({
                eventId: ev.eventId,
                name: ev.name,
                location: ev.location,
                locationLat: ev.locationLat,
                locationLng: ev.locationLng,
                placeId: ev.placeId,
                notes: ev.notes,
                start: shifted.start,
                end: shifted.end,
                timezone: ev.timezone,
            });
        },
        [data, save],
    );

    const handleSave = useCallback(
        (input: SaveEventInput) => {
            save(input);
        },
        [save],
    );

    const handleDelete = useCallback(
        (id: string) => {
            remove(id);
            setSelectedId(null);
        },
        [remove],
    );

    const handleImport = useCallback(async () => {
        const res = await importDevice();
        if (!res?.granted) {
            switch (res?.reason) {
                case "module-missing":
                    Alert.alert(
                        "Calendar unavailable",
                        "This build doesn't include the calendar module yet. Rebuild the app (expo prebuild + run) and try again.",
                    );
                    return;
                case "denied-forever":
                    Alert.alert(
                        "Calendar access needed",
                        "Calendar permission is turned off. Enable it in Settings to import your events.",
                        [
                            { text: "Cancel", style: "cancel" },
                            {
                                text: "Open Settings",
                                onPress: () => Linking.openSettings(),
                            },
                        ],
                    );
                    return;
                default:
                    Alert.alert(
                        "Calendar access needed",
                        "Allow calendar access to import your events.",
                    );
                    return;
            }
        }
        Alert.alert(
            "Calendar import",
            res.imported > 0
                ? `Imported ${res.imported} event${res.imported === 1 ? "" : "s"}.`
                : "No calendar events found in range.",
        );
    }, [importDevice]);

    return (
        <View style={styles.screen}>
            {/* Sub-header toolbar (sits under the global Tranzit HeaderBar) */}
            <View style={styles.toolbar}>
                <View style={styles.navGroup}>
                    <TouchableOpacity
                        style={styles.navBtn}
                        activeOpacity={0.85}
                        onPress={() => setSelectedDate((d) => addDays(d, -1))}
                    >
                        <Ionicons
                            name="chevron-back"
                            size={20}
                            color={colors.ink}
                        />
                    </TouchableOpacity>
                    <TouchableOpacity
                        activeOpacity={0.85}
                        style={styles.dateBtn}
                        onPress={() => setShowDatePicker((v) => !v)}
                    >
                        <Text style={styles.dateLabel}>
                            {isToday ? "Today · " : ""}
                            {dateLabel}
                        </Text>
                        <Ionicons
                            name="chevron-down"
                            size={14}
                            color={colors.ink2}
                        />
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.navBtn}
                        activeOpacity={0.85}
                        onPress={() => setSelectedDate((d) => addDays(d, 1))}
                    >
                        <Ionicons
                            name="chevron-forward"
                            size={20}
                            color={colors.ink}
                        />
                    </TouchableOpacity>
                </View>

                <View style={styles.actionGroup}>
                    <TouchableOpacity
                        style={styles.iconBtn}
                        activeOpacity={0.85}
                        onPress={handleImport}
                    >
                        <Ionicons
                            name="calendar-outline"
                            size={20}
                            color={colors.ink}
                        />
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.addFab}
                        activeOpacity={0.85}
                        onPress={() =>
                            router.push({
                                pathname: "/add-trip",
                                params: { date: dayKey },
                            })
                        }
                    >
                        <Ionicons name="add" size={22} color={colors.onPrimary} />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Native date picker — dialog on Android, inline calendar on iOS */}
            {showDatePicker && (
                <View style={styles.datePickerWrap}>
                    <DateTimePicker
                        value={selectedDate}
                        mode="date"
                        display={Platform.OS === "ios" ? "inline" : "default"}
                        onChange={(event, date) => {
                            setShowDatePicker(false);
                            if (event.type === "set" && date)
                                setSelectedDate(date);
                        }}
                    />
                </View>
            )}

            <ScrollView
                ref={scrollRef}
                contentContainerStyle={{
                    height: TOTAL_HEIGHT,
                    paddingBottom: insets.bottom,
                }}
                showsVerticalScrollIndicator={false}
            >
                <View style={styles.grid}>
                    {/* Hour lines + labels */}
                    {Array.from({ length: 24 }, (_, i) => (
                        <View key={i}>
                            <View
                                style={[
                                    styles.hourLine,
                                    { top: i * HOUR_HEIGHT },
                                ]}
                            />
                            {i !== 0 && (
                                <Text
                                    style={[
                                        styles.hourLabel,
                                        { top: i * HOUR_HEIGHT - 8 },
                                    ]}
                                >
                                    {formatHourLabel(i)}
                                </Text>
                            )}
                        </View>
                    ))}

                    {/* Faded travel lead-ins — the pre-routed window before each event */}
                    {dayEvents.map((event) => {
                        if (!event.travelTime) return null;
                        const startMin = minutesOfDay(event.start);
                        const top = Math.max(
                            0,
                            ((startMin - event.travelTime) / 60) * HOUR_HEIGHT,
                        );
                        const height = (startMin / 60) * HOUR_HEIGHT - top;
                        if (height <= 0) return null;
                        return (
                            <View
                                key={`${event.eventId}-lead`}
                                pointerEvents="none"
                                style={[
                                    styles.travelLeadIn,
                                    {
                                        top,
                                        height,
                                        right: theme.spacing.screen,
                                    },
                                ]}
                            >
                                {height >= 22 && (
                                    <Text
                                        style={styles.travelLeadInText}
                                        numberOfLines={1}
                                    >
                                        ⊙ {event.travelTime} min travel
                                    </Text>
                                )}
                            </View>
                        );
                    })}

                    {/* Event blocks — tap to open detail, long-press + drag to move */}
                    {dayEvents.map((event) => (
                        <TripEventCard
                            key={event.eventId}
                            event={event}
                            rightInset={theme.spacing.screen}
                            onPress={handleSelect}
                            onDrag={handleDrag}
                        />
                    ))}

                    {/* Current-time indicator (only on today) */}
                    {isToday && (
                        <View
                            style={[
                                styles.currentLine,
                                { top: currentTimeTop },
                            ]}
                            pointerEvents="none"
                        >
                            <View style={styles.currentDot} />
                        </View>
                    )}
                </View>
            </ScrollView>

            <TripDetailSheet
                event={selectedEvent}
                onClose={() => setSelectedId(null)}
                onSave={handleSave}
                onDelete={handleDelete}
            />
        </View>
    );
}

function makeStyles(t: AppTheme) {
    const { colors, typography, spacing, shadow, radii } = t;
    return StyleSheet.create({
        screen: { flex: 1, backgroundColor: colors.surface },

        // Toolbar
        toolbar: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: spacing.screen,
            paddingVertical: spacing.element + 2,
            backgroundColor: colors.surface,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
        },
        navGroup: {
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.element,
        },
        navBtn: {
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: colors.surface2,
            justifyContent: "center",
            alignItems: "center",
        },
        dateLabel: {
            ...typography.subtitleStrong,
            color: colors.ink,
            minWidth: 120,
            textAlign: "center",
        },
        actionGroup: {
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.element,
        },
        iconBtn: {
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: colors.surface2,
            justifyContent: "center",
            alignItems: "center",
        },
        addFab: {
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: colors.primary,
            justifyContent: "center",
            alignItems: "center",
            ...shadow.button,
        },

        // Grid
        grid: {
            position: "relative",
            height: TOTAL_HEIGHT,
        },
        hourLine: {
            position: "absolute",
            left: GUTTER_WIDTH,
            right: 0,
            height: StyleSheet.hairlineWidth,
            backgroundColor: colors.divider,
        },
        hourLabel: {
            position: "absolute",
            left: 0,
            width: GUTTER_WIDTH - 10,
            textAlign: "right",
            ...typography.caption,
            color: colors.ink3,
        },

        dateBtn: {
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
        },
        datePickerWrap: {
            backgroundColor: colors.surface,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
            paddingHorizontal: spacing.screen,
            alignItems: "center",
        },

        // Faded pre-routed travel window rendered above its event card
        travelLeadIn: {
            position: "absolute",
            left: GUTTER_WIDTH + 8,
            borderWidth: 1,
            borderStyle: "dashed",
            borderColor: colors.primary + "55",
            backgroundColor: colors.primary + "0D",
            borderTopLeftRadius: radii.element,
            borderTopRightRadius: radii.element,
            opacity: 0.7,
            justifyContent: "flex-start",
            paddingHorizontal: 10,
            paddingTop: 3,
        },
        travelLeadInText: {
            ...typography.caption,
            color: colors.ink3,
        },

        // Current time
        currentLine: {
            position: "absolute",
            left: GUTTER_WIDTH,
            right: 0,
            height: 2,
            backgroundColor: colors.error,
        },
        currentDot: {
            position: "absolute",
            left: -4,
            top: -4,
            width: 10,
            height: 10,
            borderRadius: 5,
            backgroundColor: colors.error,
        },
    });
}
