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
    minutesOfDay,
    HOUR_HEIGHT,
    GUTTER_WIDTH,
    EVENT_MIN_HEIGHT,
    DAY_MIN,
    SNAP_MIN,
} from "./trip";

type Props = {
    event: PlannedEvent;
    rightInset: number;
    onPress: (id: string) => void;
    onDrag: (id: string, deltaMin: number) => void;
};

function triggerHaptic() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

function TripEventCardBase({ event, rightInset, onPress, onDrag }: Props) {
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);

    const translateY = useSharedValue(0);
    const active = useSharedValue(0);

    const startMin = minutesOfDay(event.start);
    let endMin = minutesOfDay(event.end);
    if (endMin <= startMin) endMin = DAY_MIN; // ends next day → clamp to end of day

    const top = (startMin / 60) * HOUR_HEIGHT;
    const height = Math.max(
        ((endMin - startMin) / 60) * HOUR_HEIGHT,
        EVENT_MIN_HEIGHT,
    );

    // Tap → open detail. Long-press + drag → reschedule (snapped to 5 min).
    // Long-press is required to start the drag so a quick tap never fights the
    // surrounding vertical ScrollView.
    const pan = Gesture.Pan()
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
                    {
                        top,
                        height,
                        left: GUTTER_WIDTH + 8,
                        right: rightInset,
                    },
                    animStyle,
                ]}
            >
                <View style={styles.titleRow}>
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
                {!!event.location && (
                    <Text style={styles.location} numberOfLines={1}>
                        {event.location}
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
    });
}
