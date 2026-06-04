import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import * as SecureStore from "expo-secure-store";
import { theme, darkColors } from "@/styles/theme";

const DARK_MODE_KEY = "tranzit_dark_mode";

type ThemeColors = typeof theme.colors;

interface ThemeContextValue {
  isDark: boolean;
  toggle: () => void;
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeContextValue>({
  isDark: false,
  toggle: () => {},
  colors: theme.colors,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [isDark, setIsDark] = useState(false);

  // Load persisted preference on mount
  useEffect(() => {
    SecureStore.getItemAsync(DARK_MODE_KEY).then((val) => {
      if (val === "true") setIsDark(true);
    });
  }, []);

  // Persist whenever isDark changes (separated from the state updater)
  useEffect(() => {
    SecureStore.setItemAsync(DARK_MODE_KEY, String(isDark));
  }, [isDark]);

  // Pure toggle — no side effects inside the updater
  const toggle = useCallback(() => {
    setIsDark((prev) => !prev);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      isDark,
      toggle,
      colors: isDark ? (darkColors as ThemeColors) : theme.colors,
    }),
    [isDark, toggle],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
