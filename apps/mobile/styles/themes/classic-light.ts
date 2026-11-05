import type { AppTheme } from "./types";
import {
  BASE_RADIUS,
  BASE_SPACING,
  BASE_TYPOGRAPHY,
  LIGHT_MAP_PAINT,
  LIGHT_PALETTE,
  LIGHT_SEMANTIC,
  LIGHT_SHADOW,
} from "./base";

export const ClassicLight: AppTheme = {
  id: "classic-light",
  isDark: false,
  colors: LIGHT_PALETTE,
  typography: BASE_TYPOGRAPHY,
  semantic: LIGHT_SEMANTIC,
  spacing: BASE_SPACING,
  radii: BASE_RADIUS,
  shadow: LIGHT_SHADOW,
  mapPaint: LIGHT_MAP_PAINT,
};
