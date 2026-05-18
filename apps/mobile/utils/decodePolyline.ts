import polyline from "@mapbox/polyline";
import type { LatLng } from "react-native-maps";

export function decodePolyline(encoded: string): LatLng[] {
  return polyline
    .decode(encoded)
    .map(([lat, lng]: [number, number]) => ({ latitude: lat, longitude: lng }));
}
