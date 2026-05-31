import type { Route } from "@/types/places";

export type ServerStopStatus =
  | "EXPECTED"
  | "ACTIVE"
  | "COMPLETED"
  | "UNSURE"
  | "MISSED";

export interface TripStop {
  stop_id: string;
  stop_name: string;
  route_id: string;
  stop_type: "FETCHED" | "TRANSFER";
  status: ServerStopStatus;
  time_remaining_s: number;
  eta: number; // Unix seconds
  lat: number;
  lng: number;
}

export interface TripStateMsg {
  type: "STATE";
  session_id: string;
  version: number;
  overall: ServerStopStatus;
  stops: TripStop[];
}

export interface TripRerouteMsg {
  type: "REROUTE";
  reason: string;
  from: { lat: number; lng: number };
  route: Route;
  legs: Array<{
    leg_index: number;
    mode: string;
    route_id: string;
    trip_id: string;
  }>;
}

export interface TripNotifyMsg {
  type: "NOTIFY";
  kind: string;
  stop_id: string;
  requires_response: boolean;
  message: string;
}

export interface TripSession {
  sessionId: string;
  wsUrl: string; // path e.g. "/trips/9f3c…/ws"
}
