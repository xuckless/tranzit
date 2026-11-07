import { useEffect, useMemo, useRef, useState } from "react";
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    useWindowDimensions,
    type LayoutChangeEvent,
} from "react-native";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { assignLanes } from "./layout";
import { daySegments, type Occurrence } from "./recurrence";
import {
    addDays,
    formatHourLabel,
    localDayKey,
    HOUR_HEIGHT,
    GUTTER_WIDTH,
    TOTAL_HEIGHT,
} from "./trip";

type Props = {
    /** Monday (local midnight) of the week shown. */
    weekStart: Date;
    occurrences: Occurrence[];
    selectedKey: string;
    bottomInset: number;
    onSelectEvent: (eventId: string) => void;
    /** Tapping a day header → Day view on that date. */
    onSelectDay: (day: Date) => void;
};

const BLOCK_MIN_HEIGHT = 18; // px — compact blocks, title only
const MAX_ALL_DAY = 2; // chips per column before "+N"

/** Seven narrow day columns (Mon–Sun) sharing the hour gutter. No drag. */
export function WeekView({
    weekStart,
    occurrences,
    selectedKey,
    bottomInset,
    onSelectEvent,
    onSelectDay,
}: Props) {
    const { theme } = useTheme();
    const styles = useMemo(() => makeStyles(theme), [theme]);
    const scrollRef = useRef<ScrollView>(null);
    const { width: windowWidth } = useWindowDimensions();
    const [width, setWidth] = useState(windowWidth);
    const colWidth = Math.max(0, (width - GUTTER_WIDTH) / 7);

    const todayKey = localDayKey(new Date());
    const now = useMemo(() => new Date(), []);
    const currentTimeTop =
        (now.getHours() + now.getMinutes() / 60) * HOUR_HEIGHT;

    const days = useMemo(
        () =>
            Array.from({ length: 7 }, (_, i) => {
                const date = addDays(weekStart, i);
                const key = localDayKey(date);
                const { allDay, timed } = daySegments(occurrences, key);
                const lanes = assignLanes(
                    timed.map((s) => ({
                        key: s.item.key,
                        startMin: s.startMin,
                        endMin: s.endMin,
                    })),
                    (BLOCK_MIN_HEIGHT / HOUR_HEIGHT) * 60,
                );
                return { date, key, allDay, timed, lanes };
            }),
        [weekStart, occurrences],
    );
    const hasAllDay = days.some((d) => d.allDay.length > 0);

    useEffect(() => {
        const id = setTimeout(() => {
            scrollRef.current?.scrollTo({
                y: 8 * HOUR_HEIGHT - 20,
                animated: false,
            });
        }, 0);
        return () => clearTimeout(id);
    }, []);

    const onLayout = (e: LayoutChangeEvent) =>
        setWidth(e.nativeEvent.layout.width);

    return (
        <View style={styles.root} onLayout={onLayout}>
            {/* Day headers — tap to open that day */}
            <View style={styles.headerRow}>
                <View style={{ width: GUTTER_WIDTH }} />
                {days.map((d) => {
                    const isToday = d.key === todayKey;
                    const isSelected = d.key === selectedKey;
                    return (
                        <TouchableOpacity
                            key={d.key}
                            style={[styles.dayHeader, { width: colWidth }]}
                            activeOpacity={0.7}
                            onPress={() => onSelectDay(d.date)}
                        >
                            <Text style={styles.weekday} numberOfLines={1}>
                                {d.date.toLocaleDateString(undefined, {
                                    weekday: "narrow",
                                })}
                            </Text>
                            <View
                                style={[
                                    styles.dayNum,
                                    isSelected && styles.dayNumSelected,
                                    isToday && styles.dayNumToday,
                                ]}
                            >
                                <Text
                                    style={[
                                        styles.dayNumText,
                                        isToday && styles.dayNumTextToday,
                                    ]}
                                >
                                    {d.date.getDate()}
                                </Text>
                            </View>
                        </TouchableOpacity>
                    );
                })}
            </View>

            {/* All-day row */}
            {hasAllDay && (
                <View style={styles.allDayRow}>
                    <Text style={styles.allDayLabel}>all-day</Text>
                    {days.map((d) => (
                        <View
                            key={d.key}
                            style={[styles.allDayCol, { width: colWidth }]}
                        >
                            {d.allDay.slice(0, MAX_ALL_DAY).map((seg) => (
                                <TouchableOpacity
                                    key={seg.item.key}
                                    style={styles.allDayChip}
                                    activeOpacity={0.85}
                                    onPress={() =>
                                        onSelectEvent(seg.item.eventId)
                                    }
                                >
                                    <Text
                                        style={styles.chipText}
                                        numberOfLines={1}
                                    >
                                        {seg.item.event.name}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                            {d.allDay.length > MAX_ALL_DAY && (
                                <TouchableOpacity
                                    activeOpacity={0.7}
                                    onPress={() => onSelectDay(d.date)}
                                >
                                    <Text style={styles.more}>
                                        +{d.allDay.length - MAX_ALL_DAY}
                                    </Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    ))}
                </View>
            )}

            <ScrollView
                ref={scrollRef}
                contentContainerStyle={{
                    height: TOTAL_HEIGHT,
                    paddingBottom: bottomInset,
                }}
                showsVerticalScrollIndicator={false}
            >
                <View style={styles.grid}>
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

                    {days.map((d, col) => {
                        const colLeft = GUTTER_WIDTH + col * colWidth;
                        return (
                            <View
                                key={d.key}
                                style={[
                                    styles.column,
                                    { left: colLeft, width: colWidth },
                                    d.key === todayKey && styles.columnToday,
                                ]}
                            >
                                {d.timed.map((seg) => {
                                    const a = d.lanes.get(seg.item.key) ?? {
                                        lane: 0,
                                        lanes: 1,
                                    };
                                    const laneW =
                                        (colWidth - 2) / Math.max(1, a.lanes);
                                    const top =
                                        (seg.startMin / 60) * HOUR_HEIGHT;
                                    const height = Math.min(
                                        Math.max(
                                            ((seg.endMin - seg.startMin) / 60) *
                                                HOUR_HEIGHT,
                                            BLOCK_MIN_HEIGHT,
                                        ),
                                        TOTAL_HEIGHT - top,
                                    );
                                    return (
                                        <TouchableOpacity
                                            key={seg.item.key}
                                            activeOpacity={0.85}
                                            onPress={() =>
                                                onSelectEvent(seg.item.eventId)
                                            }
                                            style={[
                                                styles.block,
                                                {
                                                    top,
                                                    height,
                                                    left: 1 + a.lane * laneW,
                                                    width: Math.max(
                                                        0,
                                                        laneW - 1,
                                                    ),
                                                },
                                                seg.continuesBefore &&
                                                    styles.contTop,
                                                seg.continuesAfter &&
                                                    styles.contBottom,
                                                seg.item.event.pending &&
                                                    styles.pending,
                                            ]}
                                        >
                                            <Text
                                                style={styles.blockText}
                                                numberOfLines={
                                                    height >= 40 ? 2 : 1
                                                }
                                            >
                                                {seg.continuesBefore
                                                    ? "↑ "
                                                    : ""}
                                                {seg.item.event.name}
                                            </Text>
                                        </TouchableOpacity>
                                    );
                                })}

                                {d.key === todayKey && (
                                    <View
                                        pointerEvents="none"
                                        style={[
                                            styles.currentLine,
                                            { top: currentTimeTop },
                                        ]}
                                    >
                                        <View style={styles.currentDot} />
                                    </View>
                                )}
                            </View>
                        );
                    })}
                </View>
            </ScrollView>
        </View>
    );
}

function makeStyles(t: AppTheme) {
    const { colors, typography, radii } = t;
    return StyleSheet.create({
        root: { flex: 1 },

        headerRow: {
            flexDirection: "row",
            paddingVertical: 6,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
            backgroundColor: colors.surface,
        },
        dayHeader: {
            alignItems: "center",
            gap: 2,
        },
        weekday: {
            ...typography.micro,
            color: colors.ink3,
        },
        dayNum: {
            width: 26,
            height: 26,
            borderRadius: 13,
            alignItems: "center",
            justifyContent: "center",
        },
        dayNumSelected: {
            borderWidth: 1.5,
            borderColor: colors.primary,
        },
        dayNumToday: {
            backgroundColor: colors.primary,
            borderColor: colors.primary,
        },
        dayNumText: {
            ...typography.captionStrong,
            color: colors.ink,
        },
        dayNumTextToday: {
            color: colors.onPrimary,
        },

        allDayRow: {
            flexDirection: "row",
            paddingVertical: 4,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
            backgroundColor: colors.surface,
        },
        allDayLabel: {
            width: GUTTER_WIDTH - 6,
            marginRight: 6,
            textAlign: "right",
            ...typography.micro,
            color: colors.ink3,
        },
        allDayCol: {
            paddingHorizontal: 1,
            gap: 2,
        },
        allDayChip: {
            borderRadius: radii.element / 2,
            backgroundColor: colors.primary + "22",
            borderLeftWidth: 2,
            borderLeftColor: colors.primary,
            paddingHorizontal: 2,
            paddingVertical: 1,
        },
        chipText: {
            ...typography.micro,
            color: colors.ink,
        },
        more: {
            ...typography.micro,
            color: colors.ink3,
            textAlign: "center",
        },

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
        column: {
            position: "absolute",
            top: 0,
            bottom: 0,
            borderLeftWidth: StyleSheet.hairlineWidth,
            borderLeftColor: colors.divider,
        },
        columnToday: {
            backgroundColor: colors.primary + "08",
        },
        block: {
            position: "absolute",
            borderRadius: radii.element / 2,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.primary + "44",
            borderLeftWidth: 2,
            borderLeftColor: colors.primary,
            backgroundColor: colors.primary + "22",
            paddingHorizontal: 2,
            paddingVertical: 1,
            overflow: "hidden",
        },
        contTop: {
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
        },
        contBottom: {
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
        },
        pending: { opacity: 0.85 },
        blockText: {
            ...typography.micro,
            color: colors.ink,
        },

        currentLine: {
            position: "absolute",
            left: 0,
            right: 0,
            height: 2,
            backgroundColor: colors.error,
        },
        currentDot: {
            position: "absolute",
            left: -4,
            top: -4,
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: colors.error,
        },
    });
}
