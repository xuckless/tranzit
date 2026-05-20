import React, { useState, useCallback, useEffect, useMemo, useRef, memo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { ScrollView } from "react-native-gesture-handler";
import { Marker, Callout } from "react-native-maps";
import { supabase } from "@/lib/supabase";
import type { StopTimeUpdate, TripUpdate } from "@/types/database";
import { theme } from "@/styles/theme";

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function parseWKTPoint(
  wkt: string,
): { latitude: number; longitude: number } | null {
  const m = wkt.match(/POINT\s*\(\s*([-\d.]+)[,\s]+([-\d.]+)\s*\)/i);
  if (!m) return null;
  return { longitude: parseFloat(m[1]), latitude: parseFloat(m[2]) };
}

function fmtEpoch(epoch: number): string {
  return new Date(epoch * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDelay(seconds: number | null): { label: string; color: string } {
  if (seconds === null || Math.abs(seconds) < 60)
    return { label: "On Time", color: "#2E7D32" };
  const mins = Math.round(seconds / 60);
  return {
    label: mins > 0 ? `+${mins} min` : `${Math.abs(mins)} min early`,
    color: mins > 0 ? theme.colors.error : "#1565C0",
  };
}

// Excludes null, undefined, and the -1 "already happened" sentinel
const isValidEpoch = (t: number | null | undefined): t is number =>
  t != null && t > 0;

// ─── Types ────────────────────────────────────────────────────────────────────

interface BusEntry {
  key: string;
  route_id: string;
  arrival_time: number | null;
  departure_time: number | null;
  arrival_delay: number | null;
  departure_delay: number | null;
}

export interface StopMarkerProps {
  teleride_number: number;
  stop_name: string;
  point: string; // WKT: POINT(lng lat)
}

// ─── BusRow ───────────────────────────────────────────────────────────────────

function BusRow({ bus, dimmed }: { bus: BusEntry; dimmed: boolean }) {
  const now = Math.floor(Date.now() / 1000);

  // ── Arrival line ──
  let arrLine: string;
  if (isValidEpoch(bus.arrival_time)) {
    arrLine = `Arrives ${fmtEpoch(bus.arrival_time)}`;
  } else {
    // arrival_time = -1 → bus has arrived
    if (isValidEpoch(bus.departure_time)) {
      arrLine = `Arrived · Departs ${fmtEpoch(bus.departure_time)}`;
    } else {
      arrLine = "Arrived";
    }
  }

  // ── Departure line (only shown when not already encoded in arrLine) ──
  let depLine: string | null = null;
  if (isValidEpoch(bus.arrival_time)) {
    // upcoming arrival — show departure separately
    if (isValidEpoch(bus.departure_time)) {
      depLine = `Departs ${fmtEpoch(bus.departure_time)}`;
    } else if (bus.departure_time === -1) {
      depLine = "Departed";
    }
  } else if (bus.arrival_time === -1 && bus.departure_time === -1) {
    depLine = "Departed";
  }
  // If arrLine already contains "Departs …" we skip the separate dep line

  // ── Delay: use departure_delay when bus has arrived, arrival_delay otherwise ──
  const relevantDelay =
    bus.arrival_time === -1 ? bus.departure_delay : bus.arrival_delay;
  const delay = fmtDelay(relevantDelay);

  // ── Past: "Departed" departure was within 15 min (valid past epoch) ──
  const isDeparted =
    isValidEpoch(bus.departure_time) && bus.departure_time < now;

  return (
    <View style={[s.busRow, dimmed && s.busRowDimmed]}>
      <View style={[s.routeBadge, dimmed && s.routeBadgeDimmed]}>
        <Text style={[s.routeLabel, dimmed && s.routeLabelDimmed]} numberOfLines={1}>
          {bus.route_id}
        </Text>
      </View>

      <View style={s.timeBlock}>
        <Text style={[s.timePrimary, dimmed && s.timeDimmed]} numberOfLines={1}>
          {arrLine}
        </Text>
        {depLine != null && (
          <Text style={[s.timeSecondary, dimmed && s.timeDimmed]} numberOfLines={1}>
            {depLine}
          </Text>
        )}
      </View>

      {!dimmed && !isDeparted && (
        <Text style={[s.delayLabel, { color: delay.color }]} numberOfLines={1}>
          {delay.label}
        </Text>
      )}

      {(dimmed || isDeparted) && (
        <View style={s.pastPill}>
          <Text style={s.pastPillText}>Past</Text>
        </View>
      )}
    </View>
  );
}

// ─── StopMarker ───────────────────────────────────────────────────────────────

function StopMarkerComponent({
  teleride_number,
  stop_name,
  point,
}: StopMarkerProps) {
  const coordinate = useMemo(() => parseWKTPoint(point), [point]);

  const [upcoming, setUpcoming] = useState<BusEntry[]>([]);
  const [past, setPast] = useState<BusEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const calloutOpenRef = useRef(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollingRef.current !== null) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const fetchUpcoming = useCallback(async () => {
    setLoading(true);

    const now = Math.floor(Date.now() / 1000);
    const fifteenMinAgo = now - 900;
    const fiveMinAgo = now - 300;

    const { data: rawStus } = await supabase
      .from("stop_time_updates")
      .select("*")
      .eq("stop_id", String(teleride_number))
      .neq("schedule_relationship", "NO_DATA")
      .limit(50);

    const stus = rawStus as StopTimeUpdate[] | null;

    if (!stus?.length) {
      setUpcoming([]);
      setPast([]);
      setLoading(false);
      return;
    }

    // Join trip_updates to resolve route_id (bus number)
    const { data: rawTrips } = await supabase
      .from("trip_updates")
      .select("trip_id, route_id")
      .in(
        "trip_id",
        stus.map((s) => s.trip_id),
      );
    const trips = rawTrips as Pick<TripUpdate, "trip_id" | "route_id">[] | null;
    const routeMap = new Map(trips?.map((t) => [t.trip_id, t.route_id]) ?? []);

    const upcomingEntries: BusEntry[] = [];
    const pastEntries: BusEntry[] = [];

    for (const s of stus) {
      const arr = s.arrival_time;
      const dep = s.departure_time;

      const entry: BusEntry = {
        key: `${s.trip_id}-${s.stop_sequence}`,
        route_id: routeMap.get(s.trip_id) ?? "—",
        arrival_time: arr,
        departure_time: dep,
        arrival_delay: s.arrival_delay,
        departure_delay: s.departure_delay,
      };

      if (isValidEpoch(arr) && arr > fiveMinAgo) {
        // Upcoming: bus not yet arrived, within 5-min lookback
        upcomingEntries.push(entry);
      } else if (arr === -1) {
        if (isValidEpoch(dep) && dep >= now) {
          // At stop: arrived, departure still in future
          upcomingEntries.push(entry);
        } else if (isValidEpoch(dep) && dep >= fifteenMinAgo) {
          // Recently departed (valid epoch, within 15 min)
          pastEntries.push(entry);
        } else if (dep === -1) {
          // Fully past: arrival=-1, departure=-1
          pastEntries.push(entry);
        }
      }
    }

    // Sort upcoming ascending by soonest relevant time
    upcomingEntries.sort((a, b) => {
      const tA = isValidEpoch(a.arrival_time)
        ? a.arrival_time
        : isValidEpoch(a.departure_time)
          ? a.departure_time
          : Infinity;
      const tB = isValidEpoch(b.arrival_time)
        ? b.arrival_time
        : isValidEpoch(b.departure_time)
          ? b.departure_time
          : Infinity;
      return tA - tB;
    });

    // Sort past descending (most recently departed first), cap at 5
    pastEntries.sort((a, b) => {
      const tA = isValidEpoch(a.departure_time) ? a.departure_time : 0;
      const tB = isValidEpoch(b.departure_time) ? b.departure_time : 0;
      return tB - tA;
    });

    setUpcoming(upcomingEntries);
    setPast(pastEntries.slice(0, 5));
    setLoading(false);
  }, [teleride_number]);

  // Clean up interval on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  if (!coordinate) return null;

  const isEmpty = !loading && upcoming.length === 0 && past.length === 0;

  return (
    <Marker
      coordinate={coordinate}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={false}
      onPress={() => {
        calloutOpenRef.current = true;
        fetchUpcoming();
        if (pollingRef.current === null) {
          pollingRef.current = setInterval(fetchUpcoming, 30_000);
        }
      }}
      onDeselect={() => {
        calloutOpenRef.current = false;
        stopPolling();
      }}
    >
      <View style={s.dot} />

      <Callout tooltip>
        <View style={s.callout}>
          <Text style={s.calloutTitle} numberOfLines={2}>
            {stop_name}
          </Text>
          <Text style={s.calloutSub}>Stop #{teleride_number}</Text>

          <View style={s.contentArea}>
          {loading ? (
            <ActivityIndicator
              size="small"
              color={theme.colors.primary}
            />
          ) : isEmpty ? (
            <Text style={s.empty}>No service data</Text>
          ) : (
            <ScrollView
              style={s.scroll}
              showsVerticalScrollIndicator={false}
            >
              {upcoming.length > 0 && (
                <>
                  <Text style={s.sectionLabel}>Upcoming</Text>
                  {upcoming.map((bus) => (
                    <BusRow key={bus.key} bus={bus} dimmed={false} />
                  ))}
                </>
              )}

              {past.length > 0 && (
                <>
                  {upcoming.length > 0 && <View style={s.sectionDivider} />}
                  <Text style={s.sectionLabel}>Past</Text>
                  {past.map((bus) => (
                    <BusRow key={bus.key} bus={bus} dimmed />
                  ))}
                </>
              )}
            </ScrollView>
          )}
          </View>
        </View>
      </Callout>
    </Marker>
  );
}

export const StopMarker = memo(StopMarkerComponent);

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.primary,
    borderWidth: 2,
    borderColor: "white",
  },

  // ── Callout shell ──
  callout: {
    width: 282,
    padding: 12,
    backgroundColor: "white",
    borderRadius: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  calloutTitle: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: "#1A1C1F",
    marginBottom: 2,
  },
  calloutSub: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    marginBottom: 8,
  },
  loader: { marginVertical: 12 },
  empty: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    textAlign: "center",
    paddingVertical: 8,
  },
  contentArea: {
    height: 200,
    justifyContent: "center" as const,
  },
  scroll: { flex: 1 },

  // ── Section labels ──
  sectionLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: theme.colors.text,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 4,
    marginTop: 2,
  },
  sectionDivider: {
    height: 1,
    backgroundColor: theme.colors.muted,
    marginVertical: 8,
  },

  // ── Bus row ──
  busRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  busRowDimmed: { opacity: 0.55 },

  routeBadge: {
    backgroundColor: theme.colors.primary,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    minWidth: 46,
    alignItems: "center",
    flexShrink: 0,
  },
  routeBadgeDimmed: { backgroundColor: theme.colors.text },
  routeLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "white",
  },
  routeLabelDimmed: { color: "white" },

  timeBlock: {
    flex: 1,
    gap: 1,
  },
  timePrimary: {
    fontSize: 11,
    fontWeight: "600",
    color: "#1A1C1F",
  },
  timeSecondary: {
    fontSize: 10,
    fontWeight: "500",
    color: theme.colors.text,
  },
  timeDimmed: { color: theme.colors.text },

  delayLabel: {
    fontSize: 10,
    fontWeight: "700",
    flexShrink: 0,
    textAlign: "right",
  },

  pastPill: {
    backgroundColor: theme.colors.muted,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    flexShrink: 0,
  },
  pastPillText: {
    fontSize: 10,
    fontWeight: "600",
    color: theme.colors.text,
  },
});
