import React, { useState, useCallback, useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { SearchBar } from "./SearchBar";
import { DestinationSuggestionsList } from "./DestinationSuggestionsList";
import { useDestinationSearch } from "../../hooks/useDestinationSearch";
import { TranzitApiService } from "../../services/TranzitApiService";
import type { SelectedDestination, SearchSuggestion } from "../../types/places";
import { useTheme } from "../../contexts/ThemeContext";
import type { AppTheme } from "../../styles/themes";

interface UserLocation {
  latitude: number;
  longitude: number;
}

interface Props {
  userLocation?: UserLocation | null;
  onDestinationSelected: (destination: SelectedDestination) => void;
  onSearchActiveChange: (active: boolean) => void;
  onClear: () => void;
}

export const SearchSheet: React.FC<Props> = ({
  userLocation,
  onDestinationSelected,
  onSearchActiveChange,
  onClear,
}) => {
  const { theme } = useTheme();
  const { colors, typography } = theme;
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [query, setQuery] = useState("");
  const { status, suggestions, search, reset } = useDestinationSearch(userLocation);

  const handleChangeText = useCallback(
    (text: string) => {
      setQuery(text);
      search(text);
      onSearchActiveChange(text.trim().length > 0);
    },
    [search, onSearchActiveChange],
  );

  const handleClear = useCallback(() => {
    setQuery("");
    reset();
    onSearchActiveChange(false);
    onClear();
  }, [reset, onSearchActiveChange, onClear]);

  const handleSelect = useCallback(
    async (suggestion: SearchSuggestion) => {
      setQuery(suggestion.mainText);
      onSearchActiveChange(false);

      let coordinate: { latitude: number; longitude: number };
      if (suggestion.location) {
        coordinate = suggestion.location;
      } else {
        try {
          const details = await TranzitApiService.getPlaceDetails(suggestion.placeId);
          coordinate = details.location;
        } catch (e) {
          console.error("[SearchSheet] details fetch failed:", e);
          return;
        }
      }

      onDestinationSelected({
        placeId: suggestion.placeId,
        displayText: suggestion.mainText,
        coordinate,
      });
    },
    [onDestinationSelected, onSearchActiveChange],
  );

  return (
    <View style={styles.container}>
      <SearchBar
        value={query}
        isLoading={status === "loading"}
        onChangeText={handleChangeText}
        onClear={handleClear}
      />

      {status === "success" && (
        <DestinationSuggestionsList suggestions={suggestions} onSelect={handleSelect} />
      )}

      {status === "empty" && (
        <Text style={[styles.emptyText, { color: colors.ink3 }]}>No results found</Text>
      )}
    </View>
  );
};

const makeStyles = (t: AppTheme) => {
  const { typography, spacing } = t;
  return StyleSheet.create({
    container: {
      paddingHorizontal: spacing.card,
      paddingBottom: t.spacing.element,
    },
    emptyText: {
      ...typography.mono,
      textAlign: "center",
      paddingVertical: 20,
    },
  });
};
