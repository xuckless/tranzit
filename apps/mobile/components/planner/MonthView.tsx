import { useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import { daySegments, type Occurrence } from "./recurrence";
import { localDayKey, monthGridDays } from "./trip";

type Props = {
    /** Any date in the month shown (the selected date). */
    anchor: Date;
    occurrences: Occurrence[];
    selectedKey: string;
    bottomInset: number;
    /** Tapping a day → Day view on that date. */
    onSelectDay: (day: Date) => void;
};

const MAX_CHIPS = 3;

/** 6×7 month grid (Monday-first): today filled, selected outlined, ≤3 chips + "+N". */
export function MonthView({
    anchor,
    occurrences,
    selectedKey,
    bottomInset,
    onSelectDay,
}: Props) {
    const { theme } = useTheme();
    const styles = useMemo(() => makeStyles(theme), [theme]);
    const todayKey = localDayKey(new Date());
    const month = anchor.getMonth();

    const cells = useMemo(
        () =>
            monthGridDays(anchor).map((date) => {
                const key = localDayKey(date);
                const { allDay, timed } = daySegments(occurrences, key);
                return { date, key, items: [...allDay, ...timed] };
            }),
        [anchor, occurrences],
    );
    const weekdayLabels = useMemo(
        () =>
            cells
                .slice(0, 7)
                .map((c) =>
                    c.date.toLocaleDateString(undefined, { weekday: "narrow" }),
                ),
        [cells],
    );

    return (
        <View style={[styles.root, { paddingBottom: bottomInset }]}>
            <View style={styles.weekdayRow}>
                {weekdayLabels.map((l, i) => (
                    <Text key={i} style={styles.weekday}>
                        {l}
                    </Text>
                ))}
            </View>
            {Array.from({ length: 6 }, (_, row) => (
                <View key={row} style={styles.row}>
                    {cells.slice(row * 7, row * 7 + 7).map((c) => {
                        const inMonth = c.date.getMonth() === month;
                        const isToday = c.key === todayKey;
                        const isSelected = c.key === selectedKey;
                        const extra = c.items.length - MAX_CHIPS;
                        return (
                            <TouchableOpacity
                                key={c.key}
                                style={[
                                    styles.cell,
                                    isSelected && styles.cellSelected,
                                ]}
                                activeOpacity={0.7}
                                onPress={() => onSelectDay(c.date)}
                            >
                                <View
                                    style={[
                                        styles.dayNum,
                                        isToday && styles.dayNumToday,
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.dayNumText,
                                            !inMonth && styles.outOfMonth,
                                            isToday && styles.dayNumTextToday,
                                        ]}
                                    >
                                        {c.date.getDate()}
                                    </Text>
                                </View>
                                {c.items.slice(0, MAX_CHIPS).map((seg) => (
                                    <View
                                        key={seg.item.key}
                                        style={[
                                            styles.chip,
                                            !inMonth && styles.chipDim,
                                        ]}
                                    >
                                        <Text
                                            style={styles.chipText}
                                            numberOfLines={1}
                                        >
                                            {seg.item.event.name}
                                        </Text>
                                    </View>
                                ))}
                                {extra > 0 && (
                                    <Text style={styles.more}>+{extra}</Text>
                                )}
                            </TouchableOpacity>
                        );
                    })}
                </View>
            ))}
        </View>
    );
}

function makeStyles(t: AppTheme) {
    const { colors, typography, radii } = t;
    return StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.surface },
        weekdayRow: {
            flexDirection: "row",
            paddingVertical: 6,
            borderBottomWidth: 1,
            borderBottomColor: colors.divider,
        },
        weekday: {
            flex: 1,
            textAlign: "center",
            ...typography.micro,
            color: colors.ink3,
        },
        row: {
            flex: 1,
            flexDirection: "row",
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.divider,
        },
        cell: {
            flex: 1,
            paddingHorizontal: 2,
            paddingTop: 3,
            gap: 2,
            overflow: "hidden",
            borderRightWidth: StyleSheet.hairlineWidth,
            borderRightColor: colors.divider,
        },
        cellSelected: {
            borderWidth: 1.5,
            borderColor: colors.primary,
            borderRadius: radii.element / 2,
        },
        dayNum: {
            alignSelf: "center",
            minWidth: 22,
            height: 22,
            borderRadius: 11,
            alignItems: "center",
            justifyContent: "center",
        },
        dayNumToday: {
            backgroundColor: colors.primary,
        },
        dayNumText: {
            ...typography.captionStrong,
            color: colors.ink,
        },
        dayNumTextToday: {
            color: colors.onPrimary,
        },
        outOfMonth: {
            color: colors.ink3,
        },
        chip: {
            borderRadius: radii.element / 2,
            backgroundColor: colors.primary + "22",
            borderLeftWidth: 2,
            borderLeftColor: colors.primary,
            paddingHorizontal: 2,
        },
        chipDim: { opacity: 0.55 },
        chipText: {
            ...typography.micro,
            color: colors.ink,
        },
        more: {
            ...typography.micro,
            color: colors.ink3,
            textAlign: "center",
        },
    });
}
