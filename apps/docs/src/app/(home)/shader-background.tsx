"use client";

import dynamic from "next/dynamic";
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  DitheringProps,
  GrainGradientProps,
} from "@paper-design/shaders-react";

const GrainGradient = dynamic(
  () =>
    import("@paper-design/shaders-react").then(
      (module) => module.GrainGradient,
    ),
  { ssr: false, loading: () => null },
);

const Dithering = dynamic(
  () =>
    import("@paper-design/shaders-react").then(
      (module) => module.Dithering,
    ),
  { ssr: false, loading: () => null },
);

type ShaderVariant = "grain" | "dithering";

export interface ShaderBackgroundProps {
  /** The shader used to add a soft grain or a structured halftone layer. */
  variant?: ShaderVariant;
  className?: string;
}

type ShaderProps =
  | GrainGradientProps
  | DitheringProps;

/**
 * A defensive boundary for synchronous errors thrown while a shader mounts.
 * The image below this layer remains the visual fallback.
 */
class ShaderErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  // Keep this method intentionally quiet: an unavailable WebGL context is a
  // supported fallback, not an application error that should pollute a page's
  // console.
  componentDidCatch(_error: unknown, _info: ErrorInfo) {}

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function supportsWebGL2(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", {
      failIfMajorPerformanceCaveat: true,
    });
    return context !== null;
  } catch {
    return false;
  }
}

function getIsDarkTheme(): boolean {
  return document.documentElement.classList.contains("dark");
}

/**
 * Render an optional Paper Shader over a static image. It is deliberately
 * client-only: WebGL is feature-detected before the dynamic shader is mounted,
 * and the layer never owns layout or pointer events.
 */
export function ShaderBackground({
  variant = "grain",
  className,
}: ShaderBackgroundProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [canRender, setCanRender] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(motionQuery.matches);
    updateMotion();
    motionQuery.addEventListener("change", updateMotion);

    setIsDark(getIsDarkTheme());
    setCanRender(supportsWebGL2());

    const themeObserver = new MutationObserver(() => {
      setIsDark(getIsDarkTheme());
    });
    themeObserver.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });

    return () => {
      motionQuery.removeEventListener("change", updateMotion);
      themeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const element = hostRef.current;
    if (!element || !canRender) return;

    if (reducedMotion || typeof IntersectionObserver === "undefined") {
      setVisible(!reducedMotion);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: "160px" },
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, [canRender, reducedMotion]);

  const shaderProps = getShaderProps(variant, isDark, visible && !reducedMotion);

  return (
    <div
      aria-hidden="true"
      className={className}
      data-home-shader-layer
      ref={hostRef}
    >
      {canRender && !reducedMotion ? (
        <ShaderErrorBoundary>
          {variant === "grain" ? (
            <GrainGradient
              {...(shaderProps as GrainGradientProps)}
            />
          ) : (
            <Dithering
              {...(shaderProps as DitheringProps)}
            />
          )}
        </ShaderErrorBoundary>
      ) : null}
    </div>
  );
}

function getShaderProps(
  variant: ShaderVariant,
  isDark: boolean,
  playing: boolean,
): ShaderProps {
  if (variant === "dithering") {
    return {
      colorBack: "#00000000",
      // The halftone is structural rather than a second brand colour. The
      // subdued green only marks an active, connected Agent work surface.
      colorFront: isDark ? "#8ac7b7a6" : "#4f8f7ecc",
      shape: "warp",
      type: "4x4",
      size: 2.5,
      scale: 0.72,
      speed: 0,
      minPixelRatio: 1,
      maxPixelCount: 1280 * 900,
      className: "size-full",
    };
  }

  return {
    colorBack: "#00000000",
    colors: isDark
      ? ["#111112", "#171918", "#27312f", "#78aa9e"]
      : ["#e8e9e8", "#ced8d4", "#9bbcaf", "#5b887c"],
    softness: 0.94,
    intensity: 0.58,
    noise: 0.24,
    shape: "corners",
    speed: playing ? 0.16 : 0,
    minPixelRatio: 1,
    maxPixelCount: 1600 * 1000,
    className: "size-full",
  };
}
