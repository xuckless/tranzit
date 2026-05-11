import { ScrollView, View, Text, StyleSheet } from "react-native";
import { theme } from "@/styles/theme";

export default function HorizontalView({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  return (
    <ScrollView
      horizontal
      style={[styles.container, style]}
      contentContainerStyle={{
        alignItems: "center",
        gap: theme.spacing.element,
      }}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
