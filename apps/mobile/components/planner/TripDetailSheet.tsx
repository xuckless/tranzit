import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import BottomSheet, {
    BottomSheetScrollView,
    BottomSheetBackdrop,
    BottomSheetTextInput,
    type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Ionicons, MaterialIcons } from "@expo/vector-icons";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import type { SaveEventInput } from "@/lib/plannerEvents";
import { Stepper } from "./Stepper";
import {
    type PlannedEvent,
    formatClock,
    formatDuration,
    minutesOfDay,
    durationMin,
    localDayKey,
    isoForDay,
    DAY_MIN,
    SNAP_MIN,
} from "./trip";

type Props = {
    event: PlannedEvent | null;
    onClose: () => void;
    onSave: (event: SaveEventInput) => void;
    onDelete: (id: string) => void;
};

const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));

export function TripDetailSheet({ event, onClose, onSave, onDelete }: Props) {
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);
    const sheetRef = useRef<BottomSheet>(null);
    const snapPoints = useMemo(() => ["55%", "90%"], []);

    const [editing, setEditing] = useState(false);

    // Editable draft (decomposed so steppers are simple). Repopulated whenever a
    // different event is selected.
    const [name, setName] = useState("");
    const [location, setLocation] = useState("");
    const [notes, setNotes] = useState("");
    const [startMin, setStartMin] = useState(0);
    const [durMin, setDurMin] = useState(60);

    useEffect(() => {
        if (!event) return;
        setName(event.name);
        setLocation(event.location ?? "");
        setNotes(event.notes ?? "");
        setStartMin(minutesOfDay(event.start));
        setDurMin(durationMin(event));
        setEditing(false);
        sheetRef.current?.snapToIndex(0);
    }, [event]);

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
        if (!event) return;
        const dayKey = localDayKey(new Date(event.start));
        const start = isoForDay(dayKey, startMin);
        const end = new Date(
            new Date(start).getTime() + durMin * 60000,
        ).toISOString();
        onSave({
            eventId: event.eventId,
            name: name.trim() || event.name,
            location: location.trim() || null,
            notes: notes.trim() || null,
            start,
            end,
            timezone: event.timezone,
        });
        setEditing(false);
    }, [event, name, location, notes, startMin, durMin, onSave]);

    const endMin = startMin + durMin;

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
                {event && (
                    <>
                        {/* Header */}
                        <View style={styles.headerRow}>
                            <View style={styles.headerIcon}>
                                <MaterialIcons
                                    name="event"
                                    size={20}
                                    color={colors.onPrimary}
                                />
                            </View>
                            <View style={{ flex: 1 }}>
                                {editing ? (
                                    <BottomSheetTextInput
                                        style={styles.titleInput}
                                        value={name}
                                        onChangeText={setName}
                                        placeholder="Event name"
                                        placeholderTextColor={colors.ink3}
                                    />
                                ) : (
                                    <Text
                                        style={styles.title}
                                        numberOfLines={2}
                                    >
                                        {event.name}
                                    </Text>
                                )}
                                <Text style={styles.subtitle}>
                                    {formatDuration(durMin)}
                                    {event.imported ? " · from calendar" : ""}
                                </Text>
                            </View>
                        </View>

                        {/* Editable rows */}
                        {editing ? (
                            <>
                                <View style={styles.fieldBlock}>
                                    <Text style={styles.fieldLabel}>
                                        Location
                                    </Text>
                                    <BottomSheetTextInput
                                        style={styles.input}
                                        value={location}
                                        onChangeText={setLocation}
                                        placeholder="Where"
                                        placeholderTextColor={colors.ink3}
                                    />
                                </View>

                                <View style={styles.steppers}>
                                    <Stepper
                                        label="Start"
                                        value={formatClock(startMin)}
                                        onDec={() =>
                                            setStartMin((v) =>
                                                clamp(
                                                    v - SNAP_MIN,
                                                    0,
                                                    DAY_MIN - durMin,
                                                ),
                                            )
                                        }
                                        onInc={() =>
                                            setStartMin((v) =>
                                                clamp(
                                                    v + SNAP_MIN,
                                                    0,
                                                    DAY_MIN - durMin,
                                                ),
                                            )
                                        }
                                    />
                                    <Stepper
                                        label="Duration"
                                        value={formatDuration(durMin)}
                                        onDec={() =>
                                            setDurMin((v) =>
                                                clamp(
                                                    v - SNAP_MIN,
                                                    SNAP_MIN,
                                                    DAY_MIN - startMin,
                                                ),
                                            )
                                        }
                                        onInc={() =>
                                            setDurMin((v) =>
                                                clamp(
                                                    v + SNAP_MIN,
                                                    SNAP_MIN,
                                                    DAY_MIN - startMin,
                                                ),
                                            )
                                        }
                                    />
                                </View>

                                <View style={styles.fieldBlock}>
                                    <Text style={styles.fieldLabel}>Notes</Text>
                                    <BottomSheetTextInput
                                        style={[styles.input, styles.notesInput]}
                                        value={notes}
                                        onChangeText={setNotes}
                                        placeholder="Add notes"
                                        placeholderTextColor={colors.ink3}
                                        multiline
                                    />
                                </View>
                            </>
                        ) : (
                            <>
                                <View style={styles.detailList}>
                                    {!!event.location && (
                                        <DetailRow
                                            styles={styles}
                                            icon={
                                                <Ionicons
                                                    name="location"
                                                    size={16}
                                                    color={colors.ink3}
                                                />
                                            }
                                            label="Where"
                                            value={event.location}
                                        />
                                    )}
                                    <DetailRow
                                        styles={styles}
                                        icon={
                                            <Ionicons
                                                name="time-outline"
                                                size={16}
                                                color={colors.ink3}
                                            />
                                        }
                                        label="Start"
                                        value={formatClock(startMin)}
                                    />
                                    <DetailRow
                                        styles={styles}
                                        icon={
                                            <Ionicons
                                                name="flag"
                                                size={16}
                                                color={colors.ink3}
                                            />
                                        }
                                        label="End"
                                        value={formatClock(endMin)}
                                    />
                                </View>

                                {!!event.notes && (
                                    <View style={styles.notesCard}>
                                        <Text style={styles.notesText}>
                                            {event.notes}
                                        </Text>
                                    </View>
                                )}
                            </>
                        )}

                        {/* Footer actions */}
                        {editing ? (
                            <View style={styles.footer}>
                                <TouchableOpacity
                                    style={styles.deleteBtn}
                                    onPress={() => onDelete(event.eventId)}
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
                                        Edit Event
                                    </Text>
                                </TouchableOpacity>
                            </View>
                        )}

                        {!editing && (
                            <Text style={styles.hint}>
                                Tip: long-press an event on the timeline to drag
                                it to a new time.
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
        notesInput: {
            minHeight: 72,
            textAlignVertical: "top",
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

        notesCard: {
            backgroundColor: colors.surface2,
            borderRadius: radii.card,
            borderWidth: 1,
            borderColor: colors.border,
            padding: spacing.card,
        },
        notesText: {
            ...typography.body,
            color: colors.ink2,
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
