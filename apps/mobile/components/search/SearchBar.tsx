import React, { useRef, useMemo } from "react";
import { useTheme } from "@/contexts/ThemeContext";
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { AppTheme } from "@/styles/themes";

interface Props {
  value: string;
  isLoading: boolean;
  onChangeText: (text: string) => void;
  onClear: () => void;
}

export const SearchBar: React.FC<Props> = ({
  value,
  isLoading,
  onChangeText,
  onClear,
}) => {
  const { theme } = useTheme();
  const { colors, typography } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const inputRef = useRef<TextInput>(null);

  return (
    <View style={styles.container}>
      <View style={styles.iconSlot}>
        {isLoading ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Ionicons name="search" size={18} color={colors.ink3} />
        )}
      </View>

      <TextInput
        ref={inputRef}
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder="Where to?"
        placeholderTextColor={colors.ink2}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="never"
      />

      {value.length > 0 && (
        <TouchableOpacity
          onPress={onClear}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityLabel="Clear search"
        >
          <Ionicons name="close-circle" size={18} color={colors.ink2} />
        </TouchableOpacity>
      )}
    </View>
  );
};

const makeStyles = (t: AppTheme) => {
  const { colors, typography, radii } = t;
  return StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.surface2,
      borderRadius: radii.chip,
      borderWidth: 0.5,
      borderColor: colors.border,
      paddingHorizontal: 12,
      height: 48,
      gap: t.spacing.element,
    },
    iconSlot: {
      width: 20,
      alignItems: "center",
    },
    input: {
      flex: 1,
      ...typography.buttonLg,
      color: colors.ink,
    },
  });
};
