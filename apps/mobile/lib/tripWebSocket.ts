import { useState, useEffect, useRef, useCallback } from "react";
import type { TripStateMsg, TripRerouteMsg, TripNotifyMsg, ServerStopStatus } from "@/types/trip";

const ROUTE_SAVE_HTTP = process.env.EXPO_PUBLIC_ROUTE_SAVE_URL ?? "";
const ROUTE_SAVE_WS = ROUTE_SAVE_HTTP.replace(/^http/, "ws");

const STATUS_PRIORITY: Record<ServerStopStatus, number> = {
  ACTIVE: 4, UNSURE: 3, EXPECTED: 2, MISSED: 1, COMPLETED: 0,
};

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

function mergeSessionStates(map: Map<string, TripStateMsg>): TripStateMsg {
  const sessions = Array.from(map.values());
  if (sessions.length === 1) return sessions[0];

  const completed = sessions
    .filter((s) => s.overall === "COMPLETED")
    .sort((a, b) => (a.stops.at(-1)?.eta ?? 0) - (b.stops.at(-1)?.eta ?? 0));

  const active = sessions
    .filter((s) => s.overall !== "COMPLETED")
    .sort((a, b) => STATUS_PRIORITY[b.overall] - STATUS_PRIORITY[a.overall]);

  const primary = active[0] ?? sessions[sessions.length - 1];

  return {
    type: "STATE",
    session_id: primary.session_id,
    version: primary.version,
    overall: primary.overall,
    stops: [...completed, ...active].flatMap((s) => s.stops),
  };
}

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
  const lastVersionRef = useRef<Map<string, number>>(new Map());
  const sessionStatesRef = useRef<Map<string, TripStateMsg>>(new Map());

  // Reconnect / RESUME state
  const cancelledRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track last known values for RESUME
  const lastSessionIdRef = useRef<string | null>(null);
  const lastStateVersionRef = useRef<number>(-1);
  const lastLocationRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!wsPath || !ROUTE_SAVE_WS) return;

    cancelledRef.current = false;
    retryCountRef.current = 0;

    function connect() {
      if (cancelledRef.current) return;

      const url = `${ROUTE_SAVE_WS}${wsPath}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);

        // On reconnect (not first connect), send RESUME
        if (retryCountRef.current > 0 && lastSessionIdRef.current) {
          const loc = lastLocationRef.current;
          ws.send(JSON.stringify({
            type: "RESUME",
            session_id: lastSessionIdRef.current,
            state_version: lastStateVersionRef.current,
            lat: loc?.lat ?? 0,
            lng: loc?.lng ?? 0,
          }));
        }
        retryCountRef.current = 0;
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
            const prev = lastVersionRef.current.get(state.session_id) ?? -1;
            if (state.version <= prev) return;
            lastVersionRef.current.set(state.session_id, state.version);
            sessionStatesRef.current.set(state.session_id, state);
            lastSessionIdRef.current = state.session_id;
            lastStateVersionRef.current = state.version;
            setTripState(mergeSessionStates(sessionStatesRef.current));
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

        if (cancelledRef.current) return;

        const delay = BACKOFF_MS[Math.min(retryCountRef.current, BACKOFF_MS.length - 1)];
        retryCountRef.current += 1;
        retryTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelledRef.current = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
      lastVersionRef.current.clear();
      sessionStatesRef.current.clear();
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
      lastLocationRef.current = { lat, lng };
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
    cancelledRef.current = true;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
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
