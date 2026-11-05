// Tranzit design system — single source of truth for theming.
//
// All themable values (colors, typography, spacing, radii, shadows, semantic
// status colors, and MapLibre paint tokens) live in `styles/themes/` as
// preset objects, grouped into *packs* (a light + dark `AppTheme` container).
// To add a built-in pack:
//   1. Create the variant files in `styles/themes/` that implement `AppTheme`.
//   2. Compose + register the pack in `styles/themes/index.ts`.
//   3. (Optional) the theme picker in `app/settings.tsx` reads `listPacks()`.
//
// The default export below (`theme`) is a back-compat alias for
// `ClassicLight` so any file that still uses `import { theme } from ...` will
// keep compiling. New code should call `useTheme()` and destructure from the
// returned `AppTheme`.

import { ClassicLight } from "./themes/classic-light";

export const theme = ClassicLight;

export {
  ClassicPack,
  DEFAULT_PACK_ID,
  getPack,
  resolveTheme,
  listPacks,
  registerThemePack,
  parseThemePack,
  ClassicLight,
  ClassicDark,
} from "./themes";

export type {
  AppTheme,
  ThemeId,
  ThemePack,
  ColorSchemePreference,
  ResolvedScheme,
} from "./themes";
