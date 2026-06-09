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
import type { PlaceResult, SelectedDestination } from "../../types/places";
import { useTheme } from "@/contexts/ThemeContext";
import type { AppTheme } from "@/styles/themes";

interface Props {
  results: PlaceResult[];
  onSelect: (destination: SelectedDestination) => void;
}

export const SearchResultsList: React.FC<Props> = ({ results, onSelect }) => {
  const { theme } = useTheme();
  const { colors, typography } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const handlePress = useCallback(
    (place: PlaceResult) => {
      onSelect({
        placeId: place.id,
        displayText: place.displayName.text,
        coordinate: {
          latitude: place.location.latitude,
          longitude: place.location.longitude,
        },
      });
    },
    [onSelect],
  );

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<PlaceResult>) => (
      <>
        <TouchableOpacity
          style={styles.row}
          onPress={() => handlePress(item)}
          activeOpacity={0.6}
          accessibilityRole="button"
          accessibilityLabel={`Navigate to ${item.displayName.text}`}
        >
          <View style={styles.iconWrap}>
            <Ionicons name="location-outline" size={16} color={colors.primary} />
          </View>
          <View style={styles.textWrap}>
            <Text style={styles.primaryText} numberOfLines={1}>
              {item.displayName.text}
            </Text>
            <Text style={styles.subText} numberOfLines={1}>
              {item.formattedAddress}
            </Text>
          </View>
        </TouchableOpacity>
        {index < results.length - 1 && <View style={styles.divider} />}
      </>
    ),
    [handlePress, results.length, styles, colors.primary],
  );

  return (
    <FlatList
      data={results}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      style={styles.list}
    />
  );
};

const makeStyles = (t: AppTheme) => {
  const { colors, typography, radii, spacing } = t;
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
      backgroundColor: colors.primaryDim,
      borderWidth: 0.5,
      borderColor: colors.border,
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
