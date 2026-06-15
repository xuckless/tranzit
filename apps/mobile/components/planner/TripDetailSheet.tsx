import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import BottomSheet, {
    BottomSheetScrollView,
    BottomSheetBackdrop,
    BottomSheetTextInput,
    type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import AntDesign from "@expo/vector-icons/AntDesign";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { Stepper } from "./Stepper";
import {
    type PlannedTrip,
    formatClock,
    formatDuration,
    DAY_MIN,
    SNAP_MIN,
} from "./trip";

type Props = {
    trip: PlannedTrip | null;
    onClose: () => void;
    onSave: (trip: PlannedTrip) => void;
    onDelete: (id: string) => void;
};

const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));

export function TripDetailSheet({ trip, onClose, onSave, onDelete }: Props) {
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);
    const sheetRef = useRef<BottomSheet>(null);
    const snapPoints = useMemo(() => ["55%", "90%"], []);

    const [editing, setEditing] = useState(false);

    // Editable draft (decomposed so steppers are simple). Repopulated whenever a
    // different trip is selected.
    const [destination, setDestination] = useState("");
    const [origin, setOrigin] = useState("");
    const [departMin, setDepartMin] = useState(0);
    const [travelMin, setTravelMin] = useState(0);
    const [eventDurMin, setEventDurMin] = useState(0);

    useEffect(() => {
        if (!trip) return;
        setDestination(trip.destination);
        setOrigin(trip.origin);
        setDepartMin(trip.departMin);
        setTravelMin(trip.arriveMin - trip.departMin);
        setEventDurMin(trip.eventEndMin - trip.arriveMin);
        setEditing(false);
        sheetRef.current?.snapToIndex(0);
    }, [trip]);

    const renderBackdrop = useCallback(
        (props: BottomSheetBackdropProps) => (
            <BottomSheetBackdrop
                {...props}
                appearsOnIndex={0}
                disappearsOnIndex={-1}
                pressBehavior="close"
            />
        ),
        [],
    );

    const handleSheetChange = useCallback(
        (index: number) => {
            if (index === -1) onClose();
        },
        [onClose],
    );

    const handleSave = useCallback(() => {
        if (!trip) return;
        const arriveMin = departMin + travelMin;
        // TODO(trip-planner): persist this edit to the per-user trips store and, if
        // times changed, re-request the Route Service ETA and reschedule the
        // leave-by local notification (lib/leaveByNotifications.ts).
        onSave({
            ...trip,
            destination: destination.trim() || trip.destination,
            origin: origin.trim() || trip.origin,
            departMin,
            arriveMin,
            eventEndMin: arriveMin + eventDurMin,
        });
        setEditing(false);
    }, [trip, destination, origin, departMin, travelMin, eventDurMin, onSave]);

    const arriveMin = departMin + travelMin;
    const eventEndMin = arriveMin + eventDurMin;
    const modeLabel = trip?.mode === "leave" ? "Leave by" : "Arrive by";

    return (
        <BottomSheet
            ref={sheetRef}
            index={-1}
            snapPoints={snapPoints}
            enablePanDownToClose
            enableDynamicSizing={false}
            backdropComponent={renderBackdrop}
            backgroundStyle={{ backgroundColor: colors.card }}
            handleIndicatorStyle={{ backgroundColor: colors.divider }}
            onChange={handleSheetChange}
        >
            <BottomSheetScrollView
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                {trip && (
                    <>
                        {/* Header */}
                        <View style={styles.headerRow}>
                            <View style={styles.headerIcon}>
                                <MaterialIcons
                                    name="directions-transit"
                                    size={20}
                                    color={colors.onPrimary}
                                />
                            </View>
                            <View style={{ flex: 1 }}>
                                {editing ? (
                                    <BottomSheetTextInput
                                        style={styles.titleInput}
                                        value={destination}
                                        onChangeText={setDestination}
                                        placeholder="Destination"
                                        placeholderTextColor={colors.ink3}
                                    />
                                ) : (
                                    <Text
                                        style={styles.title}
                                        numberOfLines={2}
                                    >
                                        {trip.destination}
                                    </Text>
                                )}
                                <Text style={styles.subtitle}>
                                    {modeLabel} ·{" "}
                                    {formatDuration(travelMin)} travel
                                </Text>
                            </View>
                        </View>

                        {/* Origin (edit only — read view folds it into the row list) */}
                        {editing && (
                            <View style={styles.fieldBlock}>
                                <Text style={styles.fieldLabel}>From</Text>
                                <BottomSheetTextInput
                                    style={styles.input}
                                    value={origin}
                                    onChangeText={setOrigin}
                                    placeholder="Origin"
                                    placeholderTextColor={colors.ink3}
                                />
                            </View>
                        )}

                        {/* Detail / editable rows */}
                        {editing ? (
                            <View style={styles.steppers}>
                                <Stepper
                                    label="Leave"
                                    value={formatClock(departMin)}
                                    onDec={() =>
                                        setDepartMin((v) =>
                                            clamp(
                                                v - SNAP_MIN,
                                                0,
                                                DAY_MIN -
                                                    travelMin -
                                                    eventDurMin,
                                            ),
                                        )
                                    }
                                    onInc={() =>
                                        setDepartMin((v) =>
                                            clamp(
                                                v + SNAP_MIN,
                                                0,
                                                DAY_MIN -
                                                    travelMin -
                                                    eventDurMin,
                                            ),
                                        )
                                    }
                                />
                                {/* Travel time is auto-generated by the route
                                    service, so it is shown read-only here (not a
                                    stepper) and recomputed when times change. */}
                                <View style={styles.readonlyRow}>
                                    <Text style={styles.readonlyLabel}>
                                        Travel
                                    </Text>
                                    <Text style={styles.readonlyValue}>
                                        {formatDuration(travelMin)} · auto
                                    </Text>
                                </View>
                                <Stepper
                                    label="Stay"
                                    value={formatDuration(eventDurMin)}
                                    onDec={() =>
                                        setEventDurMin((v) =>
                                            clamp(
                                                v - SNAP_MIN,
                                                SNAP_MIN,
                                                DAY_MIN -
                                                    departMin -
                                                    travelMin,
                                            ),
                                        )
                                    }
                                    onInc={() =>
                                        setEventDurMin((v) =>
                                            clamp(
                                                v + SNAP_MIN,
                                                SNAP_MIN,
                                                DAY_MIN -
                                                    departMin -
                                                    travelMin,
                                            ),
                                        )
                                    }
                                />
                            </View>
                        ) : (
                            <View style={styles.detailList}>
                                <DetailRow
                                    styles={styles}
                                    colors={colors}
                                    icon={
                                        <AntDesign
                                            name="aim"
                                            size={16}
                                            color={colors.ink3}
                                        />
                                    }
                                    label="From"
                                    value={trip.origin}
                                />
                                <DetailRow
                                    styles={styles}
                                    colors={colors}
                                    icon={
                                        <Ionicons
                                            name="location"
                                            size={16}
                                            color={colors.ink3}
                                        />
                                    }
                                    label="To"
                                    value={trip.destination}
                                />
                                <DetailRow
                                    styles={styles}
                                    colors={colors}
                                    icon={
                                        <Ionicons
                                            name="walk"
                                            size={16}
                                            color={colors.ink3}
                                        />
                                    }
                                    label="Leave"
                                    value={formatClock(departMin)}
                                />
                                <DetailRow
                                    styles={styles}
                                    colors={colors}
                                    icon={
                                        <Ionicons
                                            name="flag"
                                            size={16}
                                            color={colors.ink3}
                                        />
                                    }
                                    label="Arrive"
                                    value={formatClock(arriveMin)}
                                />
                                <DetailRow
                                    styles={styles}
                                    colors={colors}
                                    icon={
                                        <Ionicons
                                            name="time-outline"
                                            size={16}
                                            color={colors.ink3}
                                        />
                                    }
                                    label="Ends"
                                    value={formatClock(eventEndMin)}
                                />
                            </View>
                        )}

                        {/* Deep-detail placeholder.
                            TODO(trip-planner): render the step-by-step route, live ETA
                            and the leave-by reminder status here once wired to the
                            Route Service (services/TranzitApiService.ts) + tripWebSocket. */}
                        {!editing && (
                            <View style={styles.routeCard}>
                                <View style={styles.routeCardHeader}>
                                    <Ionicons
                                        name="git-branch-outline"
                                        size={15}
                                        color={colors.ink2}
                                    />
                                    <Text style={styles.routeCardTitle}>
                                        Route details
                                    </Text>
                                </View>
                                <Text style={styles.routeCardBody}>
                                    Step-by-step directions, live arrival times
                                    and a leave-by reminder will appear here once
                                    this trip is wired to the route service.
                                </Text>
                            </View>
                        )}

                        {/* Footer actions */}
                        {editing ? (
                            <View style={styles.footer}>
                                <TouchableOpacity
                                    style={styles.deleteBtn}
                                    onPress={() => onDelete(trip.id)}
                                    activeOpacity={0.85}
                                >
                                    <Ionicons
                                        name="trash-outline"
                                        size={18}
                                        color={colors.error}
                                    />
                                    <Text style={styles.deleteText}>Delete</Text>
                                </TouchableOpacity>
                                <TouchableOpacity
                                    style={[styles.primaryBtn, { flex: 1 }]}
                                    onPress={handleSave}
                                    activeOpacity={0.85}
                                >
                                    <Text style={styles.primaryBtnText}>
                                        Save
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        ) : (
                            <View style={styles.footer}>
                                <TouchableOpacity
                                    style={[styles.primaryBtn, { flex: 1 }]}
                                    onPress={() => setEditing(true)}
                                    activeOpacity={0.85}
                                >
                                    <Ionicons
                                        name="create-outline"
                                        size={18}
                                        color={colors.onPrimary}
                                    />
                                    <Text style={styles.primaryBtnText}>
                                        Edit Trip
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}

                        {!editing && (
                            <Text style={styles.hint}>
                                Tip: long-press a trip on the timeline to drag it
                                to a new time.
                            </Text>
                        )}
                    </>
                )}
            </BottomSheetScrollView>
        </BottomSheet>
    );
}

