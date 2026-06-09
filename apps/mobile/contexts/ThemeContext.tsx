import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import * as SecureStore from "expo-secure-store";
import { DEFAULT_THEME_ID, THEMES, getTheme } from "@/styles/themes";
import type { AppTheme, ThemeId } from "@/styles/themes";

const THEME_ID_KEY = "tranzit_theme_id";

interface ThemeContextValue {
  theme: AppTheme;
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
}

const fallbackTheme = getTheme(DEFAULT_THEME_ID);

const ThemeContext = createContext<ThemeContextValue>({
  theme: fallbackTheme,
  themeId: DEFAULT_THEME_ID,
  setThemeId: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeIdState] = useState<ThemeId>(DEFAULT_THEME_ID);

  useEffect(() => {
    SecureStore.getItemAsync(THEME_ID_KEY).then((val) => {
      if (val && (THEMES as Record<string, AppTheme>)[val]) {
        setThemeIdState(val as ThemeId);
      }
    });
  }, []);

  useEffect(() => {
    SecureStore.setItemAsync(THEME_ID_KEY, themeId);
  }, [themeId]);

  const setThemeId = useCallback((id: ThemeId) => {
    setThemeIdState(id);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: getTheme(themeId),
      themeId,
      setThemeId,
    }),
    [themeId, setThemeId],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
