import { memo, useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import Animated, {
    useSharedValue,
    useAnimatedStyle,
    withTiming,
    runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { MaterialIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import {
    type PlannedTrip,
    formatClock,
    formatDuration,
    HOUR_HEIGHT,
    GUTTER_WIDTH,
    TRAVEL_MIN_HEIGHT,
    EVENT_MIN_HEIGHT,
    SNAP_MIN,
} from "./trip";

type Props = {
    trip: PlannedTrip;
    rightInset: number;
    onPress: (id: string) => void;
    onDrag: (id: string, deltaMin: number) => void;
};

function triggerHaptic() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

function TripEventCardBase({ trip, rightInset, onPress, onDrag }: Props) {
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);

    const translateY = useSharedValue(0);
    const active = useSharedValue(0);

    const top = (trip.departMin / 60) * HOUR_HEIGHT;
    const travelH = Math.max(
        ((trip.arriveMin - trip.departMin) / 60) * HOUR_HEIGHT,
        TRAVEL_MIN_HEIGHT,
    );
    const eventH = Math.max(
        ((trip.eventEndMin - trip.arriveMin) / 60) * HOUR_HEIGHT,
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
            runOnJS(onDrag)(trip.id, deltaMin);
            translateY.value = 0;
        })
        .onFinalize(() => {
            active.value = withTiming(0, { duration: 120 });
        });

    const tap = Gesture.Tap()
        .maxDuration(220)
        .onEnd(() => {
            runOnJS(onPress)(trip.id);
        });

    const gesture = Gesture.Exclusive(pan, tap);

    const animStyle = useAnimatedStyle(() => ({
        transform: [
            { translateY: translateY.value },
            { scale: 1 + active.value * 0.02 },
        ],
        opacity: 1 - active.value * 0.06,
    }));

    return (
        <GestureDetector gesture={gesture}>
            <Animated.View
                style={[
                    styles.tripContainer,
                    {
                        top,
                        height: travelH + eventH,
                        left: GUTTER_WIDTH + 8,
                        right: rightInset,
                    },
                    animStyle,
                ]}
            >
                {/* Travel-time section — dotted left rail, transit icon + duration. */}
                <View style={[styles.travelSection, { height: travelH }]}>
                    <MaterialIcons
                        name="directions-transit"
                        size={15}
                        color={colors.primary}
                    />
                    <Text style={styles.travelLabel} numberOfLines={1}>
                        {formatDuration(trip.arriveMin - trip.departMin)} travel
                        time
                    </Text>
                </View>

                {/* Destination section — solid left rail, title + arrival window. */}
                <View style={[styles.eventSection, { height: eventH }]}>
                    <Text style={styles.eventTitle} numberOfLines={1}>
                        {trip.destination}
                    </Text>
                    <Text style={styles.eventTime} numberOfLines={1}>
                        {formatClock(trip.arriveMin)} –{" "}
                        {formatClock(trip.eventEndMin)}
                    </Text>
                </View>
            </Animated.View>
        </GestureDetector>
    );
}

export const TripEventCard = memo(TripEventCardBase);

function makeStyles(t: AppTheme) {
    const { colors, typography, radii, shadow } = t;
    return StyleSheet.create({
        tripContainer: {
            position: "absolute",
            borderRadius: radii.element,
            borderWidth: 1,
            borderColor: colors.primary + "44",
            backgroundColor: colors.primary + "14",
            overflow: "hidden",
            ...shadow.card,
            shadowOpacity: 0.12,
        },
        travelSection: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 10,
            borderLeftWidth: 3,
            borderLeftColor: colors.primary,
            borderStyle: "dotted",
        },
        travelLabel: {
            ...typography.bodySmall,
            color: colors.primary,
        },
        eventSection: {
            justifyContent: "center",
            paddingHorizontal: 10,
            borderLeftWidth: 4,
            borderLeftColor: colors.primary,
            borderTopWidth: 1,
            borderTopColor: colors.primary + "33",
            backgroundColor: colors.primary + "10",
        },
        eventTitle: {
            ...typography.bodyStrong,
            color: colors.ink,
        },
        eventTime: {
            ...typography.caption,
            color: colors.ink2,
            marginTop: 1,
        },
    });
}