// ─── Sub-components ─────────────────────────────────────────────────────────────
function DetailRow({
    styles,
    icon,
    label,
    value,
}: {
    styles: ReturnType<typeof makeStyles>;
    colors: AppTheme["colors"];
    icon: React.ReactNode;
    label: string;
    value: string;
}) {
    return (
        <View style={styles.detailRow}>
            <View style={styles.detailRowLeft}>
                {icon}
                <Text style={styles.detailLabel}>{label}</Text>
            </View>
            <Text style={styles.detailValue} numberOfLines={1}>
                {value}
            </Text>
        </View>
    );
}

function makeStyles(t: AppTheme) {
    const { colors, typography, spacing, radii } = t;
    return StyleSheet.create({
        content: {
            paddingHorizontal: spacing.screen,
            paddingBottom: spacing.screen,
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
        title: {
            ...typography.title,
            color: colors.ink,
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
            marginTop: 2,
        },

        fieldBlock: { gap: 6 },
        fieldLabel: {
            ...typography.fieldLabel,
            color: colors.ink2,
        },
        input: {
            ...typography.body,
            color: colors.ink,
            backgroundColor: colors.surface2,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: radii.element,
            paddingHorizontal: 12,
            paddingVertical: 10,
        },

        detailList: {
            backgroundColor: colors.surface2,
            borderRadius: radii.card,
            borderWidth: 1,
            borderColor: colors.border,
            paddingHorizontal: spacing.card,
        },
        detailRow: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 12,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.divider,
        },
        detailRowLeft: {
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.element,
        },
        detailLabel: {
            ...typography.body,
            color: colors.ink2,
        },
        detailValue: {
            ...typography.bodyStrong,
            color: colors.ink,
            flexShrink: 1,
            textAlign: "right",
            marginLeft: spacing.element,
        },

        steppers: {
            backgroundColor: colors.surface2,
            borderRadius: radii.card,
            borderWidth: 1,
            borderColor: colors.border,
            paddingHorizontal: spacing.card,
        },
        readonlyRow: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 14,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.divider,
        },
        readonlyLabel: {
            ...typography.body,
            color: colors.ink2,
        },
        readonlyValue: {
            ...typography.bodyStrong,
            color: colors.ink3,
        },

        routeCard: {
            backgroundColor: colors.surface2,
            borderRadius: radii.card,
            borderWidth: 1,
            borderColor: colors.border,
            borderStyle: "dashed",
            padding: spacing.card,
            gap: 6,
        },
        routeCardHeader: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
        },
        routeCardTitle: {
            ...typography.bodyStrong,
            color: colors.ink2,
        },
        routeCardBody: {
            ...typography.caption,
            color: colors.ink3,
        },

        footer: {
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.element,
        },
        primaryBtn: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            backgroundColor: colors.primary,
            borderRadius: radii.button,
            paddingVertical: 14,
        },
        primaryBtnText: {
            ...typography.subtitleStrong,
            fontWeight: "800",
            color: colors.onPrimary,
        },
        deleteBtn: {
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingVertical: 14,
            paddingHorizontal: spacing.card,
            borderRadius: radii.button,
            borderWidth: 1,
            borderColor: colors.error,
        },
        deleteText: {
            ...typography.bodyStrong,
            color: colors.error,
        },
        hint: {
            ...typography.caption,
            color: colors.ink3,
            textAlign: "center",
        },
    });
}
