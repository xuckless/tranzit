import { StyleSheet } from "react-native";
import type { AppTheme } from "@/styles/themes";

/**
 * Shared style sheet for every auth screen (sign-in, sign-up, forgot-password)
 * and the auth primitives. Extracted so the multi-step screens don't each carry
 * a duplicated `makeStyles`. Keep visual parity with the original screens.
 */
export function makeAuthStyles(t: AppTheme) {
  const { colors, typography, radii, spacing } = t;
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.surface,
    },
    scroll: {
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: spacing.screen + 6,
      paddingVertical: 48,
    },
    logoMark: {
      width: 56,
      height: 56,
      borderRadius: 18,
      backgroundColor: colors.primary,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 20,
    },
    title: {
      ...typography.titleXl,
      color: colors.ink,
    },
    subtitle: {
      ...typography.body,
      color: colors.ink2,
      marginTop: 4,
      marginBottom: 28,
    },
    field: {
      marginBottom: 16,
    },
    fieldLabel: {
      ...typography.caption,
      fontWeight: "700",
      color: colors.ink3,
      marginBottom: 6,
      textTransform: "uppercase",
      letterSpacing: 0.6,
    },
    input: {
      ...typography.body,
      color: colors.ink,
      backgroundColor: colors.card,
      borderRadius: radii.button,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 16,
      height: 52,
    },
    // Password row: input + trailing eye toggle share one bordered box.
    inputRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.card,
      borderRadius: radii.button,
      borderWidth: 1,
      borderColor: colors.border,
      paddingRight: 12,
    },
    inputRowInput: {
      ...typography.body,
      color: colors.ink,
      flex: 1,
      paddingHorizontal: 16,
      height: 52,
    },
    eyeBtn: {
      padding: 6,
    },
    hint: {
      ...typography.caption,
      color: colors.ink3,
      marginTop: 6,
    },
    error: {
      ...typography.caption,
      color: colors.danger,
      marginBottom: 12,
    },
    primaryBtn: {
      height: 50,
      borderRadius: radii.button,
      backgroundColor: colors.primary,
      justifyContent: "center",
      alignItems: "center",
      marginTop: 8,
    },
    primaryBtnDisabled: {
      opacity: 0.6,
    },
    primaryBtnText: {
      ...typography.buttonLg,
      color: colors.onPrimary,
    },
    // Outlined secondary action (e.g. "Continue as guest").
    secondaryBtn: {
      height: 50,
      borderRadius: radii.button,
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: colors.border,
      justifyContent: "center",
      alignItems: "center",
      marginTop: 12,
    },
    secondaryBtnText: {
      ...typography.buttonLg,
      color: colors.ink,
    },
    // Inline text button (e.g. "Forgot password?", "Resend code", "Use backup code").
    linkBtn: {
      alignSelf: "flex-start",
      paddingVertical: 8,
    },
    linkBtnEnd: {
      alignSelf: "flex-end",
      paddingVertical: 8,
    },
    linkText: {
      ...typography.bodyStrong,
      color: colors.primary,
      fontWeight: "700",
    },
    linkTextMuted: {
      ...typography.caption,
      color: colors.ink3,
    },
    divider: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginVertical: 24,
    },
    dividerLine: {
      flex: 1,
      height: 1,
      backgroundColor: colors.divider,
    },
    dividerText: {
      ...typography.caption,
      color: colors.ink3,
    },
    footer: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      marginTop: 28,
    },
    footerText: {
      ...typography.body,
      color: colors.ink2,
    },
    footerLink: {
      ...typography.bodyStrong,
      color: colors.primary,
      fontWeight: "700",
    },
    // A back affordance shown on secondary steps (2FA, verify, reset).
    backRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginBottom: 20,
    },
    backText: {
      ...typography.bodyStrong,
      color: colors.ink2,
    },
  });
}

export type AuthStyles = ReturnType<typeof makeAuthStyles>;
