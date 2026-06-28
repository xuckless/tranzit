import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  listRecentSearches,
  pruneRemoteHistory,
  pushPendingSearchHistory,
  recordSearch,
  syncRecentSearchesFromRemote,
  type RecentSearch,
  type SearchHistoryInput,
} from "@/lib/searchHistory";

/**
 * Record-search hook for the search chokepoints (map / routes / nearby / saved).
 * `record` is fire-and-forget at the call site — robustness (offline outbox,
 * dedup, cap) lives in the orchestrator. No-ops when signed out.
 */
export function useSearchHistory() {
  const { user } = useAuth();
  const record = useCallback(
    (input: SearchHistoryInput) => {
      if (user) void recordSearch(user, input);
    },
    [user],
  );
  return { record };
}

/**
 * One-shot startup sync: drains the offline outbox, prunes remote history to the
 * cap, and hydrates the local mirror from remote (so recents follow the account
 * across devices). Mount once near the app root.
 */
export function useSearchHistorySync(): void {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) return;
    void (async () => {
      await pushPendingSearchHistory(user);
      await pruneRemoteHistory(user);
      await syncRecentSearchesFromRemote(user);
    })();
  }, [user]);
}

/**
 * Recent searches for the search bars. Reads the local mirror (instant,
 * offline-safe); `refresh()` re-reads it so a just-recorded search shows up.
 * Returns `[]` when signed out.
 */
export function useRecentSearches(limit = 8) {
  const { user } = useAuth();
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!user) {
      setRecents([]);
      return;
    }
    void listRecentSearches(user, limit).then((r) => {
      if (mounted.current) setRecents(r);
    });
  }, [user, limit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { recents, refresh };
}
