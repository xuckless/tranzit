import type { AppTheme } from "./types";
import {
  BASE_RADIUS,
  BASE_SPACING,
  BASE_TYPOGRAPHY,
  DARK_MAP_PAINT,
  DARK_PALETTE,
  DARK_SEMANTIC,
  DARK_SHADOW,
} from "./base";

export const ClassicDark: AppTheme = {
  id: "classic-dark",
  isDark: true,
  colors: DARK_PALETTE,
  typography: BASE_TYPOGRAPHY,
  semantic: DARK_SEMANTIC,
  spacing: BASE_SPACING,
  radii: BASE_RADIUS,
  shadow: DARK_SHADOW,
  mapPaint: DARK_MAP_PAINT,
};
