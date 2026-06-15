import { useMemo, useState } from "react";
import {
    View,
    Text,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    ScrollView,
} from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import AntDesign from "@expo/vector-icons/AntDesign";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { Stepper } from "@/components/planner/Stepper";
import {
    type PlannedTrip,
    type TimingMode,
    formatClock,
    formatDuration,
    DAY_MIN,
    SNAP_MIN,
} from "@/components/planner/trip";

const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));

// Placeholder travel estimate used until the route service computes the real one.
const PLACEHOLDER_TRAVEL_MIN = 30;

export default function AddTripScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);

    const [destination, setDestination] = useState("");
    const [origin, setOrigin] = useState("");
    const [mode, setMode] = useState<TimingMode>("leave");
    const [stayMin, setStayMin] = useState(60);

    // The single editable time means "leave at" or "arrive by" depending on mode;
    // travel time is auto-generated, so the other end is derived, not entered.
    const [targetMin, setTargetMin] = useState(() => {
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        return clamp(Math.round(mins / SNAP_MIN) * SNAP_MIN, 0, DAY_MIN);
    });

    const handleCreate = () => {
        // TODO(trip-planner): compute the real travel time + leave-by via the Route
        // Service (services/TranzitApiService.ts) for the chosen mode, persist the
        // trip to the per-user trips store, schedule the leave-by notification
        // (lib/leaveByNotifications.ts), and surface it on the planner timeline.
        // PLACEHOLDER_TRAVEL_MIN stands in until that wiring exists.
        const departMin =
            mode === "leave"
                ? targetMin
                : Math.max(0, targetMin - PLACEHOLDER_TRAVEL_MIN);
        const arriveMin =
            mode === "leave" ? targetMin + PLACEHOLDER_TRAVEL_MIN : targetMin;
        const trip: PlannedTrip = {
            id: Date.now().toString(),
            destination: destination.trim() || "New trip",
            origin: origin.trim() || "Current location",
            departMin,
            arriveMin,
            eventEndMin: arriveMin + stayMin,
            mode,
        };
        console.log("create trip", trip);
        router.back();
    };

    const timeLabel = mode === "leave" ? "Leave" : "Arrive";

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
                <Text style={styles.headerTitle}>Add Trip</Text>
                <View style={styles.headerSide} />
            </View>

            <ScrollView
                contentContainerStyle={styles.content}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
            >
                {/* Header row — transit icon + destination input (mirrors detail) */}
                <View style={styles.headerRow}>
                    <View style={styles.headerIcon}>
                        <MaterialIcons
                            name="directions-transit"
                            size={20}
                            color={colors.onPrimary}
                        />
                    </View>
                    <View style={{ flex: 1 }}>
                        <TextInput
                            style={styles.titleInput}
                            value={destination}
                            onChangeText={setDestination}
                            placeholder="Destination"
                            placeholderTextColor={colors.ink3}
                        />
                        <Text style={styles.subtitle}>
                            Travel time is added automatically
                        </Text>
                    </View>
                </View>

                {/* From */}
                <View style={styles.fieldBlock}>
                    <Text style={styles.fieldLabel}>From</Text>
                    <View style={styles.inputRow}>
                        <AntDesign
                            name="aim"
                            size={16}
                            color={colors.ink3}
                            style={styles.rowIcon}
                        />
                        <TextInput
                            style={styles.input}
                            value={origin}
                            onChangeText={setOrigin}
                            placeholder="Origin"
                            placeholderTextColor={colors.ink3}
                        />
                    </View>
                </View>

                {/* Leave By / Arrive By toggle */}
                <View style={styles.segment}>
                    <TouchableOpacity
                        style={[
                            styles.segmentBtn,
                            mode === "leave" && styles.segmentBtnActive,
                        ]}
                        onPress={() => setMode("leave")}
                        activeOpacity={0.85}
                    >
                        <Text
                            style={[
                                styles.segmentText,
                                mode === "leave" && styles.segmentTextActive,
                            ]}
                        >
                            Leave By
                        </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[
                            styles.segmentBtn,
                            mode === "arrive" && styles.segmentBtnActive,
                        ]}
                        onPress={() => setMode("arrive")}
                        activeOpacity={0.85}
                    >
                        <Text
                            style={[
                                styles.segmentText,
                                mode === "arrive" && styles.segmentTextActive,
                            ]}
                        >
                            Arrive By
                        </Text>
                    </TouchableOpacity>
                </View>

                {/* Steppers — same control as the detail edit sheet */}
                <View style={styles.steppers}>
                    <Stepper
                        label={timeLabel}
                        value={formatClock(targetMin)}
                        onDec={() =>
                            setTargetMin((v) =>
                                clamp(v - SNAP_MIN, 0, DAY_MIN),
                            )
                        }
                        onInc={() =>
                            setTargetMin((v) =>
                                clamp(v + SNAP_MIN, 0, DAY_MIN),
                            )
                        }
                    />
                    <Stepper
                        label="Stay"
                        value={formatDuration(stayMin)}
                        onDec={() =>
                            setStayMin((v) =>
                                clamp(v - SNAP_MIN, SNAP_MIN, DAY_MIN),
                            )
                        }
                        onInc={() =>
                            setStayMin((v) =>
                                clamp(v + SNAP_MIN, SNAP_MIN, DAY_MIN),
                            )
                        }
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
                    style={styles.createBtn}
                    onPress={handleCreate}
                    activeOpacity={0.85}
                >
                    <Text style={styles.createBtnText}>Create Trip</Text>
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
        subtitle: {
            ...typography.caption,
            color: colors.primary,
            marginTop: 4,
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
        input: {
            flex: 1,
            ...typography.body,
            color: colors.ink,
            paddingVertical: 10,
        },

        segment: {
            flexDirection: "row",
            backgroundColor: colors.surface2,
            borderRadius: radii.button,
            padding: 4,
            gap: 4,
        },
        segmentBtn: {
            flex: 1,
            alignItems: "center",
            paddingVertical: 10,
            borderRadius: radii.chip,
        },
        segmentBtnActive: {
            backgroundColor: colors.secondary,
        },
        segmentText: {
            ...typography.bodyStrong,
            color: colors.ink2,
        },
        segmentTextActive: {
            color: colors.selected,
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
