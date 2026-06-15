import { useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";

// A labelled −/+ stepper row. Shared by the Trip Details edit sheet and the Add
// Trip screen so both adjust times the same way.
export function Stepper({
    label,
    value,
    onDec,
    onInc,
}: {
    label: string;
    value: string;
    onDec: () => void;
    onInc: () => void;
}) {
    const { theme } = useTheme();
    const { colors } = theme;
    const styles = useMemo(() => makeStyles(theme), [theme]);

    return (
        <View style={styles.row}>
            <Text style={styles.label}>{label}</Text>
            <View style={styles.controls}>
                <TouchableOpacity
                    style={styles.btn}
                    onPress={onDec}
                    activeOpacity={0.7}
                >
                    <Ionicons name="remove" size={18} color={colors.ink} />
                </TouchableOpacity>
                <Text style={styles.value}>{value}</Text>
                <TouchableOpacity
                    style={styles.btn}
                    onPress={onInc}
                    activeOpacity={0.7}
                >
                    <Ionicons name="add" size={18} color={colors.ink} />
                </TouchableOpacity>
            </View>
        </View>
    );
}

function makeStyles(t: AppTheme) {
    const { colors, typography, spacing } = t;
    return StyleSheet.create({
        row: {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingVertical: 10,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.divider,
        },
        label: {
            ...typography.body,
            color: colors.ink2,
        },
        controls: {
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.card,
        },
        btn: {
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.border,
            justifyContent: "center",
            alignItems: "center",
        },
        value: {
            ...typography.bodyStrong,
            color: colors.ink,
            minWidth: 76,
            textAlign: "center",
        },
    });
}
