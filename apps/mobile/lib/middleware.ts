import { authHeader } from "@/lib/supabase";

import { MIDDLEWARE_URL as MIDDLEWARE_BASE } from "@/lib/config";

// ── Request timeouts + typed errors ────────────────────────────────────────
// Every backend fetch goes through fetchWithTimeout so a hung server can't
// leave a spinner up forever, and so the UI can tell "you're offline" from
// "the server answered 502" from "it took too long".

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type RequestErrorKind = "timeout" | "offline" | "http" | "aborted";

export class RequestError extends Error {
  readonly kind: RequestErrorKind;
  readonly status: number | null;
  constructor(kind: RequestErrorKind, message: string, status: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
    // Keep the conventional name for caller aborts so existing
    // `err.name === "AbortError"` checks keep working.
    this.name = kind === "aborted" ? "AbortError" : "RequestError";
  }
}

export function isRequestError(e: unknown): e is RequestError {
  return e instanceof RequestError;
}

/**
 * Map any thrown error to a short, user-facing sentence. `noun` names what
 * failed ("routes", "arrivals", …) for the generic fallback.
 */
export function friendlyErrorMessage(e: unknown, noun = "data"): string {
  if (e instanceof RequestError) {
    switch (e.kind) {
      case "offline":
        return "You appear to be offline — check your connection.";
      case "timeout":
        return "The server took too long to respond. Please try again.";
      case "aborted":
        return "Request cancelled.";
      case "http":
        if (e.status === 401 || e.status === 403) return "Your session expired — please sign in again.";
        if (e.status === 404) return `No ${noun} found.`;
        if (e.status != null && e.status >= 500) return "Service is temporarily unavailable. Please try again shortly.";
        return `Couldn't load ${noun}. Please try again.`;
    }
  }
  return `Couldn't load ${noun}. Please try again.`;
}

/** Build an HTTP-status RequestError (for callers that inspect `res.ok`). */
export function httpError(label: string, status: number, detail = ""): RequestError {
  return new RequestError(
    "http",
    `${label} → ${status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    status,
  );
}

/**
 * fetch() with a timeout (default 15s), combined with an optional caller
 * signal. Throws RequestError: kind "aborted" (name "AbortError") when the
 * caller aborted, "timeout" when the timer fired, "offline" on network
 * failure. Does NOT throw on non-2xx — callers check `res.ok`.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const callerSignal = init.signal ?? undefined;
  if (callerSignal?.aborted) {
    throw new RequestError("aborted", "Request aborted");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (callerSignal?.aborted) throw new RequestError("aborted", "Request aborted");
    if (timedOut) throw new RequestError("timeout", `Request timed out after ${timeoutMs}ms`);
    throw new RequestError("offline", e instanceof Error ? e.message : "Network request failed");
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

interface Envelope<T> {
  table: string;
  count: number;
  limit: number;
  offset: number;
  data: T[];
}

export { MIDDLEWARE_BASE };

export async function middlewareQuery<T>(
  table: string,
  params: Record<string, string | number> = {},
  signal?: AbortSignal,
): Promise<T[]> {
  const url = new URL(`${MIDDLEWARE_BASE}/api/v1/${table}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetchWithTimeout(url.toString(), {
    headers: await authHeader(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw httpError(`[middleware] ${table}`, res.status);
  const json: Envelope<T> = await res.json();
  return json.data;
}

// ── User database (/api/v1/user/) ──────────────────────────────────────────
// A second, independent Postgres (the tailnet tranzit-user-db). Same host, the
// `/user/` prefix routes to the per-user tables (user_info, saved_addresses, …).
// If TRANZIT_USER_DB_CONNECTION_STRING is unset/unreachable the server returns
// 503 — callers must treat these as best-effort and never block the UI on them.
const USER_BASE = `${MIDDLEWARE_BASE}/api/v1/user`;

export async function middlewareUserQuery<T>(
  table: string,
  params: Record<string, string | number> = {},
  signal?: AbortSignal,
): Promise<T[]> {
  const url = new URL(`${USER_BASE}/${table}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetchWithTimeout(url.toString(), {
    headers: await authHeader(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw httpError(`[middleware] user/${table}`, res.status);
  const json: Envelope<T> = await res.json();
  return json.data;
}

interface UpsertEnvelope<T> {
  table: string;
  count: number;
  data: T[];
}

/**
 * Upsert one row or an array of rows into a user table via
 * `POST /api/v1/user/{table}` (INSERT … ON CONFLICT (pk) DO UPDATE). Returns the
 * RETURNING * rows. Identity PKs are server-generated; omit them in `body`.
 */
export async function middlewareUpsert<T>(
  table: string,
  body: object | object[],
  signal?: AbortSignal,
): Promise<T[]> {
  const res = await fetchWithTimeout(`${USER_BASE}/${table}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    // Surface the server's reason (503 user-DB-down, 400 constraint reject, …)
    // so best-effort callers can log something diagnosable instead of a bare code.
    const detail = await res.text().catch(() => "");
    throw httpError(`[middleware] POST user/${table}`, res.status, detail);
  }
  const json: UpsertEnvelope<T> = await res.json();
  return json.data;
}

interface DeleteEnvelope {
  table: string;
  deleted: number;
}

/**
 * Delete rows from a user table via `DELETE /api/v1/user/{table}?<filters>`. The
 * middleware refuses unfiltered deletes, so `params` must scope the rows (at least
 * `user_id`). Best-effort like the other user-DB calls — never block the UI on it.
 */
export async function middlewareUserDelete(
  table: string,
  params: Record<string, string | number> = {},
  signal?: AbortSignal,
): Promise<number> {
  const url = new URL(`${USER_BASE}/${table}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetchWithTimeout(url.toString(), {
    method: "DELETE",
    headers: await authHeader(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw httpError(`[middleware] DELETE user/${table}`, res.status, detail);
  }
  const json: DeleteEnvelope = await res.json();
  return json.deleted;
}
