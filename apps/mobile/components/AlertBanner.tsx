import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { useTheme } from "@/contexts/ThemeContext";
import { useAlerts, type ServiceAlert } from "@/lib/alerts";

/** Header + description + optional link for each alert. Shared by the banner and the Map alerts sheet. */
export function AlertList({ alerts }: { alerts: ServiceAlert[] }) {
  const { theme } = useTheme();
  return (
    <View style={{ gap: theme.spacing.element }}>
      {alerts.map((a) => (
        <View
          key={a.alert_id}
          style={[
            styles.item,
            { borderColor: theme.colors.border, paddingTop: theme.spacing.element },
          ]}
        >
          <Text style={[theme.typography.bodySmallStrong, { color: theme.colors.ink }]}>
            {a.header || "Service alert"}
          </Text>
          {!!a.description && (
            <Text
              style={[theme.typography.bodySmall, { color: theme.colors.ink2, marginTop: 2 }]}
            >
              {a.description}
            </Text>
          )}
          {!!a.url && (
            <Pressable
              onPress={() => {
                Linking.openURL(a.url!).catch(() => {});
              }}
              accessibilityRole="link"
              accessibilityLabel={`More info about ${a.header || "this alert"}`}
              hitSlop={12}
            >
              <Text
                style={[
                  theme.typography.captionStrong,
                  { color: theme.colors.primary, marginTop: 4 },
                ]}
              >
                More info
              </Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

export default function AlertBanner({
  routeIds,
  compact,
}: {
  routeIds: string[];
  compact?: boolean;
}) {
  const { theme } = useTheme();
  const { alerts } = useAlerts(routeIds);
  const [expanded, setExpanded] = useState(false);

  if (alerts.length === 0) return null;

  const n = alerts.length;
  const title = `⚠ ${n} service alert${n === 1 ? "" : "s"}`;
  const first = alerts[0].header;

  return (
    <View
      style={[
        styles.banner,
        {
          backgroundColor: theme.semantic.warningBg,
          borderColor: theme.semantic.warning,
          borderRadius: theme.radii.chip,
          paddingHorizontal: compact ? 10 : theme.spacing.card,
          paddingVertical: compact ? 8 : 12,
        },
      ]}
    >
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={`${title}. ${first}`}
        accessibilityHint={expanded ? "Collapse alerts" : "Show alert details"}
        accessibilityState={{ expanded }}
        hitSlop={8}
      >
        <View style={styles.row}>
          <Text
            style={[theme.typography.bodySmallStrong, { color: theme.semantic.warningInk }]}
          >
            {title}
          </Text>
          <Text style={[theme.typography.caption, { color: theme.semantic.warningInk }]}>
            {expanded ? "Hide" : "Details"}
          </Text>
        </View>
        {!expanded && !!first && (
          <Text
            numberOfLines={compact ? 1 : 2}
            style={[theme.typography.bodySmall, { color: theme.colors.ink, marginTop: 2 }]}
          >
            {first}
          </Text>
        )}
      </Pressable>
      {expanded && (
        <View style={{ marginTop: theme.spacing.xs }}>
          <AlertList alerts={alerts} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { borderWidth: 1 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  item: { borderTopWidth: StyleSheet.hairlineWidth },
});
