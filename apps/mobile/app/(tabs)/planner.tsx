import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { TripEventCard } from "@/components/planner/TripEventCard";
import { TripDetailSheet } from "@/components/planner/TripDetailSheet";
import {
    type PlannedTrip,
    formatHourLabel,
    shiftTrip,
    SAMPLE_TRIPS,
    HOUR_HEIGHT,
    GUTTER_WIDTH,
    TOTAL_HEIGHT,
} from "@/components/planner/trip";

export default function PlannerScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);
    const scrollRef = useRef<ScrollView>(null);

    // TODO(trip-planner): load the signed-in user's planned trips from the per-user
    // trips store instead of the hardcoded SAMPLE_TRIPS, and surface imported
    // external-calendar events (iCal / Google / Outlook) as trips here.
    const [trips, setTrips] = useState<PlannedTrip[]>(SAMPLE_TRIPS);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const selectedTrip = useMemo(
        () => trips.find((t) => t.id === selectedId) ?? null,
        [trips, selectedId],
    );

    const now = useMemo(() => new Date(), []);
    const currentTimeTop =
        (now.getHours() + now.getMinutes() / 60) * HOUR_HEIGHT;
    const dateLabel = now.toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
    });

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

    const handleDrag = useCallback((id: string, deltaMin: number) => {
        if (deltaMin === 0) return;
        setTrips((prev) =>
            prev.map((t) => (t.id === id ? shiftTrip(t, deltaMin) : t)),
        );
    }, []);

    const handleSave = useCallback((updated: PlannedTrip) => {
        setTrips((prev) =>
            prev.map((t) => (t.id === updated.id ? updated : t)),
        );
    }, []);

    const handleDelete = useCallback((id: string) => {
        setTrips((prev) => prev.filter((t) => t.id !== id));
        setSelectedId(null);
    }, []);

    return (
        <View style={styles.screen}>
            {/* Sub-header toolbar (sits under the global Tranzit HeaderBar) */}
            <View style={styles.toolbar}>
                <TouchableOpacity
                    style={styles.todayBtn}
                    activeOpacity={0.85}
                    onPress={() =>
                        scrollRef.current?.scrollTo({
                            y: 8 * HOUR_HEIGHT - 20,
                            animated: true,
                        })
                    }
                >
                    <Text style={styles.todayBtnText}>Today</Text>
                </TouchableOpacity>

                <Text style={styles.dateLabel}>{dateLabel}</Text>

                <TouchableOpacity
                    style={styles.addFab}
                    activeOpacity={0.85}
                    onPress={() => router.push("/add-trip")}
                >
                    <Ionicons name="add" size={22} color={colors.onPrimary} />
                </TouchableOpacity>
            </View>

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

                    {/* Trip blocks — tap to open detail, long-press + drag to move */}
                    {trips.map((trip) => (
                        <TripEventCard
                            key={trip.id}
                            trip={trip}
                            rightInset={theme.spacing.screen}
                            onPress={handleSelect}
                            onDrag={handleDrag}
                        />
                    ))}

                    {/* Current-time indicator */}
                    <View
                        style={[styles.currentLine, { top: currentTimeTop }]}
                        pointerEvents="none"
                    >
                        <View style={styles.currentDot} />
                    </View>
                </View>
            </ScrollView>

            <TripDetailSheet
                trip={selectedTrip}
                onClose={() => setSelectedId(null)}
                onSave={handleSave}
                onDelete={handleDelete}
            />
        </View>
    );
}

function makeStyles(t: AppTheme) {
    const { colors, typography, spacing, radii, shadow } = t;
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
        todayBtn: {
            backgroundColor: colors.surface2,
            borderRadius: radii.chip,
            paddingHorizontal: spacing.card,
            paddingVertical: 8,
        },
        todayBtnText: {
            ...typography.bodyStrong,
            color: colors.ink,
        },
        dateLabel: {
            ...typography.subtitleStrong,
            color: colors.ink,
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
