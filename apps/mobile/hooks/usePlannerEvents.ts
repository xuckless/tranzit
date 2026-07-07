import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  deleteEvent,
  fetchEvents,
  importDeviceEvents,
  saveEvent,
  type ImportResult,
  type SaveEventInput,
} from "@/lib/plannerEvents";
import { computePreRoute, recomputeUpcoming } from "@/lib/preRoutes";
import { cancelLeaveNow } from "@/lib/leaveNowNotifications";
import type { PlannedEvent } from "@/components/planner/trip";

/**
 * Planned events for the signed-in user. Renders the SQLite mirror first (instant,
 * offline-safe) while `fetchEvents` refreshes from the user DB. `save` upserts (create
 * or edit), `remove` deletes optimistically and restores on failure, `importDevice`
 * pulls the device calendar in.
 */
export function usePlannerEvents() {
  const { user } = useAuth();
  const [data, setData] = useState<PlannedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Latest event list for the pre-route origin chain, without churning callbacks.
  const dataRef = useRef<PlannedEvent[]>([]);
  dataRef.current = data;

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
      const next = await fetchEvents(user);
      if (mounted.current) setData(next);
      // Silent pre-route refresh for today's upcoming events (planner calls
      // refresh() on focus). TTL-throttled inside; re-read only when changed.
      void recomputeUpcoming(user, next).then(async (changed) => {
        if (!changed || !mounted.current) return;
        const rows = await fetchEvents(user);
        if (mounted.current) setData(rows);
      });
    } catch {
      if (mounted.current) setError("Failed to load events.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(
    async (event: SaveEventInput) => {
      if (!user) return;
      // Optimistic: edits/drags (which always carry an eventId) reflect instantly,
      // before the SQLite/network write, so a dragged card never snaps back.
      if (event.eventId) {
        const id = event.eventId;
        setData((prev) =>
          prev.map((e) =>
            e.eventId === id
              ? {
                  ...e,
                  name: event.name,
                  location: event.location,
                  locationLat: event.locationLat ?? null,
                  locationLng: event.locationLng ?? null,
                  placeId: event.placeId ?? null,
                  notes: event.notes,
                  start: event.start,
                  end: event.end,
                  timezone: event.timezone ?? e.timezone,
                  travelTime: null, // invalidated until the pre-route recomputes
                  pending: true,
                }
              : e,
          ),
        );
      }
      const saved = await saveEvent({ user, event });
      setData((prev) => {
        const i = prev.findIndex((e) => e.eventId === saved.eventId);
        if (i === -1) return [...prev, saved];
        const next = prev.slice();
        next[i] = saved;
        return next;
      });
      // Fire-and-forget pre-route (covers create, edit and drag — all land here).
      if (saved.locationLat != null) {
        void computePreRoute(user, saved, dataRef.current).then((changed) => {
          if (changed && mounted.current) void load();
        });
      } else {
        void cancelLeaveNow(saved.eventId); // coords removed → no reminder
      }
      return saved;
    },
    [user, load],
  );

  const remove = useCallback(
    async (eventId: string) => {
      if (!user) return;
      setData((prev) => prev.filter((e) => e.eventId !== eventId));
      try {
        await deleteEvent(user, eventId);
      } catch {
        await load(); // restore the list if the delete failed
      }
    },
    [user, load],
  );

  const importDevice = useCallback(async (): Promise<ImportResult> => {
    if (!user) return { granted: false, imported: 0 };
    const res = await importDeviceEvents(user);
    if (res.imported > 0) await load();
    return res;
  }, [user, load]);

  return { data, loading, error, refresh: load, save, remove, importDevice };
}
