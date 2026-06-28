import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useColorScheme } from "react-native";
import * as SecureStore from "expo-secure-store";
import {
  DEFAULT_PACK_ID,
  getPack,
  listPacks,
  resolveTheme,
} from "@/styles/themes";
import type {
  AppTheme,
  ColorSchemePreference,
  ResolvedScheme,
  ThemePack,
} from "@/styles/themes";

// New-format keys: a theme is now a (pack, color-scheme-preference) pair.
const PACK_KEY = "tranzit_theme_pack";
const SCHEME_KEY = "tranzit_color_scheme";
// Legacy keys migrated on first launch after upgrade.
const LEGACY_THEME_ID_KEY = "tranzit_theme_id";
const LEGACY_DARK_KEY = "tranzit_dark_mode";

const VALID_PREFS: ColorSchemePreference[] = ["system", "light", "dark"];

interface ThemeContextValue {
  /** The resolved variant — shape unchanged, so existing consumers are untouched. */
  theme: AppTheme;
  /** The selected pack (light + dark container). */
  pack: ThemePack;
  packId: string;
  /** User's mode preference: system / light / dark. */
  schemePreference: ColorSchemePreference;
  /** The concrete variant `schemePreference` currently resolves to. */
  resolvedScheme: ResolvedScheme;
  setPackId: (id: string) => void;
  setSchemePreference: (pref: ColorSchemePreference) => void;
  /** All registered packs, for the theme picker. */
  availablePacks: ThemePack[];
}

const fallbackPack = getPack(DEFAULT_PACK_ID);

const ThemeContext = createContext<ThemeContextValue>({
  theme: fallbackPack.light,
  pack: fallbackPack,
  packId: DEFAULT_PACK_ID,
  schemePreference: "system",
  resolvedScheme: "light",
  setPackId: () => {},
  setSchemePreference: () => {},
  availablePacks: listPacks(),
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [packId, setPackIdState] = useState<string>(DEFAULT_PACK_ID);
  const [schemePreference, setSchemePreferenceState] =
    useState<ColorSchemePreference>("system");
  // Skip persisting until the stored preference has been hydrated, so we never
  // clobber a saved value (or a pending migration) with the initial defaults.
  const hydrated = useRef(false);

  // Live OS color scheme — drives the theme when preference is "system".
  const systemScheme = useColorScheme();
  const resolvedScheme: ResolvedScheme =
    schemePreference === "system"
      ? systemScheme === "dark"
        ? "dark"
        : "light"
      : schemePreference;

  // ── Hydrate from storage (once), migrating legacy keys if needed ──
  useEffect(() => {
    (async () => {
      try {
        const [storedPack, storedScheme] = await Promise.all([
          SecureStore.getItemAsync(PACK_KEY).catch(() => null),
          SecureStore.getItemAsync(SCHEME_KEY).catch(() => null),
        ]);

        if (storedScheme && VALID_PREFS.includes(storedScheme as ColorSchemePreference)) {
          // New format already present.
          if (storedPack) setPackIdState(storedPack);
          setSchemePreferenceState(storedScheme as ColorSchemePreference);
          return;
        }

        // Migrate the legacy single-id key. All legacy themes were Classic, so
        // the pack stays "classic"; only the mode is carried across.
        const legacyId = await SecureStore.getItemAsync(LEGACY_THEME_ID_KEY).catch(
          () => null,
        );
        if (legacyId === "classic-dark") {
          setSchemePreferenceState("dark");
        } else if (legacyId === "classic-light") {
          setSchemePreferenceState("light");
        } else {
          // Pre-theme-system boolean. Anything else → leave default "system".
          const legacyDark = await SecureStore.getItemAsync(LEGACY_DARK_KEY).catch(
            () => null,
          );
          if (legacyDark === "true") setSchemePreferenceState("dark");
        }
      } finally {
        hydrated.current = true;
      }
    })();
  }, []);

  // ── Persist on change (after hydration) ──
  useEffect(() => {
    if (!hydrated.current) return;
    SecureStore.setItemAsync(PACK_KEY, packId);
  }, [packId]);

  useEffect(() => {
    if (!hydrated.current) return;
    SecureStore.setItemAsync(SCHEME_KEY, schemePreference);
  }, [schemePreference]);

  const setPackId = useCallback((id: string) => setPackIdState(id), []);
  const setSchemePreference = useCallback(
    (pref: ColorSchemePreference) => setSchemePreferenceState(pref),
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: resolveTheme(packId, resolvedScheme),
      pack: getPack(packId),
      packId,
      schemePreference,
      resolvedScheme,
      setPackId,
      setSchemePreference,
      availablePacks: listPacks(),
    }),
    [packId, schemePreference, resolvedScheme, setPackId, setSchemePreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
