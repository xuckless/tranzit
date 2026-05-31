import { useState, useEffect, useRef, useCallback } from "react";
import type { TripStateMsg, TripRerouteMsg, TripNotifyMsg } from "@/types/trip";

const ROUTE_SAVE_HTTP = process.env.EXPO_PUBLIC_ROUTE_SAVE_URL ?? "";
const ROUTE_SAVE_WS = ROUTE_SAVE_HTTP.replace(/^http/, "ws");

export interface UseTripWebSocketResult {
  tripState: TripStateMsg | null;
  lastReroute: TripRerouteMsg | null;
  lastNotify: TripNotifyMsg | null;
  isConnected: boolean;
  sendLocation: (
    lat: number,
    lng: number,
    speedMps?: number,
    headingDeg?: number,
  ) => void;
  sendUnsureResponse: (stopId: string, boarded: boolean) => void;
  disconnect: () => void;
}

export function useTripWebSocket(
  wsPath: string | null,
): UseTripWebSocketResult {
  const [tripState, setTripState] = useState<TripStateMsg | null>(null);
  const [lastReroute, setLastReroute] = useState<TripRerouteMsg | null>(null);
  const [lastNotify, setLastNotify] = useState<TripNotifyMsg | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const lastVersionRef = useRef<number>(-1);

  useEffect(() => {
    if (!wsPath || !ROUTE_SAVE_WS) return;

    const url = `${ROUTE_SAVE_WS}${wsPath}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      let msg: { type: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }

      switch (msg.type) {
        case "STATE": {
          const state = msg as unknown as TripStateMsg;
          if (state.version <= lastVersionRef.current) return;
          lastVersionRef.current = state.version;
          setTripState(state);
          break;
        }
        case "REROUTE":
          setLastReroute(msg as unknown as TripRerouteMsg);
          break;
        case "NOTIFY":
          setLastNotify(msg as unknown as TripNotifyMsg);
          break;
      }
    };

    ws.onerror = () => {
      setIsConnected(false);
    };

    ws.onclose = () => {
      setIsConnected(false);
      wsRef.current = null;
    };

    return () => {
      ws.close();
      wsRef.current = null;
      lastVersionRef.current = -1;
    };
  }, [wsPath]);

  const send = useCallback((payload: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const sendLocation = useCallback(
    (lat: number, lng: number, speedMps?: number, headingDeg?: number) => {
      send({
        type: "LOCATION",
        lat,
        lng,
        speed_mps: speedMps ?? 0,
        heading_deg: headingDeg ?? 0,
        ts: Math.floor(Date.now() / 1000),
      });
    },
    [send],
  );

  const sendUnsureResponse = useCallback(
    (stopId: string, boarded: boolean) => {
      send({ type: "UNSURE_RESPONSE", stop_id: stopId, boarded });
    },
    [send],
  );

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  return {
    tripState,
    lastReroute,
    lastNotify,
    isConnected,
    sendLocation,
    sendUnsureResponse,
    disconnect,
  };
}
