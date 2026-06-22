import type { ReactNode } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";

/**
 * Shared scaffold for auth screens: keyboard-avoiding scroll view, the Tranzit
 * logo mark, a title/subtitle, and an optional back affordance for secondary
 * steps (2FA, email verification, password reset). Children render the step body.
 */
export function AuthScaffold({
  title,
  subtitle,
  onBack,
  children,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);
  const { colors } = theme;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {onBack ? (
          <TouchableOpacity
            style={styles.backRow}
            onPress={onBack}
            activeOpacity={0.7}
          >
            <Ionicons name="chevron-back" size={20} color={colors.ink2} />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.logoMark}>
            <Ionicons name="bus" size={28} color={colors.onPrimary} />
          </View>
        )}

        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}

        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
