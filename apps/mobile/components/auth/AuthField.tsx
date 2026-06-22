import { View, Text, TextInput, type TextInputProps } from "react-native";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";

/**
 * Labeled text input used across the auth screens. Forwards any TextInput prop
 * so callers control keyboard type, autoCapitalize, textContentType, etc.
 */
export function AuthField({
  label,
  ...inputProps
}: { label: string } & TextInputProps) {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);
  const { colors } = theme;

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.ink3}
        {...inputProps}
      />
    </View>
  );
}
