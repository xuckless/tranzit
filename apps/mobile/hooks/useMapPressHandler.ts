import { useState, useCallback, useRef } from "react";
import { LatLng } from "react-native-maps";

const BASE_URL =
  "https://tranzit-route-service.tailnet-example.ts.net";

export type PressedLocation = {
  coordinate: LatLng;
  placeId: string;
  address: string;
  displayName: string;
};

export function useMapPressHandler() {
  const [pressedLocation, setPressedLocation] =
    useState<PressedLocation | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleMapPress = useCallback(async (coordinate: LatLng) => {
    // Cancel any in-flight request from a previous press
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Drop pin immediately — don't wait for the network
    setPressedLocation(null);
    setIsResolving(true);

    try {
      const { latitude, longitude } = coordinate;
      const res = await fetch(
        `${BASE_URL}/search?q=${latitude.toFixed(5)},${longitude.toFixed(5)}&lat=${latitude}&lng=${longitude}`,
        { signal: controller.signal },
      );

      if (!res.ok) throw new Error(`Search failed: ${res.status}`);

      const data = await res.json();
      const place = data.places?.[0];

      if (!place) throw new Error("No place returned");

      setPressedLocation({
        coordinate,
        // Store only in session state — never persist Place IDs
        placeId: place.id,
        address: place.displayName.text,
        displayName: place.displayName.text,
      });
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") return;
      // Fallback: show raw coordinates if reverse geocode fails
      setPressedLocation({
        coordinate,
        placeId: "",
        address: `${coordinate.latitude.toFixed(5)}, ${coordinate.longitude.toFixed(5)}`,
        displayName: "Dropped pin",
      });
    } finally {
      setIsResolving(false);
    }
  }, []);

  const clearPress = useCallback(() => {
    abortRef.current?.abort();
    setPressedLocation(null);
    setIsResolving(false);
  }, []);

  return { pressedLocation, isResolving, handleMapPress, clearPress };
}
