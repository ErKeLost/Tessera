import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { flushSync } from "react-dom";

export type SwipeDirection =
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "left-to-right"
  | "right-to-left"
  | "top-to-bottom"
  | "bottom-to-top"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

type SwipeTheme = "light" | "dark";

type SwipeThemeContextValue = {
  theme: SwipeTheme;
  direction: SwipeDirection;
  triggerSwipe: (direction?: SwipeDirection) => void;
  isAnimating: boolean;
};

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => { ready: Promise<void> };
};

const SwipeThemeContext = createContext<SwipeThemeContextValue | undefined>(undefined);
const VIEW_TRANSITION_STYLE_ID = "great-ui-view-transition-styles";

export type SwipeThemeProviderProps = PropsWithChildren<{
  angle?: number;
  direction?: SwipeDirection;
  duration?: number;
  easing?: string;
  getKeyframes?: (direction: SwipeDirection) => Keyframe[] | PropertyIndexedKeyframes;
  onSwipe?: () => void;
  onThemeChange?: (theme: SwipeTheme) => void;
  theme: SwipeTheme;
}>;

export function useSwipeTheme(): SwipeThemeContextValue {
  const context = useContext(SwipeThemeContext);
  if (!context) throw new Error("useSwipeTheme must be used within SwipeThemeProvider.");
  return context;
}

// Adapted from Great UI's MIT-licensed Swipe Theme Provider.
export function SwipeThemeProvider({
  angle = 0,
  children,
  direction = "left",
  duration = 650,
  easing = "ease-in-out",
  getKeyframes,
  onSwipe,
  onThemeChange,
  theme,
}: SwipeThemeProviderProps) {
  const [isAnimating, setIsAnimating] = useState(false);
  const animatingRef = useRef(false);

  useEffect(() => installViewTransitionStyles(), []);

  const triggerSwipe = useCallback((selectedDirection?: SwipeDirection) => {
    if (animatingRef.current) return;

    const activeDirection = normalizeSwipeDirection(selectedDirection ?? direction);
    const baseAngle = activeDirection === "top-to-bottom" || activeDirection === "bottom-to-top" ? 0 : 90;
    const nextTheme = theme === "light" ? "dark" : "light";
    const applyTheme = () => {
      const root = document.documentElement;
      root.dataset.theme = nextTheme;
      root.style.colorScheme = nextTheme;
      root.classList.toggle("dark", nextTheme === "dark");
      onThemeChange?.(nextTheme);
      onSwipe?.();
    };
    const documentWithTransition = document as DocumentWithViewTransition;

    if (
      !documentWithTransition.startViewTransition
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      applyTheme();
      return;
    }

    animatingRef.current = true;
    setIsAnimating(true);
    const transition = documentWithTransition.startViewTransition(() => {
      flushSync(applyTheme);
    });
    const rawKeyframes = getKeyframes?.(activeDirection)
      ?? getSwipeThemeKeyframes(activeDirection, baseAngle + angle);
    const keyframes = addWebkitClipPath(rawKeyframes);

    void transition.ready
      .then(() => document.documentElement.animate(keyframes, {
        duration,
        easing,
        fill: "both",
        pseudoElement: "::view-transition-new(root)",
      }).finished)
      .catch(() => undefined)
      .finally(() => {
        animatingRef.current = false;
        setIsAnimating(false);
      });
  }, [angle, direction, duration, easing, getKeyframes, onSwipe, onThemeChange, theme]);

  const value = useMemo(() => ({
    direction,
    isAnimating,
    theme,
    triggerSwipe,
  }), [direction, isAnimating, theme, triggerSwipe]);

  return <SwipeThemeContext.Provider value={value}>{children}</SwipeThemeContext.Provider>;
}

export function normalizeSwipeDirection(direction: SwipeDirection): SwipeDirection {
  if (direction === "left") return "left-to-right";
  if (direction === "right") return "right-to-left";
  if (direction === "top") return "top-to-bottom";
  if (direction === "bottom") return "bottom-to-top";
  return direction;
}

