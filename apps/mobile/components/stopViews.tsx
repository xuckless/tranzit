import { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import { ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { middlewareQuery } from "@/lib/middleware";
import type { StopTimeUpdate, TripUpdate } from "@/types/database";
import { theme } from "@/styles/theme";
import { useTheme } from "@/contexts/ThemeContext";

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

const isValidEpoch = (t: number | null | undefined): t is number =>
  t != null && t > 0;

// ─── Types ────────────────────────────────────────────────────────────────────

interface BusEntry {
  key: string;
  trip_id: string;
  route_id: string;
  arrival_time: number | null;
  departure_time: number | null;
  arrival_delay: number | null;
  departure_delay: number | null;
}

// ─── BusRow ───────────────────────────────────────────────────────────────────

function BusRow({
  bus,
  dimmed,
  onPress,
}: {
  bus: BusEntry;
  dimmed: boolean;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  const now = Math.floor(Date.now() / 1000);

  let arrLine: string;
  if (isValidEpoch(bus.arrival_time)) {
    arrLine = `Arrives ${fmtEpoch(bus.arrival_time)}`;
  } else {
    if (isValidEpoch(bus.departure_time)) {
      arrLine = `Arrived · Departs ${fmtEpoch(bus.departure_time)}`;
    } else {
      arrLine = "Arrived";
    }
  }

  let depLine: string | null = null;
  if (isValidEpoch(bus.arrival_time)) {
    if (isValidEpoch(bus.departure_time)) {
      depLine = `Departs ${fmtEpoch(bus.departure_time)}`;
    } else if (bus.departure_time === -1) {
      depLine = "Departed";
    }
  } else if (bus.arrival_time === -1 && bus.departure_time === -1) {
    depLine = "Departed";
  }

  const relevantDelay =
    bus.arrival_time === -1 ? bus.departure_delay : bus.arrival_delay;
  const delay = fmtDelay(relevantDelay);

  const isDeparted =
    isValidEpoch(bus.departure_time) && bus.departure_time < now;

  return (
    <TouchableOpacity
      style={[s.busRow, { borderBottomColor: colors.divider }]}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={onPress ? 0.65 : 1}
    >
      <View style={[s.routeBadge, { backgroundColor: dimmed ? colors.ink3 : colors.primary }]}>
        <Text style={s.routeLabel} numberOfLines={1}>
          {bus.route_id}
        </Text>
      </View>

      <View style={s.timeBlock}>
        <Text
          style={[s.timePrimary, { color: dimmed ? colors.ink3 : colors.ink }]}
          numberOfLines={1}
        >
          {arrLine}
        </Text>
        {depLine != null && (
          <Text style={[s.timeSecondary, { color: colors.ink3 }]} numberOfLines={1}>
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
        <View style={[s.pastPill, { backgroundColor: colors.surface2 }]}>
          <Text style={[s.pastPillText, { color: colors.ink3 }]}>Past</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ─── Fetch logic (shared by StopDetailsPanel) ─────────────────────────────────

async function fetchStopSchedule(
  teleride_number: number,
): Promise<{ upcoming: BusEntry[]; past: BusEntry[] }> {
  const now = Math.floor(Date.now() / 1000);
  const fifteenMinAgo = now - 900;
  const fiveMinAgo = now - 300;

  const stus = await middlewareQuery<StopTimeUpdate>("stop_time_updates", {
    stop_id: String(teleride_number),
    schedule_relationship: "neq.NO_DATA",
    limit: 50,
  });

  if (!stus.length) return { upcoming: [], past: [] };

  const uniqueTripIds = [...new Set(stus.map((s) => s.trip_id))];
  const tripRows = await middlewareQuery<Pick<TripUpdate, "trip_id" | "route_id">>(
    "trip_updates",
    {
      trip_id: `in.(${uniqueTripIds.join(",")})`,
      limit: uniqueTripIds.length,
    },
  );
  const routeMap = new Map(tripRows.map((t) => [t.trip_id, t.route_id]));

  const upcomingEntries: BusEntry[] = [];
  const pastEntries: BusEntry[] = [];

  for (const s of stus) {
    const arr = s.arrival_time;
    const dep = s.departure_time;
    const entry: BusEntry = {
      key: `${s.trip_id}-${s.stop_sequence}`,
      trip_id: s.trip_id,
      route_id: routeMap.get(s.trip_id) ?? "—",
      arrival_time: arr,
      departure_time: dep,
      arrival_delay: s.arrival_delay,
      departure_delay: s.departure_delay,
    };

    if (isValidEpoch(arr) && arr > fiveMinAgo) {
      upcomingEntries.push(entry);
    } else if (arr === -1) {
      if (isValidEpoch(dep) && dep >= now) {
        upcomingEntries.push(entry);
      } else if (isValidEpoch(dep) && dep >= fifteenMinAgo) {
        pastEntries.push(entry);
      } else if (dep === -1) {
        pastEntries.push(entry);
      }
    }
  }

  upcomingEntries.sort((a, b) => {
    const tA = isValidEpoch(a.arrival_time)
      ? a.arrival_time
      : isValidEpoch(a.departure_time) ? a.departure_time : Infinity;
    const tB = isValidEpoch(b.arrival_time)
      ? b.arrival_time
      : isValidEpoch(b.departure_time) ? b.departure_time : Infinity;
    return tA - tB;
  });

  pastEntries.sort((a, b) => {
    const tA = isValidEpoch(a.departure_time) ? a.departure_time : 0;
    const tB = isValidEpoch(b.departure_time) ? b.departure_time : 0;
    return tB - tA;
  });

  return { upcoming: upcomingEntries, past: pastEntries.slice(0, 5) };
}

// ─── StopDetailsPanel ─────────────────────────────────────────────────────────
// Rendered as a normal React View in map.tsx's bottom sheet — not a Callout.
// Fully reactive: all state updates propagate normally with no Fabric interop issues.

interface StopDetailsPanelProps {
  teleride_number: number;
  stop_name: string;
  onClose: () => void;
  onBusTap?: (tripId: string) => void;
}

export function StopDetailsPanel({
  teleride_number,
  stop_name,
  onClose,
  onBusTap,
}: StopDetailsPanelProps) {
  const { colors } = useTheme();
  const [upcoming, setUpcoming] = useState<BusEntry[]>([]);
  const [past, setPast] = useState<BusEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { upcoming: u, past: p } = await fetchStopSchedule(teleride_number);
    setUpcoming(u);
    setPast(p);
    setLoading(false);
  }, [teleride_number]);

  useEffect(() => {
    load();
    pollingRef.current = setInterval(load, 30_000);
    return () => {
      if (pollingRef.current !== null) clearInterval(pollingRef.current);
    };
  }, [load]);

  const isEmpty = !loading && upcoming.length === 0 && past.length === 0;

  return (
    <View style={[s.panel, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[s.panelHeader, { borderBottomColor: colors.border }]}>
        <View style={s.panelHeaderLeft}>
          <View style={s.panelIconBox}>
            <Ionicons name="bus" size={16} color={theme.colors.primary} />
          </View>
          <View style={s.panelTitleBlock}>
            <Text style={[s.panelTitle, { color: colors.ink }]} numberOfLines={1}>{stop_name}</Text>
            <Text style={[s.panelSub, { color: colors.ink3 }]}>Stop #{teleride_number}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="close-circle" size={22} color={colors.ink3} />
        </TouchableOpacity>
      </View>

      <View style={s.panelContent}>
        {loading ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : isEmpty ? (
          <Text style={[s.empty, { color: colors.ink3 }]}>No service data</Text>
        ) : (
          <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>
            {upcoming.length > 0 && (
              <>
                <Text style={[s.sectionLabel, { color: colors.ink3 }]}>Upcoming</Text>
                {upcoming.map((bus) => (
                  <BusRow
                    key={bus.key}
                    bus={bus}
                    dimmed={false}
                    onPress={onBusTap ? () => onBusTap(bus.trip_id) : undefined}
                  />
                ))}
              </>
            )}
            {past.length > 0 && (
              <>
                {upcoming.length > 0 && (
                  <View style={[s.sectionDivider, { backgroundColor: colors.divider }]} />
                )}
                <Text style={[s.sectionLabel, { color: colors.ink3 }]}>Past</Text>
                {past.map((bus) => (
                  <BusRow key={bus.key} bus={bus} dimmed />
                ))}
              </>
            )}
          </ScrollView>
        )}
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  // ── Panel shell ──
  panel: {
    marginHorizontal: theme.spacing.screen,
    marginBottom: 12,
    backgroundColor: "white",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  panelHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  panelIconBox: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: theme.colors.primary + "15",
    justifyContent: "center",
    alignItems: "center",
    flexShrink: 0,
  },
  panelTitleBlock: { flex: 1 },
  panelTitle: {
    fontSize: theme.fontSize.body,
    fontWeight: "700",
    color: "#1A1C1F",
  },
  panelSub: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    marginTop: 1,
  },
  panelContent: {
    height: 180,
    paddingHorizontal: 12,
    paddingVertical: 6,
    justifyContent: "center",
  },

  empty: {
    fontSize: theme.fontSize.caption,
    color: theme.colors.text,
    textAlign: "center",
    paddingVertical: 8,
  },
  scroll: { flex: 1 },

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

  busRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },

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

  timeBlock: { flex: 1, gap: 1 },
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
