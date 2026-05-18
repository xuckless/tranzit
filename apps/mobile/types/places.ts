export interface PlaceResult {
  id: string;
  displayName: { text: string };
  formattedAddress: string; // New field for street/number info
  location: { latitude: number; longitude: number };
}

export interface PlacesSearchResponse {
  places: PlaceResult[];
}

// Downstream contract — what gets passed to the route engine
export interface SelectedDestination {
  placeId: string; // strictly the id field — never displayName.text
  displayText: string; // for UI label only, never sent to /route
  coordinate: {
    latitude: number;
    longitude: number;
  };
}
