import React, { useCallback } from "react";
import { theme } from "@/styles/theme";
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

interface Props {
  results: PlaceResult[];
  onSelect: (destination: SelectedDestination) => void;
}

export const SearchResultsList: React.FC<Props> = ({ results, onSelect }) => {
  const handlePress = useCallback(
    (place: PlaceResult) => {
      // Construct the SelectedDestination — placeId is the routing key.
      // coordinate is used immediately for the map pin while /route loads.
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
            <Ionicons name="location-outline" size={16} color="#3b7bff" />
          </View>
          <View style={styles.textWrap}>
            <Text style={styles.primaryText} numberOfLines={1}>
              {item.displayName.text}
            </Text>
            <Text style={styles.subText} numberOfLines={1}>
              {item.formattedAddress}
            </Text>
            {/*<Text style={styles.subText} numberOfLines={1}>
              {`${item.location.latitude.toFixed(4)}, ${item.location.longitude.toFixed(4)}`}
            </Text>*/}
          </View>
        </TouchableOpacity>
        {index < results.length - 1 && <View style={styles.divider} />}
      </>
    ),
    [handlePress, results.length],
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
