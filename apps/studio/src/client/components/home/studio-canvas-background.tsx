import { Dithering, GrainGradient, ImageDithering } from "@paper-design/shaders-react";
import { useReducedMotion } from "motion/react";
import { useStudioTheme } from "../../studio-theme";

const RIDGE_IMAGE = new URL(
  "../../../../../docs/public/images/data-elements-blue-ridge.png",
  import.meta.url,
).href;

export function StudioCanvasBackground() {
  const reduceMotion = useReducedMotion() ?? false;
  const { resolvedTheme } = useStudioTheme();
  const isLight = resolvedTheme === "light";

  return (
    <div aria-hidden="true" className="studio-home-canvas">
      <ImageDithering
        className="studio-home-canvas-ridge"
        colorBack={isLight ? "#f1f1f1" : "#050505"}
        colorFront={isLight ? "#c8c8c8" : "#3a3a3a"}
        colorHighlight={isLight ? "#ffffff" : "#d8d8d8"}
        colorSteps={5}
        fit="cover"
        image={RIDGE_IMAGE}
        inverted={false}
        maxPixelCount={1920 * 1080}
        minPixelRatio={1}
        originalColors={false}
        scale={1.04}
        size={2.25}
        speed={0}
        type="4x4"
      />
      <GrainGradient
        className="studio-home-canvas-light"
        colorBack="#00000000"
        colors={isLight ? ["#ffffff00", "#e5e5e5", "#bdbdbd", "#f4f4f400"] : ["#05050500", "#242424", "#6b6b6b", "#11111100"]}
        intensity={0.72}
        maxPixelCount={1920 * 1080}
        minPixelRatio={1}
        noise={0.42}
        shape="corners"
        softness={0.88}
        speed={reduceMotion ? 0 : 0.2}
      />
      <Dithering
        className="studio-home-canvas-warp"
        colorBack="#00000000"
        colorFront={isLight ? "#7777772b" : "#bdbdbd30"}
        maxPixelCount={1920 * 1080}
        minPixelRatio={1}
        shape="warp"
        size={3}
        speed={reduceMotion ? 0 : 0.14}
        type="4x4"
      />
      <div className="studio-home-canvas-shade" />
    </div>
  );
}
