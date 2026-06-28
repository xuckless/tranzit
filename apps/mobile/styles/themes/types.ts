import type { TextStyle, ViewStyle } from "react-native";

// ─── Theme identifiers ───────────────────────────────────────────────────────

export type ThemeId = "classic-light" | "classic-dark" | (string & {});

/**
 * How the active variant of a pack is chosen.
 * - `system` → follow the OS color scheme (via `useColorScheme()`).
 * - `light` / `dark` → explicit override.
 */
export type ColorSchemePreference = "system" | "light" | "dark";

/** The concrete variant a `ColorSchemePreference` resolves to. */
export type ResolvedScheme = "light" | "dark";

// ─── Palette tokens ───────────────────────────────────────────────────────────

export type PastelKey =
  | "peach"
  | "butter"
  | "mint"
  | "sky"
  | "lavender"
  | "rose";

export type CategoryIconKey =
  | "work"
  | "food"
  | "health"
  | "shopping"
  | "park"
  | "school"
  | "gym"
  | "other";

// ─── Map paint tokens ─────────────────────────────────────────────────────────

export interface MapCirclePaint {
  color: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  activeRadius: number;
  upcomingRadius: number;
}

export interface MapSymbolPaint {
  iconSize: number;
  textSize: number;
  textColor: string;
  haloColor: string;
  haloWidth: number;
}

export interface MapPolylinePaint {
  completed: string;
  remaining: string;
  unsure: string;
  missed: string;
  destination: string;
  upcoming: string;
  /** Walking segments (rendered as a thick dotted line on the commute map). */
  walk: string;
  width: number;
}

export interface AppMapPaint {
  baseStyle: string;
  stopCircle: MapCirclePaint;
  busSymbol: MapSymbolPaint;
  polyline: MapPolylinePaint;
  stopMatch: {
    active: string;
    unsure: string;
    missed: string;
    upcoming: string;
    destination: string;
    departed: string;
  };
  timelineMatch: {
    current: string;
    unsure: string;
    missed: string;
    upcoming: string;
    destination: string;
    departed: string;
  };
}

// ─── Typography tokens ────────────────────────────────────────────────────────

export interface AppTypography {
  family: {
    sans: string;
    mono: string;
    display: string;
  };
  caption: TextStyle;
  captionStrong: TextStyle;
  micro: TextStyle;
  microStrong: TextStyle;
  body: TextStyle;
  bodyStrong: TextStyle;
  bodyItalic: TextStyle;
  bodySmall: TextStyle;
  bodySmallStrong: TextStyle;
  bodyMedium: TextStyle;
  subtitle: TextStyle;
  subtitleStrong: TextStyle;
  title: TextStyle;
  titleLarge: TextStyle;
  titleXl: TextStyle;
  hero: TextStyle;
  heroUnit: TextStyle;
  display: TextStyle;
  displayLg: TextStyle;
  chipLabel: TextStyle;
  chipDelay: TextStyle;
  tabLabel: TextStyle;
  cardTitle: TextStyle;
  buttonLg: TextStyle;
  buttonMd: TextStyle;
  fieldLabel: TextStyle;
  meta: TextStyle;
  badge: TextStyle;
  badgeLg: TextStyle;
  metaLg: TextStyle;
  arrival: TextStyle;
  mono: TextStyle;
  monoBody: TextStyle;
  monoSearch: TextStyle;
  delayOnTime: string;
  delayLate: string;
  delayEarly: string;
}

// ─── Semantic tokens (status colors that carry meaning) ──────────────────────

export interface AppSemantic {
  warning: string;
  warningInk: string;
  warningBg: string;
  danger: string;
  success: string;
  neutralLine: string;
  panelTitle: string;
  handle: string;
  handleHint: string;
  sheetBg: string;
  shadow: string;
  backdrop: string;
  primaryButtonText: string;
  offWhite: string;
  offWhiteStrong: string;
  errorBannerBg: string;
  errorBannerBorder: string;
  errorBannerText: string;
  routePalette: string[];
  unselectedPolyline: string;
  categoryIcons: Record<CategoryIconKey, string>;
  primaryChipBlue: string;
  primaryChipBlueBg: string;
  primaryChipBlueBorder: string;
  thumbColor: string;
  shadowCardOverlay: string;
  shadowSoft: string;
  walkChipBg: string;
  cardSelectedBg: string;
  buttonShadow: string;
  openPillBg: string;
  openPillText: string;
  closedPillBg: string;
  closedPillText: string;
}

// ─── Color tokens ─────────────────────────────────────────────────────────────

export interface AppColors {
  primary: string;
  secondary: string;
  tertiary: string;
  neutral: string;
  primaryDim: string;
  primaryInk: string;
  accent: string;
  accentInk: string;
  surface: string;
  surface2: string;
  card: string;
  ink: string;
  ink2: string;
  ink3: string;
  divider: string;
  success: string;
  warn: string;
  danger: string;
  muted: string;
  text: string;
  selected: string;
  background: string;
  border: string;
  error: string;
  onPrimary: string;
  pastels: Record<PastelKey, { bg: string; ink: string }>;
}

// ─── Other token groups ──────────────────────────────────────────────────────

export interface AppSpacing {
  screen: number;
  card: number;
  element: number;
  xs: number;
}

export interface AppRadius {
  chip: number;
  button: number;
  card: number;
  sheet: number;
  element: number;
  pill: number;
  fab: number;
}

export interface AppShadow {
  card: ViewStyle;
  floating: ViewStyle;
  liveBadge: ViewStyle;
  soft: ViewStyle;
  button: ViewStyle;
}

// ─── Theme struct ─────────────────────────────────────────────────────────────

export interface AppTheme {
  id: ThemeId;
  isDark: boolean;
  colors: AppColors;
  typography: AppTypography;
  semantic: AppSemantic;
  spacing: AppSpacing;
  radii: AppRadius;
  shadow: AppShadow;
  mapPaint: AppMapPaint;
}

// ─── Theme pack (container) ──────────────────────────────────────────────────
//
// A "theme" the user sees is a *pack*: a container that holds a light and a
// dark `AppTheme`. The active variant is chosen at runtime by the
// `ColorSchemePreference` (system / light / dark). Future user-specific packs
// are loaded from JSON (user DB → S3) and parsed into this shape.

export interface ThemePack {
  /** Stable id, e.g. "classic", "sunset". */
  id: string;
  /** Human-facing name shown in the theme picker, e.g. "Classic". */
  name: string;
  light: AppTheme;
  dark: AppTheme;
}
