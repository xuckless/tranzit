import React, { useMemo, useRef } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../contexts/ThemeContext";
import type { AppTheme } from "../../styles/themes";

interface Props {
  /** Activate the full-screen search overlay, passing the trigger's window-Y so
   *  the bar can animate up from where it rests. */
  onActivate: (restingY: number) => void;
}

/**
 * The Map's resting search bar — a tap target that looks like a search field.
 * Tapping it measures its position and hands off to the animated SearchOverlay
 * (the editable field + suggestions/recents live there, clear of the keyboard).
 */
export const SearchSheet: React.FC<Props> = ({ onActivate }) => {
  const { theme } = useTheme();
  const { colors } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const ref = useRef<View>(null);

  const handlePress = () => {
    const node = ref.current;
    if (node) {
      node.measureInWindow((_x, y) => onActivate(y));
    } else {
      onActivate(-1); // overlay falls back to a sensible default
    }
  };

  return (
    <View style={styles.container}>
      <Pressable
        ref={ref}
        style={[
          styles.bar,
          { backgroundColor: colors.surface2, borderColor: colors.border },
        ]}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel="Search for a destination"
      >
        <Ionicons name="search" size={18} color={colors.ink3} />
        <Text style={[styles.placeholder, { color: colors.ink2 }]}>Where to?</Text>
      </Pressable>
    </View>
  );
};

const makeStyles = (t: AppTheme) => {
  const { colors, typography, radii, spacing } = t;
  return StyleSheet.create({
    container: {
      paddingHorizontal: spacing.card,
      paddingBottom: spacing.element,
    },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.element,
      backgroundColor: colors.surface2,
      borderRadius: radii.chip,
      borderWidth: 0.5,
      borderColor: colors.border,
      paddingHorizontal: 12,
      height: 48,
    },
    placeholder: {
      ...typography.buttonLg,
      color: colors.ink2,
    },
  });
};
