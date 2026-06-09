import { ClassicDark } from "./classic-dark";
import { ClassicLight } from "./classic-light";
import type {
  AppTheme,
  CategoryIconKey,
  PastelKey,
  ThemeId,
} from "./types";

// ─── Registry of all available theme presets ────────────────────────────────
// To add a new theme (e.g. "high-contrast"), drop a file in this directory
// and add it here. Consumers never need to be touched.

export const THEMES: Record<ThemeId, AppTheme> = {
  "classic-light": ClassicLight,
  "classic-dark": ClassicDark,
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

// Default theme when no preference is persisted.
export const DEFAULT_THEME_ID: ThemeId = "classic-light";

export function getTheme(id: ThemeId | null | undefined): AppTheme {
  if (id && THEMES[id]) return THEMES[id];
  return THEMES[DEFAULT_THEME_ID];
}

export { ClassicLight, ClassicDark };
export type { AppTheme, ThemeId, PastelKey, CategoryIconKey };
