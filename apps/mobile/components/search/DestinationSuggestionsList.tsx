import React, { useCallback, useMemo } from "react";
import {
  FlatList,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ListRenderItemInfo,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";
import type { SearchSuggestion } from "@/types/places";

interface Props {
  suggestions: SearchSuggestion[];
  onSelect: (suggestion: SearchSuggestion) => void;
}

export const DestinationSuggestionsList: React.FC<Props> = ({
  suggestions,
  onSelect,
}) => {
  const { theme } = useTheme();
  const { colors, typography, semantic } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<SearchSuggestion>) => {
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
                color={semantic.primaryChipBlue}
              />
            </View>
            <View style={styles.textWrap}>
              <Text style={[styles.primaryText, { color: colors.ink }]} numberOfLines={1}>
                {item.mainText}
              </Text>
              {item.secondaryText ? (
                <Text style={[styles.subText, { color: colors.ink3 }]} numberOfLines={1}>
                  {item.secondaryText}
                </Text>
              ) : null}
            </View>
          </TouchableOpacity>
          {index < suggestions.length - 1 && <View style={styles.divider} />}
        </>
      );
    },
    [onSelect, suggestions.length, styles, colors.ink, colors.ink3, semantic.primaryChipBlue],
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

const makeStyles = (t: AppTheme) => {
  const { colors, typography, semantic, radii, spacing } = t;
  return StyleSheet.create({
    list: { marginTop: spacing.xs },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 10,
      paddingHorizontal: spacing.xs,
      gap: 10,
    },
    iconWrap: {
      width: 34,
      height: 34,
      borderRadius: radii.element,
      backgroundColor: semantic.primaryChipBlueBg,
      borderWidth: 0.5,
      borderColor: semantic.primaryChipBlueBorder,
      alignItems: "center",
      justifyContent: "center",
    },
    textWrap: { flex: 1 },
    primaryText: {
      ...typography.bodySmallStrong,
      color: colors.ink,
    },
    subText: {
      ...typography.monoBody,
      color: colors.ink2,
      marginTop: 2,
    },
    divider: {
      height: 0.5,
      backgroundColor: colors.divider,
      marginLeft: 44,
    },
  });
};
