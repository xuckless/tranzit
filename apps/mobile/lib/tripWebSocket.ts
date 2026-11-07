import { useState, useEffect, useRef, useCallback } from "react";
import { AppState } from "react-native";
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

// Latest GPS fix (foreground watcher or background task) and whether it still
// has to be delivered. The background location task runs outside React, so the
// fix and the server clock offset live at module scope, shared with the hook.
interface LocationFix {
  lat: number;
  lng: number;
  speedMps: number;
  headingDeg: number;
  /** Device time (ms) the fix was captured. */
  at: number;
}
let _lastFix: LocationFix | null = null;
let _fixPending = false;
let _clockOffsetS = 0;

function flushOutbox(): void {
  if (!_activeWs || _activeWs.readyState !== WebSocket.OPEN) return;
  while (_outbox.length) {
    _activeWs.send(JSON.stringify(_outbox.shift()));
  }
}

function flushLocation(): void {
  if (!_fixPending || !_lastFix) return;
  if (!_activeWs || _activeWs.readyState !== WebSocket.OPEN) return;
  const f = _lastFix;
  _activeWs.send(
    JSON.stringify({
      type: "LOCATION",
      lat: f.lat,
      lng: f.lng,
      speed_mps: f.speedMps,
      heading_deg: f.headingDeg,
      ts: Math.floor(f.at / 1000 + _clockOffsetS),
    }),
  );
  _fixPending = false;
}

/**
 * Record a GPS fix and send it as a LOCATION frame if the trip socket is open.
 * If it isn't (e.g. the OS suspended it while backgrounded), the latest fix is
 * kept and sent as soon as the socket reconnects. Used by both the foreground
 * watcher (via the hook's sendLocation) and the background location task.
 */
export function submitLocation(
  lat: number,
  lng: number,
  speedMps?: number,
  headingDeg?: number,
): void {
  _lastFix = {
    lat,
    lng,
    speedMps: speedMps != null && speedMps >= 0 ? speedMps : 0,
    headingDeg: headingDeg != null && headingDeg >= 0 ? headingDeg : 0,
    at: Date.now(),
  };
  _fixPending = true;
  flushLocation();
}

/**
 * Current time on the Route Save server clock (Unix seconds), from the offset
 * learned off the last STATE frame. Use it to tick server ETAs locally between
 * messages.
 */
export function serverNowS(deviceNowMs: number): number {
  return deviceNowMs / 1000 + _clockOffsetS;
}

