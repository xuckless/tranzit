// Shared structural skeleton. Every concrete theme (classic-light, classic-dark)
// extends this with palette-specific values. Do not import directly; import a
// preset from `./classic-light` or `./classic-dark` (or via `getTheme()`).

import type {
  AppColors,
  AppMapPaint,
  AppRadius,
  AppSemantic,
  AppShadow,
  AppSpacing,
  AppTheme,
  AppTypography,
} from "./types";

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "";
const MAPTILER_LIGHT = `https://api.maptiler.com/maps/positron/style.json?key=${MAPTILER_KEY}`;
const MAPTILER_DARK = `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${MAPTILER_KEY}`;

// ─── Spacing (shared, both themes use the same scale) ────────────────────────

export const BASE_SPACING: AppSpacing = {
  screen: 18,
  card: 16,
  element: 8,
  xs: 4,
};

// ─── Radii (shared) ──────────────────────────────────────────────────────────

export const BASE_RADIUS: AppRadius = {
  chip: 12,
  button: 18,
  card: 22,
  sheet: 28,
  element: 8,
  pill: 99,
  fab: 18,
};

// ─── Font family tokens (shared) ─────────────────────────────────────────────

const FAMILY = {
  sans: "Syne-Regular",
  sansMedium: "Syne-Medium",
  sansBold: "Syne-Bold",
  sansExtra: "Syne-ExtraBold",
  mono: "DMmono-Regular",
  display: "Syne-ExtraBold",
} as const;

// ─── Light palette (canonical source of truth) ────────────────────────────────

export const LIGHT_PALETTE: AppColors = {
  primary: "#008a40",
  secondary: "#FFDE00",
  tertiary: "#FF3B30",
  neutral: "#000000",

  primaryDim: "#E3F5EC",
  primaryInk: "#005228",

  accent: "#FFDE00",
  accentInk: "#7A6800",

  surface: "#F7FAF8",
  surface2: "#EEF5F1",
  card: "#FFFFFF",

  ink: "#0F1410",
  ink2: "#3D4840",
  ink3: "#7A8880",
  divider: "rgba(15, 20, 16, 0.06)",

  success: "#00A84E",
  warn: "#E8C800",
  danger: "#FF3B30",

  muted: "#E3F0E8",
  text: "#3D4840",
  selected: "#005228",
  background: "#F7FAF8",
  border: "rgba(15, 20, 16, 0.10)",
  error: "#FF3B30",

  onPrimary: "#FFFFFF",

  pastels: {
    peach: { bg: "#FDEBD8", ink: "#7A3A10" },
    butter: { bg: "#FFF4B0", ink: "#7A6200" },
    mint: { bg: "#C8EDD8", ink: "#005228" },
    sky: { bg: "#CCE8F8", ink: "#154E7E" },
    lavender: { bg: "#E2D4F8", ink: "#3E248A" },
    rose: { bg: "#FFD4D0", ink: "#8A1A14" },
  },
};

export const DARK_PALETTE: AppColors = {
  primary: "#00b352",
  secondary: "#FFDE00",
  tertiary: "#FF3B30",
  neutral: "#FFFFFF",

  primaryDim: "#0D2E1A",
  primaryInk: "#6DD49A",

  accent: "#FFDE00",
  accentInk: "#F5C800",

  surface: "#0F1410",
  surface2: "#171D18",
  card: "#1E2620",

  ink: "#E8F0E9",
  ink2: "#A8B5AA",
  ink3: "#6A7870",
  divider: "rgba(255, 255, 255, 0.08)",

  success: "#00C45A",
  warn: "#E8C800",
  danger: "#FF3B30",

  muted: "#1A2E20",
  text: "#A8B5AA",
  selected: "#6DD49A",
  background: "#0F1410",
  border: "rgba(255, 255, 255, 0.12)",
  error: "#FF3B30",

  onPrimary: "#FFFFFF",

  pastels: {
    peach: { bg: "#3A2418", ink: "#FDEBD8" },
    butter: { bg: "#3A3416", ink: "#FFF4B0" },
    mint: { bg: "#0F2E1A", ink: "#C8EDD8" },
    sky: { bg: "#102536", ink: "#CCE8F8" },
    lavender: { bg: "#231B3F", ink: "#E2D4F8" },
    rose: { bg: "#3A1A18", ink: "#FFD4D0" },
  },
};

