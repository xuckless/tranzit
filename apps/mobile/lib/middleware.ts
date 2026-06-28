import { authHeader } from "@/lib/supabase";

const MIDDLEWARE_BASE =
  "https://tranzit-db-middleware.tailnet-example.ts.net";

interface Envelope<T> {
  table: string;
  count: number;
  limit: number;
  offset: number;
  data: T[];
}

export async function middlewareQuery<T>(
  table: string,
  params: Record<string, string | number> = {},
  signal?: AbortSignal,
): Promise<T[]> {
  const url = new URL(`${MIDDLEWARE_BASE}/api/v1/${table}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: await authHeader(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`[middleware] ${table} → ${res.status}`);
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
  const res = await fetch(url.toString(), {
    headers: await authHeader(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`[middleware] user/${table} → ${res.status}`);
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
  const res = await fetch(`${USER_BASE}/${table}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    // Surface the server's reason (503 user-DB-down, 400 constraint reject, …)
    // so best-effort callers can log something diagnosable instead of a bare code.
    const detail = await res.text().catch(() => "");
    throw new Error(
      `[middleware] POST user/${table} → ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
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
  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: await authHeader(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `[middleware] DELETE user/${table} → ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  const json: DeleteEnvelope = await res.json();
  return json.deleted;
}
