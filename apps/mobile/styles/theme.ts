// Tranzit design system — single source of truth for theming.
//
// All themable values (colors, typography, spacing, radii, shadows, semantic
// status colors, and MapLibre paint tokens) live in `styles/themes/` as
// preset objects (e.g. `classic-light`, `classic-dark`). To add a new theme:
//   1. Create a new file in `styles/themes/` that implements `AppTheme`.
//   2. Add it to the `THEMES` registry in `styles/themes/index.ts`.
//   3. (Optional) surface a theme picker in `app/settings.tsx`.
//
// The default export below (`theme`) is a back-compat alias for
// `ClassicLight` so any file that still uses `import { theme } from ...` will
// keep compiling. New code should call `useTheme()` and destructure from the
// returned `AppTheme`.

import { ClassicLight } from "./themes/classic-light";

export const theme = ClassicLight;

export {
  THEMES,
  THEME_IDS,
  DEFAULT_THEME_ID,
  getTheme,
  ClassicLight,
  ClassicDark,
} from "./themes";

export type { AppTheme, ThemeId } from "./themes";
