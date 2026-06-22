import { Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";

/**
 * Primary submit button with an inline loading spinner, shared by every auth
 * step so the disabled/loading treatment stays consistent.
 */
export function AuthButton({
  label,
  onPress,
  loading = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);
  const { colors } = theme;
  const isDisabled = loading || disabled;

  return (
    <TouchableOpacity
      style={[styles.primaryBtn, isDisabled && styles.primaryBtnDisabled]}
      onPress={onPress}
      disabled={isDisabled}
      activeOpacity={0.85}
    >
      {loading ? (
        <ActivityIndicator color={colors.onPrimary} />
      ) : (
        <Text style={styles.primaryBtnText}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}
