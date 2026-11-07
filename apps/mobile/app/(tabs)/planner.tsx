import { useCallback, useMemo, useState } from "react";
import {
    View,
    Text,
    StyleSheet,
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
import { TripDetailSheet } from "@/components/planner/TripDetailSheet";
import { DayTimeline } from "@/components/planner/DayTimeline";
import { WeekView } from "@/components/planner/WeekView";
import { MonthView } from "@/components/planner/MonthView";
import { usePlannerEvents } from "@/hooks/usePlannerEvents";
import type { SaveEventInput } from "@/lib/plannerEvents";
import {
    isRepeating,
    occurrencesInRange,
} from "@/components/planner/recurrence";
import {
    addDays,
    addMonths,
    dayStart,
    localDayKey,
    monthGridDays,
    shiftEvent,
    startOfWeek,
} from "@/components/planner/trip";

type PlannerView = "day" | "week" | "month";

const VIEWS: { key: PlannerView; label: string }[] = [
    { key: "day", label: "Day" },
    { key: "week", label: "Week" },
    { key: "month", label: "Month" },
];

/** The [start, end) window a view shows around the anchor date. */
function viewRange(view: PlannerView, anchor: Date): [Date, Date] {
    if (view === "day") {
        const s = dayStart(localDayKey(anchor));
        return [s, addDays(s, 1)];
    }
    if (view === "week") {
        const s = startOfWeek(anchor);
        return [s, addDays(s, 7)];
    }
    const days = monthGridDays(anchor);
    return [days[0], addDays(days[41], 1)];
}

export default function PlannerScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);

    const { data, save, remove, importDevice, refresh } = usePlannerEvents();

    const [view, setView] = useState<PlannerView>("day");
    const [selectedDate, setSelectedDate] = useState(() => new Date());
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [showDatePicker, setShowDatePicker] = useState(false);

    const dayKey = localDayKey(selectedDate);
    const todayKey = localDayKey(new Date());
    const isToday = dayKey === todayKey;

    // Repeats are expanded per visible window; multi-day items are clipped per
    // day inside the views.
    const rangeStartMs = viewRange(view, selectedDate)[0].getTime();
    const rangeEndMs = viewRange(view, selectedDate)[1].getTime();
    const occurrences = useMemo(
        () =>
            occurrencesInRange(
                data,
                new Date(rangeStartMs),
                new Date(rangeEndMs),
            ),
        [data, rangeStartMs, rangeEndMs],
    );
    const weekStart = useMemo(
        () => new Date(rangeStartMs),
        [rangeStartMs],
    );

    const selectedEvent = useMemo(
        () => data.find((e) => e.eventId === selectedId) ?? null,
        [data, selectedId],
    );

    const dateLabel = useMemo(() => {
        if (view === "month")
            return selectedDate.toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
            });
        if (view === "week") {
            const s = new Date(rangeStartMs);
            const e = addDays(s, 6);
            const fmt = (d: Date) =>
                d.toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                });
            return `${fmt(s)} – ${fmt(e)}`;
        }
        return (
            (isToday ? "Today · " : "") +
            selectedDate.toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
            })
        );
    }, [view, selectedDate, rangeStartMs, isToday]);

    const step = useCallback(
        (dir: 1 | -1) =>
            setSelectedDate((d) =>
                view === "day"
                    ? addDays(d, dir)
                    : view === "week"
                      ? addDays(d, 7 * dir)
                      : addMonths(d, dir),
            ),
        [view],
    );

    const openDay = useCallback((d: Date) => {
        setSelectedDate(d);
        setView("day");
    }, []);

    // Refresh from the mirror/user DB whenever the tab regains focus (e.g. after
    // creating an event on the Add screen).
    useFocusEffect(
        useCallback(() => {
            refresh();
        }, [refresh]),
    );

    const handleSelect = useCallback((id: string) => setSelectedId(id), []);

    const handleDrag = useCallback(
        (id: string, deltaMin: number) => {
            if (deltaMin === 0) return;
            const ev = data.find((e) => e.eventId === id);
            if (!ev || isRepeating(ev)) return; // repeats aren't draggable
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
                recurrenceRule: ev.recurrenceRule,
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
        const removed = res.removed ?? 0;
        const parts: string[] = [];
        if (res.imported > 0)
            parts.push(
                `Imported ${res.imported} event${res.imported === 1 ? "" : "s"}.`,
            );
        if (removed > 0)
            parts.push(
                `Removed ${removed} event${removed === 1 ? "" : "s"} no longer on your calendar.`,
            );
        Alert.alert(
            "Calendar import",
            parts.join(" ") || "No calendar events found in range.",
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
                        onPress={() => step(-1)}
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
                        <Text style={styles.dateLabel} numberOfLines={1}>
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
                        onPress={() => step(1)}
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

            {/* Day / Week / Month + Today */}
            <View style={styles.viewBar}>
                <View style={styles.segmented}>
                    {VIEWS.map((v) => {
                        const active = v.key === view;
                        return (
                            <TouchableOpacity
                                key={v.key}
                                style={[
                                    styles.segment,
                                    active && styles.segmentActive,
                                ]}
                                activeOpacity={0.85}
                                onPress={() => setView(v.key)}
                            >
                                <Text
                                    style={[
                                        styles.segmentText,
                                        active && styles.segmentTextActive,
                                    ]}
                                >
                                    {v.label}
                                </Text>
                            </TouchableOpacity>
                        );
                    })}
                </View>
                <TouchableOpacity
                    style={styles.todayBtn}
                    activeOpacity={0.85}
                    onPress={() => setSelectedDate(new Date())}
                >
                    <Text style={styles.todayText}>Today</Text>
                </TouchableOpacity>
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

            {view === "day" && (
                <DayTimeline
                    dayKey={dayKey}
                    occurrences={occurrences}
                    isToday={isToday}
                    bottomInset={insets.bottom}
                    onSelect={handleSelect}
                    onDrag={handleDrag}
                    onSwipe={step}
                />
            )}
            {view === "week" && (
                <WeekView
                    weekStart={weekStart}
                    occurrences={occurrences}
                    selectedKey={dayKey}
                    bottomInset={insets.bottom}
                    onSelectEvent={handleSelect}
                    onSelectDay={openDay}
                />
            )}
            {view === "month" && (
                <MonthView
                    anchor={selectedDate}
                    occurrences={occurrences}
                    selectedKey={dayKey}
                    bottomInset={insets.bottom}
                    onSelectDay={openDay}
                />
            )}

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

        // View switcher row
        viewBar: {
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.element,
            paddingHorizontal: spacing.screen,
            paddingVertical: spacing.xs + 2,
            backgroundColor: colors.surface,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
        },
        segmented: {
            flex: 1,
            flexDirection: "row",
            backgroundColor: colors.surface2,
            borderRadius: radii.pill,
            padding: 2,
        },
        segment: {
            flex: 1,
            alignItems: "center",
            paddingVertical: 6,
            borderRadius: radii.pill,
        },
        segmentActive: {
            backgroundColor: colors.card,
            ...shadow.soft,
        },
        segmentText: {
            ...typography.captionStrong,
            color: colors.ink2,
        },
        segmentTextActive: {
            color: colors.ink,
        },
        todayBtn: {
            paddingHorizontal: spacing.card,
            paddingVertical: 7,
            borderRadius: radii.pill,
            borderWidth: 1,
            borderColor: colors.primary,
        },
        todayText: {
            ...typography.captionStrong,
            color: colors.primary,
        },
    });
}
