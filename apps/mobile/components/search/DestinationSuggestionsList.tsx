import React, { useCallback } from "react";
import {
  FlatList,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ListRenderItemInfo,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "@/styles/theme";
import type { SearchSuggestion } from "@/types/places";

interface Props {
  suggestions: SearchSuggestion[];
  onSelect: (suggestion: SearchSuggestion) => void;
}

export const DestinationSuggestionsList: React.FC<Props> = ({
  suggestions,
  onSelect,
}) => {
  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<SearchSuggestion>) => {
      // Heuristic: main text starting with a digit is likely a street address
      const isAddress = /^\d/.test(item.mainText);
      return (
        <>
          <TouchableOpacity
            style={styles.row}
            onPress={() => onSelect(item)}
            activeOpacity={0.6}
            accessibilityRole="button"
            accessibilityLabel={`Navigate to ${item.mainText}`}
          >
            <View style={styles.iconWrap}>
              <Ionicons
                name={isAddress ? "navigate-outline" : "location-outline"}
                size={16}
                color="#3b7bff"
              />
            </View>
            <View style={styles.textWrap}>
              <Text style={styles.primaryText} numberOfLines={1}>
                {item.mainText}
              </Text>
              {item.secondaryText ? (
                <Text style={styles.subText} numberOfLines={1}>
                  {item.secondaryText}
                </Text>
              ) : null}
            </View>
          </TouchableOpacity>
          {index < suggestions.length - 1 && <View style={styles.divider} />}
        </>
      );
    },
    [onSelect, suggestions.length],
  );

  return (
    <FlatList
      data={suggestions}
      keyExtractor={(item) => item.placeId}
      renderItem={renderItem}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.list}
    />
  );
};

const styles = StyleSheet.create({
  list: { marginTop: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 4,
    gap: 10,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: "rgba(59,123,255,0.1)",
    borderWidth: 0.5,
    borderColor: "rgba(59,123,255,0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  textWrap: { flex: 1 },
  primaryText: {
    fontFamily: "Syne-Medium",
    fontSize: 13,
    color: theme.colors.text,
  },
  subText: {
    fontFamily: "DMmono-Regular",
    fontSize: 11,
    color: theme.colors.text,
    marginTop: 2,
  },
  divider: {
    height: 0.5,
    backgroundColor: "rgba(255,255,255,0.06)",
    marginLeft: 44,
  },
});
