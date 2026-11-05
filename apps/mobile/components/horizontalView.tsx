import { ScrollView, View, StyleSheet } from "react-native";
import { useTheme } from "@/contexts/ThemeContext";

export default function HorizontalView({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: object;
}) {
  const { theme } = useTheme();

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
    flexGrow: 0,
  },
});