/** Last fix seen this trip (foreground or background), or null. */
export function getLastLocationFix(): { lat: number; lng: number } | null {
  return _lastFix ? { lat: _lastFix.lat, lng: _lastFix.lng } : null;
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
  /** Drop any half-dead socket and dial again now (resets backoff). */
  reconnect: () => void;
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
  const forceReconnectRef = useRef<(() => void) | null>(null);

  // Reconnect / RESUME state
  const cancelledRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track last known values for RESUME
  const lastSessionIdRef = useRef<string | null>(null);
  const lastStateVersionRef = useRef<number>(-1);

  useEffect(() => {
    if (!wsPath || !ROUTE_SAVE_WS) return;

    cancelledRef.current = false;
    retryCountRef.current = 0;
    // Per-run liveness: cancelledRef is shared across runs (and reset above), so a
    // connect() from a previous wsPath still awaiting its token must check this.
    let alive = true;
    // True while connect() awaits the token, so a foreground/retry/manual trigger
    // in that window can't dial a second socket.
    let connecting = false;
    const dead = () => !alive || cancelledRef.current;

    function scheduleReconnect() {
      if (dead()) return;
      const delay = BACKOFF_MS[Math.min(retryCountRef.current, BACKOFF_MS.length - 1)];
      retryCountRef.current += 1;
      retryTimerRef.current = setTimeout(() => void connect(), delay);
    }

    async function connect() {
      if (dead() || connecting) return;
      const existing = wsRef.current;
      if (
        existing &&
        (existing.readyState === WebSocket.OPEN ||
          existing.readyState === WebSocket.CONNECTING)
      )
        return;

      // Route Save verifies the Supabase JWT on the WS upgrade via ?token= — the RN
      // WebSocket can't set an Authorization header, so it rides the query string.
      // Fetched fresh per (re)connect so a long-running trip never dials with a
      // stale token.
      connecting = true;
      let token: string | null = null;
      try {
        token = await getAccessToken();
      } catch {
        token = null;
      } finally {
        connecting = false;
      }
      if (dead()) return;
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

        // Deliver any UNSURE_RESPONSE queued while offline (in-app answer or
        // notification action).
        flushOutbox();

        // On reconnect (not first connect), send RESUME. Coordinates only when
        // we actually have a fix — never a fake 0,0.
        if (retryCountRef.current > 0 && lastSessionIdRef.current) {
          const loc = _lastFix;
          ws.send(JSON.stringify({
            type: "RESUME",
            session_id: lastSessionIdRef.current,
            state_version: lastStateVersionRef.current,
            ...(loc ? { lat: loc.lat, lng: loc.lng } : {}),
          }));
        }
        retryCountRef.current = 0;

        // A fix captured while the socket was down (e.g. background) goes now.
        flushLocation();
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
              _clockOffsetS =
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

        if (dead()) return;

        scheduleReconnect();
      };
    }

    void connect();

    // The OS suspends the socket when the app backgrounds, often without delivering an onclose, so
    // no reconnect gets armed and live STATE silently stalls. On return to foreground, force a single
    // clean reconnect if the socket isn't healthy.
    function forceReconnect() {
      if (dead()) return;
      // connect() is already awaiting a token — it will dial; don't race it.
      if (connecting) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) return; // still alive — nothing to do
      // Detach the old socket so its late onclose can't double-schedule, then reconnect once
      // (onopen sends RESUME because retryCount > 0).
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      wsRef.current = null;
      if (_activeWs === ws) _activeWs = null;
      // Keep retryCount > 0 so onopen sends RESUME, but restart the backoff ladder.
      retryCountRef.current = 1;
      void connect();
    }
    forceReconnectRef.current = forceReconnect;

    const appStateSub = AppState.addEventListener("change", (s) => {
      if (s !== "active") return;
      forceReconnect();
    });

    return () => {
      alive = false;
      cancelledRef.current = true;
      forceReconnectRef.current = null;
      appStateSub.remove();
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
      _activeWs = null;
      lastVersionRef.current.clear();
      sessionStatesRef.current.clear();
      lastSessionIdRef.current = null;
      lastStateVersionRef.current = -1;
      // A different (or no) trip next: never let the old trip's state leak into it
      // (e.g. a stale COMPLETED re-triggering the arrival card).
      setTripState(null);
      setLastReroute(null);
      setLastNotify(null);
      setIsConnected(false);
    };
  }, [wsPath]);

  const sendLocation = useCallback(
    (lat: number, lng: number, speedMps?: number, headingDeg?: number) => {
      submitLocation(lat, lng, speedMps, headingDeg);
    },
    [],
  );

  // Boarding answers must not be lost when the socket is momentarily down: go
  // through the same outbox as notification actions (flushed on reconnect).
  const sendUnsureResponse = useCallback((stopId: string, boarded: boolean) => {
    submitUnsureResponse(stopId, boarded);
  }, []);

  const reconnect = useCallback(() => {
    forceReconnectRef.current?.();
  }, []);

  const disconnect = useCallback(() => {
    cancelledRef.current = true;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const ws = wsRef.current;
    wsRef.current?.close();
    wsRef.current = null;
    if (_activeWs === ws) _activeWs = null;
    // Trip is over: nothing queued for it should be replayed into a later trip.
    _outbox.length = 0;
    _lastFix = null;
    _fixPending = false;
    setIsConnected(false);
  }, []);

  return {
    tripState,
    lastReroute,
    lastNotify,
    isConnected,
    sendLocation,
    sendUnsureResponse,
    reconnect,
    disconnect,
  };
}
