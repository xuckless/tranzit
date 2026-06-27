import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import type { Database } from '../types/database';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to your .env.local (Supabase dashboard → Project Settings → API).',
  );
}

// ── Chunked SecureStore adapter ──────────────────────────────────────────────
// expo-secure-store caps each value at ~2 KB on iOS, but a Supabase session
// (access + refresh tokens + user object) easily exceeds that. This adapter
// transparently splits a value across numbered keys (`${key}.0`, `${key}.1`, …)
// and stores the chunk *count* under the base key, reassembling on read.
// A legacy single-key value (non-numeric head) is returned verbatim, so existing
// sessions keep working after the upgrade.
const CHUNK_SIZE = 1800; // headroom under the 2048-byte iOS limit

async function clearChunks(key: string, count: number): Promise<void> {
  const deletions: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    deletions.push(SecureStore.deleteItemAsync(`${key}.${i}`));
  }
  await Promise.all(deletions);
}

const ChunkedSecureStoreAdapter = {
  async getItem(key: string): Promise<string | null> {
    const head = await SecureStore.getItemAsync(key);
    if (head == null) return null;
    // Legacy, non-chunked value (e.g. a raw JSON session) — return as-is.
    if (!/^\d+$/.test(head)) return head;
    const count = parseInt(head, 10);
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`);
      if (part == null) return null; // partial/corrupt write — treat as missing
      parts.push(part);
    }
    return parts.join('');
  },

  async setItem(key: string, value: string): Promise<void> {
    // Drop chunks from any previous (possibly larger) write first.
    const prevHead = await SecureStore.getItemAsync(key);
    if (prevHead != null && /^\d+$/.test(prevHead)) {
      await clearChunks(key, parseInt(prevHead, 10));
    }
    const count = Math.max(1, Math.ceil(value.length / CHUNK_SIZE));
    const writes: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      writes.push(
        SecureStore.setItemAsync(
          `${key}.${i}`,
          value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        ),
      );
    }
    await Promise.all(writes);
    // Write the head (chunk count) last so a reader never sees a stale count.
    await SecureStore.setItemAsync(key, String(count));
  },

  async removeItem(key: string): Promise<void> {
    const head = await SecureStore.getItemAsync(key);
    if (head != null && /^\d+$/.test(head)) {
      await clearChunks(key, parseInt(head, 10));
    }
    await SecureStore.deleteItemAsync(key);
  },
};

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: ChunkedSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    // Required for React Native — disables URL-based OAuth session detection.
    // We complete OAuth/email links manually via exchangeCodeForSession.
    detectSessionInUrl: false,
  },
});
