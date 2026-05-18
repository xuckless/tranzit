import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet } from "react-native";
import { SearchBar } from "./SearchBar";
import { SearchResultsList } from "./SearchResultsList";
import { usePlacesSearch } from "../../hooks/usePlacesSearch";
import type { SelectedDestination } from "../../types/places";

interface UserLocation {
  latitude: number;
  longitude: number;
}

interface Props {
  // User's live location — passed to usePlacesSearch to bias results.
  // Optional: search still works without it, just unbiased.
  userLocation?: UserLocation | null;

  // Called when user selects a result.
  // Parent should:
  //   1. Drop a map marker at destination.coordinate immediately
  //   2. Fire the /route request with destination.placeId
  onDestinationSelected: (destination: SelectedDestination) => void;

  // Called when the user focuses the input or receives results (true),
  // or clears/dismisses the search (false).
  // MapScreen uses this to hide the Quick Access chips and Nearby Stops
  // while the suggestions list is visible.
  onSearchActiveChange: (active: boolean) => void;

  // Called when the user clears the search so MapScreen can clear the
  // destination pin and pan the camera back to userLocation.
  onClear: () => void;
}

export const SearchSheet: React.FC<Props> = ({
  userLocation,
  onDestinationSelected,
  onSearchActiveChange,
  onClear,
}) => {
  const [query, setQuery] = useState("");
  const { state, search, reset } = usePlacesSearch(userLocation);

  const handleChangeText = useCallback(
    (text: string) => {
      setQuery(text);
      search(text);
      // Notify parent that search is active as soon as the user starts typing
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
    (destination: SelectedDestination) => {
      setQuery(destination.displayText);
      // Results list collapses after selection — search is no longer "active"
      onSearchActiveChange(false);
      onDestinationSelected(destination);
    },
    [onDestinationSelected, onSearchActiveChange],
  );

  return (
    // No handle or label here — MapScreen's Animated.View owns the sheet chrome.
    <View style={styles.container}>
      <SearchBar
        value={query}
        isLoading={state.status === "loading"}
        onChangeText={handleChangeText}
        onClear={handleClear}
      />

      {state.status === "success" && (
        <SearchResultsList results={state.results} onSelect={handleSelect} />
      )}

      {state.status === "empty" && (
        <Text style={styles.emptyText}>No results for "{state.query}"</Text>
      )}

      {state.status === "error" && (
        <Text style={styles.errorText}>{state.message}</Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  // Outer container is intentionally unstyled — the sheet background,
  // border-radius, and padding are owned by MapScreen's Animated.View.
  container: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  emptyText: {
    fontFamily: "DMmono-Regular",
    fontSize: 12,
    color: "rgba(255,255,255,0.25)",
    textAlign: "center",
    paddingVertical: 20,
  },
  errorText: {
    fontFamily: "DMmono-Regular",
    fontSize: 12,
    color: "#f87171",
    textAlign: "center",
    paddingVertical: 20,
  },
});
