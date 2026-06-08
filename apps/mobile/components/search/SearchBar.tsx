import React, { useRef } from "react";
import { theme } from "@/styles/theme";
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/contexts/ThemeContext";

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
  const { colors } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const styles = makeStyles(colors);

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
        clearButtonMode="never" // we control this manually for cross-platform parity
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

const makeStyles = (colors: typeof theme.colors) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.surface2,
      borderRadius: 12,
      borderWidth: 0.5,
      borderColor: colors.border,
      paddingHorizontal: 12,
      height: 48,
      gap: 8,
    },
    iconSlot: {
      width: 20,
      alignItems: "center",
    },
    input: {
      flex: 1,
      fontFamily: "Syne-Regular",
      fontSize: 15,
      color: colors.ink,
    },
  });