export function getSwipeThemeKeyframes(direction: SwipeDirection, angle: number): Keyframe[] {
  if (direction === "top-left") {
    return [
      { clipPath: "polygon(0 0, 0 0, 0 0)" },
      { clipPath: "polygon(0 0, 200% 0, 0 200%)" },
    ];
  }
  if (direction === "top-right") {
    return [
      { clipPath: "polygon(100% 0, 100% 0, 100% 0)" },
      { clipPath: "polygon(100% 0, -100% 0, 100% 200%)" },
    ];
  }
  if (direction === "bottom-left") {
    return [
      { clipPath: "polygon(0 100%, 0 100%, 0 100%)" },
      { clipPath: "polygon(0 100%, 200% 100%, 0 -100%)" },
    ];
  }
  if (direction === "bottom-right") {
    return [
      { clipPath: "polygon(100% 100%, 100% 100%, 100% 100%)" },
      { clipPath: "polygon(100% 100%, -100% 100%, 100% -100%)" },
    ];
  }

  if (direction === "top-to-bottom" || direction === "bottom-to-top") {
    return verticalKeyframes(direction, angle);
  }
  if (direction === "left-to-right" || direction === "right-to-left") {
    return horizontalKeyframes(direction, angle);
  }
  return [];
}

function horizontalKeyframes(
  direction: "left-to-right" | "right-to-left",
  angle: number,
): Keyframe[] {
  const skew = Math.tan(((angle - 90) * Math.PI) / 180) * 100;
  const pad = Math.abs(skew);
  const left = -10 - pad;
  const right = 110 + pad;

  if (direction === "left-to-right") {
    return [
      { clipPath: `polygon(${left}% 0, ${left}% 0, ${left - skew}% 100%, ${left - skew}% 100%)` },
      { clipPath: `polygon(${left}% 0, ${right}% 0, ${right - skew}% 100%, ${left - skew}% 100%)` },
    ];
  }
  return [
    { clipPath: `polygon(${right}% 0, ${right}% 0, ${right - skew}% 100%, ${right - skew}% 100%)` },
    { clipPath: `polygon(${left}% 0, ${right}% 0, ${right - skew}% 100%, ${left - skew}% 100%)` },
  ];
}

function verticalKeyframes(
  direction: "top-to-bottom" | "bottom-to-top",
  angle: number,
): Keyframe[] {
  const skew = Math.tan((angle * Math.PI) / 180) * 100;
  const pad = Math.abs(skew);
  const top = -10 - pad;
  const bottom = 110 + pad;

  if (direction === "top-to-bottom") {
    return [
      { clipPath: `polygon(0 ${top}%, 100% ${top - skew}%, 100% ${top - skew}%, 0 ${top}%)` },
      { clipPath: `polygon(0 ${top}%, 100% ${top - skew}%, 100% ${bottom - skew}%, 0 ${bottom}%)` },
    ];
  }
  return [
    { clipPath: `polygon(0 ${bottom}%, 100% ${bottom - skew}%, 100% ${bottom - skew}%, 0 ${bottom}%)` },
    { clipPath: `polygon(0 ${top}%, 100% ${top - skew}%, 100% ${bottom - skew}%, 0 ${bottom}%)` },
  ];
}

function addWebkitClipPath(
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
): Keyframe[] | PropertyIndexedKeyframes {
  if (!Array.isArray(keyframes)) return keyframes;
  return keyframes.map((keyframe) => {
    if (typeof keyframe.clipPath !== "string") return keyframe;
    return { ...keyframe, webkitClipPath: keyframe.clipPath } as Keyframe;
  });
}

function installViewTransitionStyles(): () => void {
  if (document.getElementById(VIEW_TRANSITION_STYLE_ID)) return () => undefined;

  const style = document.createElement("style");
  style.id = VIEW_TRANSITION_STYLE_ID;
  style.textContent = `
    ::view-transition-old(root),
    ::view-transition-new(root) {
      animation: none !important;
      mix-blend-mode: normal !important;
      width: 100% !important;
      height: 100% !important;
    }
    ::view-transition-image-pair(root) { isolation: auto !important; }
    ::view-transition-old(root) { z-index: 1 !important; }
    ::view-transition-new(root) { z-index: 9999 !important; }
  `;
  document.head.appendChild(style);
  return () => style.remove();
}
