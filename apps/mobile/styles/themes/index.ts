import { ClassicDark } from "./classic-dark";
import { ClassicLight } from "./classic-light";
import { parseThemePack } from "./parseTheme";
import sunsetJson from "./samples/sunset.theme.json";
import type {
  AppTheme,
  CategoryIconKey,
  ColorSchemePreference,
  PastelKey,
  ResolvedScheme,
  ThemeId,
  ThemePack,
} from "./types";

// ─── Theme packs ─────────────────────────────────────────────────────────────
//
// A "theme" is a *pack*: a container holding a light and a dark `AppTheme`. The
// active variant is chosen at runtime from the user's `ColorSchemePreference`
// (see ThemeContext). To add a built-in pack, compose it here and register it.
// User-specific packs are parsed from JSON via `parseThemePack` and registered
// at runtime with `registerThemePack` (today: the bundled sample; later: the
// user DB / an S3 URL).

export const ClassicPack: ThemePack = {
  id: "classic",
  name: "Classic",
  light: ClassicLight,
  dark: ClassicDark,
};

const PACKS: Record<string, ThemePack> = {
  [ClassicPack.id]: ClassicPack,
};

export const DEFAULT_PACK_ID = "classic";

/** Register (or replace) a pack. Used by the bundled sample + future fetches. */
export function registerThemePack(pack: ThemePack): void {
  PACKS[pack.id] = pack;
}

export function getPack(id?: string | null): ThemePack {
  return (id && PACKS[id]) || PACKS[DEFAULT_PACK_ID];
}

/** Resolve a pack id + concrete scheme to the underlying `AppTheme`. */
export function resolveTheme(
  packId: string | null | undefined,
  scheme: ResolvedScheme,
): AppTheme {
  const pack = getPack(packId);
  return scheme === "dark" ? pack.dark : pack.light;
}

/** All currently-registered packs (Classic first), for the theme picker. */
export function listPacks(): ThemePack[] {
  return Object.values(PACKS);
}

// Register the bundled sample so the parse → register → select → render flow is
// exercised now, before the DB/S3 wiring exists. Malformed → silently skipped.
const sunset = parseThemePack(sunsetJson);
if (sunset) registerThemePack(sunset);

export { ClassicLight, ClassicDark };
export { parseThemePack };
export type {
  AppTheme,
  ThemeId,
  ThemePack,
  ColorSchemePreference,
  ResolvedScheme,
  PastelKey,
  CategoryIconKey,
};
