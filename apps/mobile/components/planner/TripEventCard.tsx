import { memo, useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import {
    type PlannedEvent,
    formatClock,
    HOUR_HEIGHT,
    EVENT_MIN_HEIGHT,
    SNAP_MIN,
} from "./trip";

type Props = {
    /** The stored event (a repeating event's series); ids go back through callbacks. */
    event: PlannedEvent;
    /** This day's slice of the event/occurrence, in timeline minutes. */
    startMin: number;
    endMin: number;
    continuesBefore: boolean;
    continuesAfter: boolean;
    /** Lane geometry from ./layout.ts, in px. */
    left: number;
    width: number;
    /** Long-press drag (off for repeats and multi-day slices). */
    draggable: boolean;
    onPress: (id: string) => void;
    onDrag: (id: string, deltaMin: number) => void;
};

function triggerHaptic() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

function TripEventCardBase({
    event,
    startMin,
    endMin,
    continuesBefore,
    continuesAfter,
    left,
    width,
    draggable,
    onPress,
    onDrag,
}: Props) {
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);

    const translateY = useSharedValue(0);
    const active = useSharedValue(0);

    const top = (startMin / 60) * HOUR_HEIGHT;
    const height = Math.min(
        Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, EVENT_MIN_HEIGHT),
        24 * HOUR_HEIGHT - top,
    );
    const narrow = width < 110;
    // How many caption lines fit under the title + time (≈18px each after the
    // ~50px those two take with padding). A one-hour card fits one: show the
    // travel time if there is one (it explains the lead-in block above), else
    // the location.
    const extraLines = narrow ? 0 : Math.max(0, Math.floor((height - 50) / 18));
    const showTravel = !!event.travelTime && extraLines >= 1;
    const showLocation =
        !!event.location && extraLines >= (event.travelTime ? 2 : 1);

    // Tap → open detail. Long-press + drag → reschedule (snapped to 5 min).
    // Long-press is required to start the drag so a quick tap never fights the
    // surrounding vertical ScrollView.
    const pan = Gesture.Pan()
        .enabled(draggable)
        .activateAfterLongPress(220)
        .onStart(() => {
            active.value = withTiming(1, { duration: 120 });
            runOnJS(triggerHaptic)();
        })
        .onUpdate((e) => {
            translateY.value = e.translationY;
        })
        .onEnd((e) => {
            const deltaMin =
                Math.round((e.translationY / HOUR_HEIGHT) * 60 / SNAP_MIN) *
                SNAP_MIN;
            runOnJS(onDrag)(event.eventId, deltaMin);
            translateY.value = 0;
        })
        .onFinalize(() => {
            active.value = withTiming(0, { duration: 120 });
        });

    const tap = Gesture.Tap()
        .maxDuration(220)
        .onEnd(() => {
            runOnJS(onPress)(event.eventId);
        });

    const gesture = Gesture.Exclusive(pan, tap);

    const animStyle = useAnimatedStyle(() => ({
        transform: [
            { translateY: translateY.value },
            { scale: 1 + active.value * 0.02 },
        ],
        opacity: (event.pending ? 0.85 : 1) - active.value * 0.06,
    }));

    return (
        <GestureDetector gesture={gesture}>
            <Animated.View
                style={[
                    styles.container,
                    { top, height, left, width },
                    continuesBefore && styles.contTop,
                    continuesAfter && styles.contBottom,
                    animStyle,
                ]}
            >
                {continuesBefore && (
                    <Text style={styles.cont} numberOfLines={1}>
                        ↑ cont.
                    </Text>
                )}
                <View style={styles.titleRow}>
                    {!!event.recurrenceRule && (
                        <Ionicons
                            name="repeat"
                            size={13}
                            color={colors.ink2}
                        />
                    )}
                    {event.imported && (
                        <Ionicons
                            name="calendar-outline"
                            size={13}
                            color={colors.ink2}
                        />
                    )}
                    <Text style={styles.title} numberOfLines={1}>
                        {event.name}
                    </Text>
                </View>
                <Text style={styles.time} numberOfLines={1}>
                    {formatClock(startMin)} – {formatClock(endMin)}
                </Text>
                {showLocation && (
                    <Text style={styles.location} numberOfLines={1}>
                        {event.location}
                    </Text>
                )}
                {showTravel && (
                    <Text style={styles.travel} numberOfLines={1}>
                        ⏱ {event.travelTime} min travel
                    </Text>
                )}
            </Animated.View>
        </GestureDetector>
    );
}

export const TripEventCard = memo(TripEventCardBase);

function makeStyles(t: AppTheme) {
    const { colors, typography, radii, shadow } = t;
    return StyleSheet.create({
        container: {
            position: "absolute",
            justifyContent: "center",
            borderRadius: radii.element,
            borderWidth: 1,
            borderColor: colors.primary + "44",
            borderLeftWidth: 4,
            borderLeftColor: colors.primary,
            backgroundColor: colors.primary + "14",
            paddingHorizontal: 10,
            paddingVertical: 6,
            overflow: "hidden",
            ...shadow.card,
            shadowOpacity: 0.12,
        },
        // Multi-day slices: square the edge that continues into another day.
        contTop: {
            borderTopLeftRadius: 0,
            borderTopRightRadius: 0,
            borderTopWidth: 0,
        },
        contBottom: {
            borderBottomLeftRadius: 0,
            borderBottomRightRadius: 0,
            borderBottomWidth: 0,
        },
        cont: {
            ...typography.micro,
            color: colors.ink3,
        },
        titleRow: {
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
        },
        title: {
            ...typography.bodyStrong,
            color: colors.ink,
            flexShrink: 1,
        },
        time: {
            ...typography.caption,
            color: colors.ink2,
            marginTop: 1,
        },
        location: {
            ...typography.caption,
            color: colors.ink3,
            marginTop: 1,
        },
        travel: {
            ...typography.caption,
            color: colors.ink3,
            marginTop: 1,
            opacity: 0.8,
        },
    });
}
