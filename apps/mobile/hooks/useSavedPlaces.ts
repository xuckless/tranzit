import { useCallback, useEffect, useState } from "react";
import {
  getDefaultPlaces,
  getSavedPlacesGrouped,
  setDefaultPlace,
  type CategoryWithPlaces,
  type QuickAccessPlace,
} from "@/lib/db";

export function useSavedPlaces() {
  const [data, setData] = useState<CategoryWithPlaces[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await getSavedPlacesGrouped());
    } catch {
      setError("Failed to load saved places.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const markDefault = useCallback(
    async (categoryId: number, placeId: string) => {
      await setDefaultPlace(categoryId, placeId);
      await load();
    },
    [load]
  );

  return { data, loading, error, markDefault, refresh: load };
}

export function useQuickAccess() {
  const [data, setData] = useState<QuickAccessPlace[]>([]);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setLoading(true);
    getDefaultPlaces()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { data, loading, refresh };
}
