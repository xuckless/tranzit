import { useEffect, useMemo, useRef } from "react";
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { TripEventCard } from "./TripEventCard";
import { assignLanes } from "./layout";
import { daySegments, isRepeating, type Occurrence } from "./recurrence";
import {
    formatHourLabel,
    HOUR_HEIGHT,
    GUTTER_WIDTH,
    TOTAL_HEIGHT,
    EVENT_MIN_HEIGHT,
} from "./trip";

type Props = {
    dayKey: string;
    /** Occurrences around this day (anything not touching it is ignored). */
    occurrences: Occurrence[];
    isToday: boolean;
    bottomInset: number;
    onSelect: (eventId: string) => void;
    onDrag: (eventId: string, deltaMin: number) => void;
    /** Horizontal swipe: +1 = next day, −1 = previous day. */
    onSwipe?: (dir: 1 | -1) => void;
};

const LANE_GAP = 2;
const SWIPE_DIST = 60;

/**
 * Single-day 24h timeline: all-day strip, hour grid, travel lead-ins, event cards
 * (overlaps side by side, long-press drag), current-time line on today.
 */
export function DayTimeline({
    dayKey,
    occurrences,
    isToday,
    bottomInset,
    onSelect,
    onDrag,
    onSwipe,
}: Props) {
    const { theme } = useTheme();
    const styles = useMemo(() => makeStyles(theme), [theme]);
    const scrollRef = useRef<ScrollView>(null);
    const { width: windowWidth } = useWindowDimensions();

    const { allDay, timed } = useMemo(
        () => daySegments(occurrences, dayKey),
        [occurrences, dayKey],
    );

    // Lane geometry: cards share the area right of the gutter.
    const areaLeft = GUTTER_WIDTH + 8;
    const areaWidth = Math.max(
        0,
        windowWidth - areaLeft - theme.spacing.screen,
    );
    const lanes = useMemo(
        () =>
            assignLanes(
                timed.map((s) => ({
                    key: s.item.key,
                    startMin: s.startMin,
                    endMin: s.endMin,
                })),
                (EVENT_MIN_HEIGHT / HOUR_HEIGHT) * 60,
            ),
        [timed],
    );
    const laneBox = (key: string) => {
        const a = lanes.get(key) ?? { lane: 0, lanes: 1 };
        const w = areaWidth / Math.max(1, a.lanes);
        return {
            left: areaLeft + a.lane * w,
            width: Math.max(0, w - (a.lanes > 1 ? LANE_GAP : 0)),
        };
    };

    const now = useMemo(() => new Date(), []);
    const currentTimeTop =
        (now.getHours() + now.getMinutes() / 60) * HOUR_HEIGHT;

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

    // Left/right swipe changes the day. Fails as soon as the finger moves
    // vertically (so the ScrollView keeps scrolling) and only one gesture can be
    // active at a time, so a card's long-press drag wins once it has activated.
    const swipe = useMemo(
        () =>
            Gesture.Pan()
                .enabled(!!onSwipe)
                .runOnJS(true)
                .activeOffsetX([-30, 30])
                .failOffsetY([-15, 15])
                .onEnd((e) => {
                    if (Math.abs(e.translationX) < SWIPE_DIST) return;
                    onSwipe?.(e.translationX < 0 ? 1 : -1);
                }),
        [onSwipe],
    );

    return (
        <View style={styles.root}>
            {/* All-day plaques — pinned above the timeline, scroll sideways on overflow */}
            {allDay.length > 0 && (
                <View style={styles.allDayStrip}>
                    <Text style={styles.allDayGutterLabel}>all-day</Text>
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={styles.allDayScroll}
                        contentContainerStyle={styles.allDayPlaques}
                    >
                        {allDay.map((seg) => (
                            <TouchableOpacity
                                key={seg.item.key}
                                style={[
                                    styles.allDayPlaque,
                                    allDay.length === 1 && {
                                        minWidth: areaWidth,
                                    },
                                ]}
                                activeOpacity={0.85}
                                onPress={() => onSelect(seg.item.eventId)}
                            >
                                <Text
                                    style={styles.allDayName}
                                    numberOfLines={1}
                                >
                                    {seg.continuesBefore ? "← " : ""}
                                    {seg.item.event.name}
                                    {seg.continuesAfter ? " →" : ""}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </ScrollView>
                </View>
            )}

            <GestureDetector gesture={swipe}>
                <View style={styles.root}>
                    <ScrollView
                        ref={scrollRef}
                        contentContainerStyle={{
                            height: TOTAL_HEIGHT,
                            paddingBottom: bottomInset,
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

                            {/* Faded travel lead-ins — the pre-routed window before each event, in its lane */}
                            {timed.map((seg) => {
                                const travel = seg.item.event.travelTime;
                                if (!travel || seg.continuesBefore) return null;
                                const top = Math.max(
                                    0,
                                    ((seg.startMin - travel) / 60) *
                                        HOUR_HEIGHT,
                                );
                                const height =
                                    (seg.startMin / 60) * HOUR_HEIGHT - top;
                                if (height <= 0) return null;
                                return (
                                    <View
                                        key={`${seg.item.key}-lead`}
                                        pointerEvents="none"
                                        style={[
                                            styles.travelLeadIn,
                                            {
                                                top,
                                                height,
                                                ...laneBox(seg.item.key),
                                            },
                                        ]}
                                    >
                                        {height >= 22 && (
                                            <Text
                                                style={styles.travelLeadInText}
                                                numberOfLines={1}
                                            >
                                                ⊙ {travel} min travel
                                            </Text>
                                        )}
                                    </View>
                                );
                            })}

                            {/* Event blocks — tap to open detail, long-press + drag to move */}
                            {timed.map((seg) => (
                                <TripEventCard
                                    key={seg.item.key}
                                    event={seg.item.event}
                                    startMin={seg.startMin}
                                    endMin={seg.endMin}
                                    continuesBefore={seg.continuesBefore}
                                    continuesAfter={seg.continuesAfter}
                                    {...laneBox(seg.item.key)}
                                    draggable={
                                        !isRepeating(seg.item.event) &&
                                        !seg.continuesBefore &&
                                        !seg.continuesAfter
                                    }
                                    onPress={onSelect}
                                    onDrag={onDrag}
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
                </View>
            </GestureDetector>
        </View>
    );
}

function makeStyles(t: AppTheme) {
    const { colors, typography, spacing, radii } = t;
    return StyleSheet.create({
        root: { flex: 1 },

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

        // All-day plaque strip pinned between the toolbar and the timeline
        allDayStrip: {
            flexDirection: "row",
            alignItems: "flex-start",
            paddingVertical: 6,
            backgroundColor: colors.surface,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
        },
        allDayGutterLabel: {
            width: GUTTER_WIDTH - 10,
            textAlign: "right",
            paddingTop: 5,
            ...typography.caption,
            color: colors.ink3,
        },
        // 18 = (GUTTER_WIDTH + 8) − label width, so plaques align with event cards
        allDayScroll: {
            flex: 1,
            marginLeft: 18,
        },
        allDayPlaques: {
            gap: 4,
            paddingRight: spacing.screen,
        },
        allDayPlaque: {
            maxWidth: 220,
            borderRadius: radii.element,
            borderWidth: 1,
            borderColor: colors.primary + "44",
            borderLeftWidth: 4,
            borderLeftColor: colors.primary,
            backgroundColor: colors.primary + "14",
            paddingHorizontal: 10,
            paddingVertical: 5,
        },
        allDayName: {
            ...typography.captionStrong,
            color: colors.ink,
        },

        // Faded pre-routed travel window rendered above its event card
        travelLeadIn: {
            position: "absolute",
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
