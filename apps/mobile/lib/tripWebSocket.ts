import { useState, useEffect, useRef, useCallback } from "react";
import type { TripStateMsg, TripRerouteMsg, TripNotifyMsg, ServerStopStatus } from "@/types/trip";
import { ROUTE_SAVE_URL } from "@/lib/config";
import { getAccessToken } from "@/lib/supabase";

const ROUTE_SAVE_WS = ROUTE_SAVE_URL.replace(/^http/, "ws");

const STATUS_PRIORITY: Record<ServerStopStatus, number> = {
  ACTIVE: 4, UNSURE: 3, EXPECTED: 2, MISSED: 1, COMPLETED: 0,
};

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

// ─── Module-level outbox for out-of-component sends ───────────────────────────
// An UNSURE_RESPONSE can originate from a boarding push-notification action that
// is handled in the root layout — outside the screen that owns the socket. Route
// Save's only client-input channel is the trip WebSocket (there is no REST
// unsure-response endpoint), so queue such messages here and flush them over the
// live socket. If the socket is momentarily down, the message waits and is
// flushed by the hook on the next connect.
let _activeWs: WebSocket | null = null;
const _outbox: object[] = [];

function flushOutbox(): void {
  if (!_activeWs || _activeWs.readyState !== WebSocket.OPEN) return;
  while (_outbox.length) {
    _activeWs.send(JSON.stringify(_outbox.shift()));
  }
}

/**
 * Send an UNSURE_RESPONSE from outside the commute screen (e.g. a boarding
 * notification action handled in the root layout). Delivered over the live trip
 * WebSocket per the Route Save protocol; queued and flushed on reconnect if the
 * socket is briefly unavailable.
 */
export function submitUnsureResponse(stopId: string, boarded: boolean): void {
  _outbox.push({ type: "UNSURE_RESPONSE", stop_id: stopId, boarded });
  flushOutbox();
}

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
  const clockOffsetRef = useRef(0);

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

    function scheduleReconnect() {
      if (cancelledRef.current) return;
      const delay = BACKOFF_MS[Math.min(retryCountRef.current, BACKOFF_MS.length - 1)];
      retryCountRef.current += 1;
      retryTimerRef.current = setTimeout(() => void connect(), delay);
    }

    async function connect() {
      if (cancelledRef.current) return;

      // Route Save verifies the Supabase JWT on the WS upgrade via ?token= — the RN
      // WebSocket can't set an Authorization header, so it rides the query string.
      // Fetched fresh per (re)connect so a long-running trip never dials with a
      // stale token.
      const token = await getAccessToken();
      if (cancelledRef.current) return;
      if (!token) {
        // Signed out / session not ready — back off and retry rather than dialing
        // unauthenticated (the server would reject the upgrade anyway).
        scheduleReconnect();
        return;
      }

      const url = `${ROUTE_SAVE_WS}${wsPath}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      _activeWs = ws;

      ws.onopen = () => {
        setIsConnected(true);

        // Deliver any UNSURE_RESPONSE captured out-of-component (notification action).
        flushOutbox();

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
            const refStop = state.stops.find(
              (s) =>
                (s.status === "ACTIVE" || s.status === "EXPECTED" || s.status === "UNSURE") &&
                s.time_remaining_s > 0,
            );
            if (refStop) {
              clockOffsetRef.current =
                (refStop.eta - refStop.time_remaining_s) - Date.now() / 1000;
            }
            setTripState(mergeSessionStates(sessionStatesRef.current));
            break;
          }
          case "REROUTE":
            // A reroute restarts the trip plan. The next STATE may carry a reset
            // (or lower) version, so clear per-session version/state tracking to
            // guarantee it is accepted. We intentionally do NOT null tripState:
            // the timeline keeps its current data (no flash to a placeholder) and
            // advances when the next live STATE arrives. The new route is buffered
            // in lastReroute for the commute screen to apply on a manual Refresh.
            lastVersionRef.current.clear();
            sessionStatesRef.current.clear();
            lastStateVersionRef.current = -1;
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
        if (_activeWs === ws) _activeWs = null;

        if (cancelledRef.current) return;

        scheduleReconnect();
      };
    }

    void connect();

    return () => {
      cancelledRef.current = true;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
      _activeWs = null;
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
        ts: Math.floor(Date.now() / 1000 + clockOffsetRef.current),
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
