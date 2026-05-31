import type { Route } from "@/types/places";
import type { TripSession } from "@/types/trip";

interface StoredLocation {
  label: string;
  lat: number;
  lng: number;
  placeId?: string;
}

let _selectedRoute: Route | null = null;
let _routes: Route[] = [];
let _destination: StoredLocation | null = null;
let _origin: StoredLocation | null = null;
let _tripSession: TripSession | null = null;

export const routeStore = {
  setSelectedRoute(r: Route | null): void {
    _selectedRoute = r;
  },
  getSelectedRoute(): Route | null {
    return _selectedRoute;
  },

  setRoutes(routes: Route[]): void {
    _routes = routes;
  },
  getRoutes(): Route[] {
    return _routes;
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

  setTripSession(s: TripSession | null): void {
    _tripSession = s;
  },
  getTripSession(): TripSession | null {
    return _tripSession;
  },

  /** Ends the active journey but keeps cached routes/origin/destination so the
   *  Routes screen can restore its previous results without re-fetching. */
  clearJourney(): void {
    _selectedRoute = null;
    _tripSession = null;
  },

  clear(): void {
    _selectedRoute = null;
    _routes = [];
    _destination = null;
    _origin = null;
    _tripSession = null;
  },
};
