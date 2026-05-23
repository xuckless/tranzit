// Tranzit design system — forest green primary, solar yellow secondary, alert red tertiary
// oklch values converted to hex approximations for React Native compatibility

export const PASTELS = {
  peach:    { bg: "#FDEBD8", ink: "#7A3A10" },
  butter:   { bg: "#FFF4B0", ink: "#7A6200" },   // echoes secondary #FFDE00
  mint:     { bg: "#C8EDD8", ink: "#005228" },    // echoes primary #008a40
  sky:      { bg: "#CCE8F8", ink: "#154E7E" },
  lavender: { bg: "#E2D4F8", ink: "#3E248A" },
  rose:     { bg: "#FFD4D0", ink: "#8A1A14" },    // echoes tertiary #FF3B30
} as const;

const theme = {
  colors: {
    // ── Brand (DO NOT CHANGE) ────────────────────────────────────────────
    primary:   "#008a40",   // forest green
    secondary: "#FFDE00",   // solar yellow
    tertiary:  "#FF3B30",   // alert red
    neutral:   "#000000",   // pure black

    // ── Primary tints ────────────────────────────────────────────────────
    primaryDim: "#E3F5EC",  // light green wash — chip / tag backgrounds
    primaryInk: "#005228",  // deep forest — text on primaryDim

    // ── Accent (secondary yellow) ────────────────────────────────────────
    accent:    "#FFDE00",   // = secondary
    accentInk: "#7A6800",   // dark amber for text on accent

    // ── Surfaces ─────────────────────────────────────────────────────────
    surface:  "#F7FAF8",    // near-white with faint green warmth
    surface2: "#EEF5F1",    // slightly deeper for layered backgrounds
    card:     "#FFFFFF",

    // ── Ink hierarchy (anchored to neutral black) ─────────────────────────
    ink:     "#0F1410",               // near-black, green-tinted
    ink2:    "#3D4840",               // medium charcoal
    ink3:    "#7A8880",               // muted / placeholder
    divider: "rgba(15, 20, 16, 0.06)",

    // ── Semantic ─────────────────────────────────────────────────────────
    success: "#00A84E",     // brighter green (positive feedback)
    warn:    "#E8C800",     // richer yellow (caution states)
    danger:  "#FF3B30",     // = tertiary

    // ── Legacy aliases (kept so existing screens don't break) ────────────
    muted:      "#E3F0E8",
    text:       "#3D4840",  // = ink2
    selected:   "#005228",  // = primaryInk
    background: "#F7FAF8",  // = surface
    border:     "rgba(15, 20, 16, 0.10)",
    error:      "#FF3B30",  // = tertiary
  },
  spacing: {
    screen:  18,
    card:    16,
    element: 8,
  },
  borderRadius: {
    chip:    12,
    button:  18,
    card:    22,
    sheet:   28,
    element: 8, // kept for legacy components (inputs, small chips)
  },
  fontSize: {
    title:    18,
    subtitle: 16,
    body:     14,
    caption:  12,
  },
  shadow: {
    card: {
      shadowColor:   "rgba(0, 20, 10, 0.08)",
      shadowOffset:  { width: 0, height: 4 },
      shadowOpacity: 1,
      shadowRadius:  12,
      elevation:     3,
    },
  },
};

export { theme };
