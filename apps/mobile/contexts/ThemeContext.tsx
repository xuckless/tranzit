import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

  useEffect(() => {
    SecureStore.getItemAsync(DARK_MODE_KEY).then((val) => {
      if (val === "true") setIsDark(true);
    });
  }, []);

  const toggle = useCallback(() => {
    setIsDark((prev) => {
      const next = !prev;
      SecureStore.setItemAsync(DARK_MODE_KEY, String(next));
      return next;
    });
  }, []);

  const colors = isDark ? (darkColors as ThemeColors) : theme.colors;

  return (
    <ThemeContext.Provider value={{ isDark, toggle, colors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
