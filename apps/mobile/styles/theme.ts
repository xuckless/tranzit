// Tranzit design system — indigo primary, honey accent, warm cream surface
// oklch values converted to hex approximations for React Native compatibility

export const PASTELS = {
  peach:    { bg: '#F5E5D0', ink: '#7A4520' },
  butter:   { bg: '#F8EDB8', ink: '#735A10' },
  mint:     { bg: '#D5EAE0', ink: '#2A6A45' },
  sky:      { bg: '#D5E5F5', ink: '#1A507E' },
  lavender: { bg: '#E5D8F5', ink: '#4A2A8A' },
  rose:     { bg: '#F5D8D0', ink: '#7A2820' },
} as const;

const theme = {
  colors: {
    // Brand
    primary:    '#4050BE',   // oklch(0.50 0.15 252) — deep indigo
    primaryDim: '#EEF0FF',   // oklch(0.96 0.03 252) — light indigo tint
    primaryInk: '#2B3A8F',   // oklch(0.32 0.10 252) — dark indigo
    accent:     '#E8AC00',   // oklch(0.78 0.14 75)  — honey gold
    accentInk:  '#735A00',   // oklch(0.40 0.10 70)

    // Surfaces
    surface:  '#FAF9F6',     // oklch(0.985 0.005 80) — warm cream
    surface2: '#F5F3EF',     // oklch(0.965 0.006 85)
    card:     '#FFFFFF',

    // Ink
    ink:      '#1A1E2E',     // oklch(0.22 0.015 260) — near-black blue-tinted
    ink2:     '#4A4E6B',     // oklch(0.42 0.02  255) — medium
    ink3:     '#848896',     // oklch(0.62 0.02  255) — muted
    divider:  'rgba(20, 24, 40, 0.06)',

    // Semantic
    success:  '#3EA870',     // oklch(0.62 0.13 155)
    warn:     '#E8AC00',     // oklch(0.78 0.14 75)
    danger:   '#C8381E',     // oklch(0.62 0.20 25)

    // Legacy aliases (kept so existing screens don't break)
    secondary:   '#E8AC00',
    tertiary:    '#C8381E',
    neutral:     '#F5F3EF',
    muted:       '#EDEAE4',
    text:        '#4A4E6B',
    selected:    '#2B3A8F',
    background:  '#FAF9F6',
    border:      'rgba(20, 24, 40, 0.10)',
    error:       '#C8381E',
  },
  spacing: {
    screen: 18,
    card:   16,
    element: 8,
  },
  borderRadius: {
    chip:    12,
    button:  18,
    card:    22,
    sheet:   28,
    element:  8,  // kept for legacy components (inputs, small chips)
  },
  fontSize: {
    title:    18,
    subtitle: 16,
    body:     14,
    caption:  12,
  },
  shadow: {
    card: {
      shadowColor: 'rgba(20, 30, 80, 0.08)',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 1,
      shadowRadius: 12,
      elevation: 3,
    },
  },
};

export { theme };
