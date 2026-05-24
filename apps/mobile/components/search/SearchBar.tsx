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
  const inputRef = useRef<TextInput>(null);

  return (
    <View style={styles.container}>
      <View style={styles.iconSlot}>
        {isLoading ? (
          <ActivityIndicator size="small" color="#3b7bff" />
        ) : (
          <Ionicons name="search" size={18} color="#8a8f9e" />
        )}
      </View>

      <TextInput
        ref={inputRef}
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder="Where to?"
        placeholderTextColor="#4a5060"
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
          <Ionicons name="close-circle" size={18} color="#4a5060" />
        </TouchableOpacity>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.surface2,
    borderRadius: 12,
    borderWidth: 0.5,
    borderColor: "rgba(255,255,255,0.1)",
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
    color: theme.colors.text,
  },
});
