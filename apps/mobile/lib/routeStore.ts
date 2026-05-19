import type { Route } from "@/types/places";

interface StoredLocation {
  label: string;
  lat: number;
  lng: number;
}

let _selectedRoute: Route | null = null;
let _destination: StoredLocation | null = null;
let _origin: StoredLocation | null = null;

export const routeStore = {
  setSelectedRoute(r: Route | null): void {
    _selectedRoute = r;
  },
  getSelectedRoute(): Route | null {
    return _selectedRoute;
  },
  setDestination(d: StoredLocation | null): void {
    _destination = d;
  },
  getDestination(): StoredLocation | null {
    return _destination;
  },
  setOrigin(o: StoredLocation | null): void {
    _origin = o;
  },
  getOrigin(): StoredLocation | null {
    return _origin;
  },
  clear(): void {
    _selectedRoute = null;
    _destination = null;
    _origin = null;
  },
};
