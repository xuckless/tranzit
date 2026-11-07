import { useEffect, useMemo, useState } from "react";

import { authHeader } from "@/lib/supabase";
import { MIDDLEWARE_BASE, fetchWithTimeout } from "@/lib/middleware";

// GTFS-RT service alerts served by the DB middleware at /api/v1/alerts.
// Best-effort: any failure (404 while the endpoint rolls out, offline, …)
// resolves to [] so callers simply render nothing.

export type ServiceAlert = {
  alert_id: string;
  header: string;
  description: string;
  cause: string | null;
  effect: string | null;
  severity: string | null;
  url: string | null;
  route_ids: string[];
  stop_ids: string[];
  active_start: number | null;
  active_end: number | null;
};

const REFRESH_MS = 2 * 60 * 1000;

function normalize(raw: unknown): ServiceAlert | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = r.alert_id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const arr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x) => x != null).map(String) : [];
  return {
    alert_id: String(id),
    header: str(r.header) ?? "",
    description: str(r.description) ?? "",
    cause: str(r.cause),
    effect: str(r.effect),
    severity: str(r.severity),
    url: str(r.url),
    route_ids: arr(r.route_ids),
    stop_ids: arr(r.stop_ids),
    active_start: num(r.active_start),
    active_end: num(r.active_end),
  };
}

function dedupe(alerts: ServiceAlert[]): ServiceAlert[] {
  const seen = new Set<string>();
  const out: ServiceAlert[] = [];
  for (const a of alerts) {
    if (seen.has(a.alert_id)) continue;
    seen.add(a.alert_id);
    out.push(a);
  }
  return out;
}

export async function fetchAlerts(opts?: {
  routeId?: string;
  stopId?: string;
  signal?: AbortSignal;
}): Promise<ServiceAlert[]> {
  try {
    const url = new URL(`${MIDDLEWARE_BASE}/api/v1/alerts`);
    if (opts?.routeId) url.searchParams.set("route_id", opts.routeId);
    if (opts?.stopId) url.searchParams.set("stop_id", opts.stopId);
    const res = await fetchWithTimeout(url.toString(), {
      headers: await authHeader(),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    if (!res.ok) return [];
    const json: unknown = await res.json();
    // Accept either the middleware envelope ({ data: [...] }) or a bare array.
    const list = Array.isArray(json)
      ? json
      : json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
        ? ((json as { data: unknown[] }).data)
        : [];
    const now = Date.now() / 1000;
    return dedupe(
      list
        .map(normalize)
        .filter((a): a is ServiceAlert => a != null)
        .filter((a) => a.active_end == null || a.active_end > now),
    );
  } catch {
    return [];
  }
}

/**
 * Active alerts affecting any of `routeIds` (route_id or short name — passed
 * straight to the backend filter). Refetches every 2 minutes; deduped by
 * alert_id. An empty list means "no filter → nothing to show" and fetches
 * nothing.
 */
export function useAlerts(routeIds: string[]): {
  alerts: ServiceAlert[];
  loading: boolean;
} {
  const key = useMemo(
    () => Array.from(new Set(routeIds.filter(Boolean))).sort().join(","),
    [routeIds],
  );
  const [alerts, setAlerts] = useState<ServiceAlert[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setAlerts([]);
      setLoading(false);
      return;
    }
    let controller: AbortController | null = null;
    let cancelled = false;
    const load = async (first: boolean) => {
      controller?.abort();
      const c = new AbortController();
      controller = c;
      if (first) setLoading(true);
      const results = await Promise.all(
        ids.map((routeId) => fetchAlerts({ routeId, signal: c.signal })),
      );
      if (cancelled || c.signal.aborted) return;
      setAlerts(dedupe(results.flat()));
      setLoading(false);
    };
    void load(true);
    const timer = setInterval(() => void load(false), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [key]);

  return { alerts, loading };
}
