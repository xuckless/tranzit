// JSON → ThemePack parser.
//
// User-specific themes are authored as JSON (today a bundled sample; later
// fetched from the user DB / an S3 URL) and parsed into a `ThemePack`. We have
// no schema library in the project (no zod), so this follows the same
// hand-rolled, defensive convention as `lib/routeParser.ts`: validate the
// shape, and return `null` on anything malformed so the caller can ignore it
// and stay on Classic.
//
// Format = **full spec**: a valid JSON must supply every design token of both
// the `light` and `dark` variants. We enforce that structurally by walking the
// known-good `ClassicLight` / `ClassicDark` objects as the canonical shape
// reference — every key they contain must be present in the JSON with a value
// of the same `typeof`. This stays correct automatically as `AppTheme` evolves.
//
// Two fields are pack-derived rather than author-controlled and are therefore
// filled in before validation (so the JSON need not — and cannot meaningfully —
// provide them):
//   - `id` / `isDark`: forced from the pack id + variant.
//   - `mapPaint.baseStyle`: the Classic basemap URL is built at runtime from
//     `EXPO_PUBLIC_MAPTILER_KEY` and cannot live in a static JSON literal, so an
//     empty/missing `baseStyle` inherits the matching Classic variant's URL.

import { ClassicDark } from "./classic-dark";
import { ClassicLight } from "./classic-light";
import type { AppTheme, ResolvedScheme, ThemePack } from "./types";

class ThemeParseError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate `input` against the *shape* of `reference` (a known-good value from
 * Classic). Returns a value matching the reference shape, or throws
 * `ThemeParseError` on the first mismatch / missing key.
 */
function coerce(input: unknown, reference: unknown, path: string): unknown {
  const where = path || "<root>";

  if (typeof reference === "string") {
    if (typeof input !== "string")
      throw new ThemeParseError(`${where}: expected string`);
    return input;
  }
  if (typeof reference === "number") {
    if (typeof input !== "number" || Number.isNaN(input))
      throw new ThemeParseError(`${where}: expected number`);
    return input;
  }
  if (typeof reference === "boolean") {
    if (typeof input !== "boolean")
      throw new ThemeParseError(`${where}: expected boolean`);
    return input;
  }
  if (Array.isArray(reference)) {
    if (!Array.isArray(input))
      throw new ThemeParseError(`${where}: expected array`);
    // Validate each element against the first reference element (e.g.
    // `routePalette: string[]`). Empty reference → accept as-is.
    const elemRef = reference.length > 0 ? reference[0] : undefined;
    if (elemRef === undefined) return input;
    return input.map((el, i) => coerce(el, elemRef, `${where}[${i}]`));
  }
  if (isObject(reference)) {
    if (!isObject(input))
      throw new ThemeParseError(`${where}: expected object`);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(reference)) {
      out[key] = coerce(input[key], reference[key], path ? `${path}.${key}` : key);
    }
    return out;
  }

  // Reference is null/undefined — nothing to validate, pass input through.
  return input ?? null;
}

/**
 * Pre-fill the pack-derived fields (`id`, `isDark`, and a `baseStyle` fallback)
 * onto a shallow copy of the raw variant so the strict `coerce` pass accepts
 * them without the author having to supply them.
 */
function prefillDerived(
  rawVariant: unknown,
  reference: AppTheme,
  packId: string,
  scheme: ResolvedScheme,
): unknown {
  if (!isObject(rawVariant)) return rawVariant; // let coerce report the error
  const variant: Record<string, unknown> = { ...rawVariant };

  variant.id = `${packId}-${scheme}`;
  variant.isDark = scheme === "dark";

  const mp = variant.mapPaint;
  if (isObject(mp)) {
    const baseStyle = mp.baseStyle;
    const usable = typeof baseStyle === "string" && baseStyle.trim().length > 0;
    variant.mapPaint = {
      ...mp,
      baseStyle: usable ? baseStyle : reference.mapPaint.baseStyle,
    };
  }

  return variant;
}

function parseVariant(
  rawVariant: unknown,
  reference: AppTheme,
  packId: string,
  scheme: ResolvedScheme,
): AppTheme {
  const prefilled = prefillDerived(rawVariant, reference, packId, scheme);
  return coerce(prefilled, reference, scheme) as AppTheme;
}

/**
 * Parse an unknown value (typically `JSON.parse` output or an imported `.json`)
 * into a `ThemePack`. Returns `null` if anything is missing or malformed.
 */
export function parseThemePack(raw: unknown): ThemePack | null {
  try {
    if (!isObject(raw)) throw new ThemeParseError("<root>: expected object");

    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!id) throw new ThemeParseError("id: expected non-empty string");
    if (!name) throw new ThemeParseError("name: expected non-empty string");
    if (!isObject(raw.light)) throw new ThemeParseError("light: expected object");
    if (!isObject(raw.dark)) throw new ThemeParseError("dark: expected object");

    const light = parseVariant(raw.light, ClassicLight, id, "light");
    const dark = parseVariant(raw.dark, ClassicDark, id, "dark");

    return { id, name, light, dark };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[parseTheme] ignoring malformed theme: ${msg}`);
    return null;
  }
}
