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
  const res = await fetch(url.toString(), signal ? { signal } : undefined);
  if (!res.ok) throw new Error(`[middleware] ${table} → ${res.status}`);
  const json: Envelope<T> = await res.json();
  return json.data;
}
