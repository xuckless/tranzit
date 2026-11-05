import * as Linking from "expo-linking";
import { supabase } from "@/lib/supabase";

/**
 * Pull auth params out of a redirect URL. Supabase's PKCE flow returns `?code=…`
 * in the query string; some flows (and errors) ride the URL fragment (`#…`). We
 * merge both so callers don't have to care which the provider used.
 */
export function authParamsFromUrl(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const { queryParams } = Linking.parse(url);
  for (const [k, v] of Object.entries(queryParams ?? {})) {
    if (typeof v === "string") out[k] = v;
  }
  const hash = url.split("#")[1];
  if (hash) {
    for (const pair of hash.split("&")) {
      const [k, v] = pair.split("=");
      if (k) out[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
  }
  return out;
}

/**
 * Complete a Supabase auth deep link (email confirmation, password recovery, or
 * an OAuth redirect). PKCE: exchange the `code` for a session. Implicit fallback:
 * set the session from access/refresh tokens in the fragment.
 *
 * Returns `true` when a session was established, `false` when the URL carried no
 * auth payload (so unrelated deep links are ignored). Throws on a provider error.
 */
export async function completeAuthFromUrl(url: string): Promise<boolean> {
  const params = authParamsFromUrl(url);

  if (params.error || params.error_description) {
    throw new Error(params.error_description || params.error);
  }

  if (params.code) {
    const { error } = await supabase.auth.exchangeCodeForSession(params.code);
    if (error) throw error;
    return true;
  }

  if (params.access_token && params.refresh_token) {
    const { error } = await supabase.auth.setSession({
      access_token: params.access_token,
      refresh_token: params.refresh_token,
    });
    if (error) throw error;
    return true;
  }

  return false;
}
