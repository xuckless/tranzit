import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  deletePlace,
  fetchSavedPlaces,
  type SavedPlace,
} from "@/lib/savedPlaces";

/**
 * Saved places for the signed-in user. Renders the SQLite mirror first (instant,
 * offline-safe) while `fetchSavedPlaces` refreshes from the user DB. `remove`
 * deletes optimistically and restores on failure.
 */
export function useSavedPlaces() {
  const { user } = useAuth();
  const [data, setData] = useState<SavedPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!user) {
      setData([]);
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const next = await fetchSavedPlaces(user);
      if (mounted.current) setData(next);
    } catch {
      if (mounted.current) setError("Failed to load saved places.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = useCallback(
    async (categoryCode: string) => {
      if (!user) return;
      setData((prev) => prev.filter((p) => p.categoryCode !== categoryCode));
      try {
        await deletePlace(user, categoryCode);
      } catch {
        await load(); // restore the list if the delete failed
      }
    },
    [user, load],
  );

  return { data, loading, error, refresh: load, remove };
}

/**
 * Quick-access places for the Map. With one address per category, every saved
 * place is a quick-access candidate.
 */
export function useQuickAccess() {
  const { user } = useAuth();
  const [data, setData] = useState<SavedPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    if (!user) {
      setData([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchSavedPlaces(user)
      .then((d) => {
        if (active) setData(d);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, refresh };
}