// ─── Typography (identical between light and dark — same brand voice) ────────

export const BASE_TYPOGRAPHY: AppTypography = {
  family: {
    sans: FAMILY.sans,
    mono: FAMILY.mono,
    display: FAMILY.display,
  },

  caption:        { fontFamily: FAMILY.sans,      fontSize: 12, fontWeight: "400" },
  captionStrong:  { fontFamily: FAMILY.sans,      fontSize: 12, fontWeight: "600" },
  micro:          { fontFamily: FAMILY.sans,      fontSize: 10, fontWeight: "700" },
  microStrong:    { fontFamily: FAMILY.sans,      fontSize: 10, fontWeight: "800" },
  body:           { fontFamily: FAMILY.sans,      fontSize: 14, fontWeight: "400" },
  bodyStrong:     { fontFamily: FAMILY.sans,      fontSize: 14, fontWeight: "600" },
  bodyItalic:     { fontFamily: FAMILY.sans,      fontSize: 14, fontWeight: "400", fontStyle: "italic" },
  bodySmall:      { fontFamily: FAMILY.sans,      fontSize: 13, fontWeight: "400" },
  bodySmallStrong:{ fontFamily: FAMILY.sans,      fontSize: 13, fontWeight: "600" },
  bodyMedium:     { fontFamily: FAMILY.sans,      fontSize: 14.5, fontWeight: "400" },
  subtitle:       { fontFamily: FAMILY.sans,      fontSize: 16, fontWeight: "400" },
  subtitleStrong: { fontFamily: FAMILY.sans,      fontSize: 16, fontWeight: "700" },
  title:          { fontFamily: FAMILY.sansBold,  fontSize: 18, fontWeight: "700" },
  titleLarge:     { fontFamily: FAMILY.sansBold,  fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  titleXl:        { fontFamily: FAMILY.sansBold,  fontSize: 22, fontWeight: "800", letterSpacing: -0.5 },
  hero:           { fontFamily: FAMILY.sansExtra, fontSize: 52, fontWeight: "800", letterSpacing: -1.5, lineHeight: 60 },
  heroUnit:       { fontFamily: FAMILY.sansBold,  fontSize: 28, fontWeight: "600", letterSpacing: -0.5 },
  display:        { fontFamily: FAMILY.sansExtra, fontSize: 28, fontWeight: "800", letterSpacing: -0.7 },
  displayLg:      { fontFamily: FAMILY.sansExtra, fontSize: 30, fontWeight: "800", letterSpacing: -0.8 },
  chipLabel:      { fontFamily: FAMILY.sans,      fontSize: 9,  fontWeight: "700" },
  chipDelay:      { fontFamily: FAMILY.sans,      fontSize: 9,  fontWeight: "700" },
  tabLabel:       { fontFamily: FAMILY.sans,      fontSize: 10.5, fontWeight: "700", letterSpacing: 0.1 },
  cardTitle:      { fontFamily: FAMILY.sansBold,  fontSize: 24, fontWeight: "800" },
  // Custom one-off sizes used by specific surfaces:
  buttonLg:       { fontFamily: FAMILY.sansBold,  fontSize: 15, fontWeight: "600" },
  buttonMd:       { fontFamily: FAMILY.sansBold,  fontSize: 14, fontWeight: "700" },
  fieldLabel:     { fontFamily: FAMILY.sans,      fontSize: 13, fontWeight: "600" },
  meta:           { fontFamily: FAMILY.sans,      fontSize: 15.5, fontWeight: "700", letterSpacing: -0.2 },
  badge:          { fontFamily: FAMILY.sans,      fontSize: 11, fontWeight: "700" },
  badgeLg:        { fontFamily: FAMILY.sans,      fontSize: 13, fontWeight: "600", letterSpacing: 0.2 },
  metaLg:         { fontFamily: FAMILY.sansBold,  fontSize: 17, fontWeight: "700" },
  arrival:        { fontFamily: FAMILY.sansBold,  fontSize: 18, fontWeight: "700" },
  mono:           { fontFamily: FAMILY.mono,      fontSize: 12, fontWeight: "400" },
  monoBody:       { fontFamily: FAMILY.mono,      fontSize: 11, fontWeight: "400" },
  monoSearch:     { fontFamily: FAMILY.mono,      fontSize: 13, fontWeight: "400" },

  delayOnTime: "#2E7D32",
  delayLate:   "#C62828",
  delayEarly:  "#1565C0",
};

// ─── Light semantic tokens ───────────────────────────────────────────────────

export const LIGHT_SEMANTIC: AppSemantic = {
  warning: "#F59E0B",
  warningInk: "#D97706",
  warningBg: "#FEF3C7",
  danger: "#EF4444",
  success: "#16A34A",
  neutralLine: "#BBCBB9",
  panelTitle: "#1A1C1F",
  handle: "#DEDEDE",
  handleHint: "#B0B4BF",
  sheetBg: "#FFFFFF",
  shadow: "#000000",
  backdrop: "rgba(0,0,0,0.45)",
  primaryButtonText: "#FFFFFF",
  offWhite: "rgba(255,255,255,0.75)",
  offWhiteStrong: "rgba(255,255,255,0.85)",
  errorBannerBg: "#FFEDEA",
  errorBannerBorder: "#FFCDC7",
  errorBannerText: "#BA1A1A",
  routePalette: ["#0058BC", "#FF5722", "#2E7D32", "#6A1B9A"],
  unselectedPolyline: "#C1C6D7",
  categoryIcons: {
    work: "#0070EB",
    food: "#E0A000",
    health: "#D32F2F",
    shopping: "#9C27B0",
    park: "#388E3C",
    school: "#005228",
    gym: "#FF3B30",
    other: "#0070EB",
  },
  primaryChipBlue: "#3b7bff",
  primaryChipBlueBg: "rgba(59,123,255,0.1)",
  primaryChipBlueBorder: "rgba(59,123,255,0.25)",
  thumbColor: "#FFFFFF",
  shadowCardOverlay: "rgba(20,30,80,0.06)",
  shadowSoft: "rgba(20,30,80,0.04)",
  walkChipBg: "#F0F0F0",
  cardSelectedBg: "#F5F8FF",
  buttonShadow: "#000000",
  openPillBg: "#D5EAE0",
  openPillText: "#2A6A45",
  closedPillBg: "#FFEDEA",
  closedPillText: "#BA1A1A",
};

export const DARK_SEMANTIC: AppSemantic = {
  warning: "#F59E0B",
  warningInk: "#D97706",
  warningBg: "#3A2A10",
  danger: "#EF4444",
  success: "#16A34A",
  neutralLine: "#3A4840",
  panelTitle: "#E8F0E9",
  handle: "#3A4840",
  handleHint: "#6A7870",
  sheetBg: "#1E2620",
  shadow: "#000000",
  backdrop: "rgba(0,0,0,0.65)",
  primaryButtonText: "#FFFFFF",
  offWhite: "rgba(255,255,255,0.75)",
  offWhiteStrong: "rgba(255,255,255,0.85)",
  errorBannerBg: "#3A1A18",
  errorBannerBorder: "#5A2A28",
  errorBannerText: "#FFB4AE",
  routePalette: ["#4F8FE0", "#FF8A65", "#66BB6A", "#BA68C8"],
  unselectedPolyline: "#3A4840",
  categoryIcons: {
    work: "#4F8FE0",
    food: "#E0A000",
    health: "#FF6B6B",
    shopping: "#BA68C8",
    park: "#66BB6A",
    school: "#6DD49A",
    gym: "#FF8A80",
    other: "#4F8FE0",
  },
  primaryChipBlue: "#7B9EFF",
  primaryChipBlueBg: "rgba(123,158,255,0.18)",
  primaryChipBlueBorder: "rgba(123,158,255,0.35)",
  thumbColor: "#FFFFFF",
  shadowCardOverlay: "rgba(0,0,0,0.4)",
  shadowSoft: "rgba(0,0,0,0.5)",
  walkChipBg: "#2A3530",
  cardSelectedBg: "#0D2E1A",
  buttonShadow: "#000000",
  openPillBg: "#0D2E1A",
  openPillText: "#6DD49A",
  closedPillBg: "#3A1A18",
  closedPillText: "#FFB4AE",
};

// ─── Light map paint ─────────────────────────────────────────────────────────

export const LIGHT_MAP_PAINT: AppMapPaint = {
  baseStyle: MAPTILER_LIGHT,
  stopCircle: {
    color: "#008a40",
    stroke: "#FFFFFF",
    strokeWidth: 2,
    opacity: 0.95,
    activeRadius: 7,
    upcomingRadius: 4,
  },
  busSymbol: {
    iconSize: 0.12,
    textSize: 10,
    textColor: "#FFFFFF",
    haloColor: "rgba(0,0,0,0.45)",
    haloWidth: 1,
  },
  polyline: {
    completed: "#008a40",
    remaining: "#008a40",
    unsure: "#F59E0B",
    missed: "#EF4444",
    destination: "#FFDE00",
    upcoming: "#C1C6D7",
    walk: "#6B7280",
    width: 5,
  },
  stopMatch: {
    active: "#008a40",
    unsure: "#F59E0B",
    missed: "#EF4444",
    upcoming: "#C1C6D7",
    destination: "#FFDE00",
    departed: "#008a40",
  },
  timelineMatch: {
    current: "#008a40",
    unsure: "#F59E0B",
    missed: "#EF4444",
    upcoming: "#C1C6D7",
    destination: "#FFDE00",
    departed: "#008a40",
  },
};

export const DARK_MAP_PAINT: AppMapPaint = {
  baseStyle: MAPTILER_DARK,
  stopCircle: {
    color: "#00b352",
    stroke: "#0F1410",
    strokeWidth: 2,
    opacity: 0.95,
    activeRadius: 7,
    upcomingRadius: 4,
  },
  busSymbol: {
    iconSize: 0.12,
    textSize: 10,
    textColor: "#FFFFFF",
    haloColor: "rgba(0,0,0,0.55)",
    haloWidth: 1,
  },
  polyline: {
    completed: "#00b352",
    remaining: "#00b352",
    unsure: "#F59E0B",
    missed: "#EF4444",
    destination: "#FFDE00",
    upcoming: "#3A4840",
    walk: "#9CA3AF",
    width: 5,
  },
  stopMatch: {
    active: "#00b352",
    unsure: "#F59E0B",
    missed: "#EF4444",
    upcoming: "#3A4840",
    destination: "#FFDE00",
    departed: "#00b352",
  },
  timelineMatch: {
    current: "#00b352",
    unsure: "#F59E0B",
    missed: "#EF4444",
    upcoming: "#3A4840",
    destination: "#FFDE00",
    departed: "#00b352",
  },
};

// ─── Shadow tokens (shared structurally; color comes from semantic.shadow) ──

const lightShadow: AppShadow = {
  card: {
    shadowColor: "rgba(0, 20, 10, 0.08)",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 12,
    elevation: 3,
  },
  floating: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 10,
  },
  liveBadge: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  soft: {
    shadowColor: "rgba(20,30,80,0.04)",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 2,
    elevation: 1,
  },
  button: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
};

const darkShadow: AppShadow = {
  card: {
    shadowColor: "rgba(0, 0, 0, 0.5)",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 12,
    elevation: 3,
  },
  floating: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.6,
    shadowRadius: 16,
    elevation: 10,
  },
  liveBadge: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    elevation: 4,
  },
  soft: {
    shadowColor: "rgba(0, 0, 0, 0.5)",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 2,
    elevation: 1,
  },
  button: {
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 4,
  },
};

export const LIGHT_SHADOW = lightShadow;
export const DARK_SHADOW = darkShadow;
