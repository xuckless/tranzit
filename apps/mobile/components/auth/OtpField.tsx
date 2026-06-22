import { View, Text, TextInput } from "react-native";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";

/**
 * Numeric one-time-code input used by every verification step (email code,
 * 2FA, password reset). Uses the OS one-time-code autofill where available.
 */
export function OtpField({
  label = "Verification code",
  value,
  onChangeText,
  placeholder = "123456",
  autoFocus = true,
}: {
  label?: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);
  const { colors } = theme;

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.ink3}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={8}
        autoFocus={autoFocus}
      />
    </View>
  );
}
