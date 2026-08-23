import { Icon } from "@iconify/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { TooltipIconButton } from "./components/assistant-ui/tooltip-icon-button";
import { SwipeThemeProvider, useSwipeTheme } from "./components/ui/swipe-theme-provider";

export type StudioThemePreference = "system" | "light" | "dark";
export type ResolvedStudioTheme = Exclude<StudioThemePreference, "system">;

type StudioThemeContextValue = {
  preference: StudioThemePreference;
  resolvedTheme: ResolvedStudioTheme;
  setPreference: (preference: StudioThemePreference) => void;
};

const THEME_STORAGE_KEY = "tessera.theme";

const StudioThemeContext = createContext<StudioThemeContextValue | null>(null);

export function StudioThemeProvider({ children }: PropsWithChildren) {
  const [preference, setPreferenceState] = useState<StudioThemePreference>(readThemePreference);
  const [systemTheme, setSystemTheme] = useState<ResolvedStudioTheme>(resolveSystemTheme);
  const resolvedTheme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemTheme(media.matches ? "dark" : "light");
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const setPreference = useCallback((nextPreference: StudioThemePreference) => {
    setPreferenceState(nextPreference);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextPreference);
    } catch {
      // Theme persistence is an enhancement. The current session still works.
    }
  }, []);

  const value = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  );

  return (
    <StudioThemeContext.Provider value={value}>
      <SwipeThemeProvider
        angle={8}
        direction="top-right"
        duration={650}
        onThemeChange={setPreference}
        theme={resolvedTheme}
      >
        {children}
      </SwipeThemeProvider>
    </StudioThemeContext.Provider>
  );
}

export function useStudioTheme(): StudioThemeContextValue {
  const context = useContext(StudioThemeContext);
  if (!context) throw new Error("useStudioTheme must be used inside StudioThemeProvider.");
  return context;
}

export function StudioThemePicker() {
  const { resolvedTheme } = useStudioTheme();
  const { isAnimating, triggerSwipe } = useSwipeTheme();
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  const label = nextTheme === "dark" ? "Switch to dark theme" : "Switch to light theme";

  return (
    <TooltipIconButton
      aria-label={label}
      className="studio-theme-picker"
      disabled={isAnimating}
      onClick={() => triggerSwipe("top-right")}
      tooltip={label}
      type="button"
    >
      <Icon aria-hidden="true" icon={nextTheme === "dark" ? "solar:moon-linear" : "solar:sun-2-linear"} width={18} height={18} />
    </TooltipIconButton>
  );
}

function readThemePreference(): StudioThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
  } catch {
    return "light";
  }
}

function resolveSystemTheme(): ResolvedStudioTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
