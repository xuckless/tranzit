import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/contexts/ThemeContext";
import { makeAuthStyles } from "@/components/auth/authStyles";

/**
 * Lightweight, dependency-free password strength estimate for UI guidance only.
 * Supabase enforces the real password policy server-side (min length / strength
 * per project settings); this just nudges the user. Returns null for empty input.
 */
type Strength = { label: string; level: "weak" | "fair" | "strong" };

function strengthHint(pw: string): Strength | null {
  if (!pw) return null;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 2) return { label: "Weak password", level: "weak" };
  if (score === 3) return { label: "Fair password", level: "fair" };
  return { label: "Strong password", level: "strong" };
}

/**
 * Password input with a show/hide eye toggle and an optional strength hint
 * (used on sign-up and new-password steps, not on the plain sign-in field).
 */
export function PasswordField({
  label,
  value,
  onChangeText,
  placeholder,
  showStrength = false,
  textContentType = "password",
  autoFocus,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  showStrength?: boolean;
  textContentType?: "password" | "newPassword";
  autoFocus?: boolean;
}) {
  const { theme } = useTheme();
  const styles = makeAuthStyles(theme);
  const { colors } = theme;
  const [visible, setVisible] = useState(false);

  const hint = showStrength ? strengthHint(value) : null;
  const hintColor = hint
    ? hint.level === "weak"
      ? colors.danger
      : hint.level === "fair"
        ? colors.ink3
        : colors.primary
    : undefined;

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.inputRowInput}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.ink3}
          secureTextEntry={!visible}
          autoCapitalize="none"
          autoCorrect={false}
          textContentType={textContentType}
          autoFocus={autoFocus}
        />
        <TouchableOpacity
          style={styles.eyeBtn}
          onPress={() => setVisible((v) => !v)}
          hitSlop={8}
          accessibilityLabel={visible ? "Hide password" : "Show password"}
        >
          <Ionicons
            name={visible ? "eye-off-outline" : "eye-outline"}
            size={20}
            color={colors.ink3}
          />
        </TouchableOpacity>
      </View>
      {hint ? (
        <Text style={[styles.hint, { color: hintColor }]}>{hint.label}</Text>
      ) : null}
    </View>
  );
}
