// Shared mapping from a saved-place category name → its FontAwesome5 icon and
// pastel swatch. Used by the Save modal (icon to persist on create), the Saved
// screen (icon to render), and the saved-places orchestrator. Keeping it in one
// place means the icon written into `user_defined_default_categories.category_icon`
// matches what the UI renders.

import type { PastelKey } from "@/styles/themes";

interface CategoryVisual {
  icon: string; // FontAwesome5 glyph name
  pastel: PastelKey;
}

export const CATEGORY_STYLE: Record<string, CategoryVisual> = {
  home: { icon: "home", pastel: "lavender" },
  work: { icon: "briefcase", pastel: "sky" },
  office: { icon: "briefcase", pastel: "sky" },
  school: { icon: "university", pastel: "butter" },
  university: { icon: "university", pastel: "butter" },
  gym: { icon: "dumbbell", pastel: "rose" },
  food: { icon: "utensils", pastel: "peach" },
  restaurant: { icon: "utensils", pastel: "peach" },
  health: { icon: "heartbeat", pastel: "rose" },
  hospital: { icon: "hospital", pastel: "rose" },
  shopping: { icon: "shopping-bag", pastel: "lavender" },
  park: { icon: "tree", pastel: "mint" },
};

const FALLBACK: CategoryVisual = { icon: "map-marker-alt", pastel: "sky" };

/** Icon + pastel for a category name (case-insensitive), with a sensible fallback. */
export function categoryStyle(name: string): CategoryVisual {
  return CATEGORY_STYLE[name.trim().toLowerCase()] ?? FALLBACK;
}

/** The FontAwesome5 icon string to persist in `category_icon` for a category name. */
export function categoryIconFor(name: string): string {
  return categoryStyle(name).icon;
}

/** Pastel for a stored icon string, used when rendering from the persisted icon. */
export function pastelForIcon(icon: string): PastelKey {
  for (const v of Object.values(CATEGORY_STYLE)) {
    if (v.icon === icon) return v.pastel;
  }
  return FALLBACK.pastel;
}
