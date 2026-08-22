"use client";

import { useEffect, useRef } from "react";

const HERO_IMAGE = "/images/tessera-agent-whale-window.png";

export const PANEL_IMAGES = {
  blue: "/images/tessera-agent-blue-flow.png",
  indigo: "/images/tessera-agent-indigo-flow.png",
  cyan: "/images/tessera-agent-cyan-ridge.png",
  plum: "/images/tessera-agent-plum-flow.png",
  sage: "/images/tessera-agent-sage-flow.png",
  gold: "/images/tessera-agent-gold-field.png",
} as const;

export type PanelImageKey = keyof typeof PANEL_IMAGES;

const PANEL_PALETTES: Record<PanelImageKey, Readonly<{ hot: string; mid: string; deep: string; particle: string }>> = {
  blue: { hot: "111, 218, 255", mid: "45, 108, 255", deep: "12, 58, 134", particle: "126, 198, 255" },
  indigo: { hot: "194, 190, 255", mid: "119, 126, 235", deep: "42, 48, 126", particle: "168, 174, 255" },
  cyan: { hot: "112, 242, 255", mid: "24, 181, 205", deep: "7, 75, 98", particle: "108, 224, 236" },
  plum: { hot: "255, 168, 222", mid: "192, 92, 166", deep: "80, 27, 72", particle: "232, 140, 203" },
  sage: { hot: "220, 242, 184", mid: "144, 182, 129", deep: "54, 77, 55", particle: "194, 226, 166" },
  gold: { hot: "255, 226, 130", mid: "213, 161, 43", deep: "93, 70, 18", particle: "244, 207, 108" },
};

type BackdropVariant = "hero" | "panel";

type Particle = Readonly<{
  x: number;
  y: number;
  radius: number;
  alpha: number;
  speed: number;
  warmth: number;
}>;

type CoverPlacement = Readonly<{
  x: number;
  y: number;
  scale: number;
  width: number;
  height: number;
}>;

type ImageRegion = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  amplitude: number;
  speed: number;
  phase: number;
}>;

const DOLPHIN_REGIONS: readonly ImageRegion[] = [
  { x: .68, y: .19, width: .17, height: .14, amplitude: 2.8, speed: .56, phase: 1.8 },
  { x: .645, y: .245, width: .255, height: .445, amplitude: 6.4, speed: .4, phase: .15 },
];

const CURTAIN_REGIONS: readonly ImageRegion[] = [
  { x: .405, y: 0, width: .265, height: .965, amplitude: 8.5, speed: .43, phase: .2 },
  { x: .805, y: 0, width: .125, height: .99, amplitude: 5.5, speed: .37, phase: 2.1 },
];

export interface HeroBackdropProps {
  variant?: BackdropVariant;
  imageKey?: PanelImageKey;
}

export function HeroBackdrop({ variant = "hero", imageKey = "blue" }: HeroBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (!canvasElement) return;
    const drawingContext = canvasElement.getContext("2d", { alpha: false });
    if (!drawingContext) return;
    const canvas: HTMLCanvasElement = canvasElement;
    const context: CanvasRenderingContext2D = drawingContext;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = variant === "hero" ? "high" : "low";

    let width = 0;
    let height = 0;
    let frame = 0;
    let ready = false;
    let inViewport = true;
    let documentVisible = document.visibilityState !== "hidden";
    let lightMode = !document.documentElement.classList.contains("dark");
    let pointerX = 0;
    let pointerY = 0;
    let currentX = 0;
    let currentY = 0;
    let particles: Particle[] = [];

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const maxRatio = variant === "hero" ? 2 : 1.35;
      const ratio = Math.min(window.devicePixelRatio || 1, maxRatio);
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const particleLimit = variant === "hero" ? 110 : 52;
      particles = Array.from(
        { length: Math.round(Math.min(particleLimit, width / (variant === "hero" ? 12 : 20))) },
        (_, index) => ({
          x: hash(index * 2.71 + 1) * width,
          y: hash(index * 6.19 + 3) * height,
          radius: .35 + hash(index * 3.41 + 8) * 1.25,
          alpha: .025 + hash(index * 8.27 + 2) * .1,
          speed: .35 + hash(index * 5.33 + 7) * .85,
          warmth: hash(index * 7.91 + 4),
        }),
      );
      if (ready) drawScene(reduceMotion ? 0 : performance.now());
    }

    function handlePointer(event: PointerEvent) {
      pointerX = (event.clientX / Math.max(window.innerWidth, 1) - .5) * 2;
      pointerY = (event.clientY / Math.max(window.innerHeight, 1) - .5) * 2;
      requestFrame();
    }

    function handleVisibility() {
      documentVisible = document.visibilityState !== "hidden";
      if (documentVisible) requestFrame();
      else stopFrame();
    }

    function handleThemeChange() {
      lightMode = !document.documentElement.classList.contains("dark");
      if (ready) drawScene(reduceMotion ? 0 : performance.now());
      requestFrame();
    }

    function stopFrame() {
      cancelAnimationFrame(frame);
      frame = 0;
    }

    function requestFrame() {
      if (reduceMotion || !ready || !inViewport || !documentVisible || frame !== 0) return;
      frame = requestAnimationFrame(animate);
    }

    function animate(elapsed: number) {
      frame = 0;
      if (!ready || !inViewport || !documentVisible) return;
      drawScene(elapsed);
      requestFrame();
    }

    function drawScene(elapsed: number) {
      if (!ready) return;
      const time = elapsed / 1000;
      currentX += (pointerX - currentX) * .032;
      currentY += (pointerY - currentY) * .032;

      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.filter = "none";
      context.fillStyle = lightMode ? "#f8fafc" : "#020611";
      context.fillRect(0, 0, width, height);

      const interactive = variant === "hero" && !reduceMotion;
      const driftX = interactive ? currentX * 8 + Math.sin(time * .13) * 2.2 : Math.sin(time * .09) * 1.2;
      const driftY = interactive ? currentY * 4 + Math.cos(time * .11) * 1.5 : Math.cos(time * .08) * .8;
      const zoom = reduceMotion ? 1.012 : 1.018 + Math.sin(time * .08) * .0025;
      const focusX = width < 720 ? .73 : variant === "panel" ? .56 : .5;

      const rawCanvas = lightMode && variant === "panel";
      context.filter = rawCanvas ? "none" : "saturate(1.025) contrast(1.035) brightness(.94)";
      const placement = drawImageCover(context, image, width, height, driftX, driftY, zoom, focusX);
      context.filter = "none";

      if (!reduceMotion) {
        if (variant === "hero") {
          drawDolphins(context, image, placement, time);
          drawCurtains(context, image, placement, time, currentX);
          drawWindowGlow(context, width, height, time);
        } else {
          drawDataFlow(context, image, placement, width, height, time, imageKey);
        }
        drawParticles(context, particles, height, time, variant, imageKey);
      }

      if (!rawCanvas) {
        drawScrim(context, width, height, variant, false);
        drawVignette(context, width, height, false);
      }
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const intersectionObserver = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(
          ([entry]) => {
            inViewport = entry?.isIntersecting ?? true;
            if (inViewport) {
              if (ready) drawScene(reduceMotion ? 0 : performance.now());
              requestFrame();
            } else stopFrame();
          },
          { rootMargin: "160px" },
        );
    intersectionObserver?.observe(canvas);

    if (variant === "hero") window.addEventListener("pointermove", handlePointer, { passive: true });
    document.addEventListener("visibilitychange", handleVisibility);
    const themeObserver = new MutationObserver(handleThemeChange);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    image.addEventListener(
      "load",
      () => {
        ready = true;
        resize();
        requestFrame();
      },
      { once: true },
    );
    image.src = variant === "hero" ? HERO_IMAGE : PANEL_IMAGES[imageKey];

    return () => {
      resizeObserver.disconnect();
      intersectionObserver?.disconnect();
      if (variant === "hero") window.removeEventListener("pointermove", handlePointer);
      document.removeEventListener("visibilitychange", handleVisibility);
      themeObserver.disconnect();
      stopFrame();
      image.src = "";
    };
  }, [imageKey, variant]);

  return <canvas aria-hidden="true" ref={canvasRef} />;
}

function drawImageCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
  focusX: number,
): CoverPlacement {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * zoom;
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  const x = (width - drawWidth) * focusX + offsetX;
  const y = (height - drawHeight) * .5 + offsetY;
  context.drawImage(image, x, y, drawWidth, drawHeight);
  return { x, y, scale, width: drawWidth, height: drawHeight };
}

function drawDolphins(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  placement: CoverPlacement,
  time: number,
) {
  for (const [index, region] of DOLPHIN_REGIONS.entries()) {
    const motionScale = 1;
    const floatX = Math.sin(time * (region.speed * .72) + region.phase) * (index === 0 ? 2.8 : 4.2) * motionScale;
    const floatY = Math.cos(time * region.speed + region.phase) * (index === 0 ? 3.4 : 5.6) * motionScale;
    drawFlexRegion(context, image, placement, region, time, floatX, floatY, motionScale);
  }
}

function drawFlexRegion(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  placement: CoverPlacement,
  region: ImageRegion,
  time: number,
  floatX: number,
  floatY: number,
  motionScale: number,
) {
  const sourceX = region.x * image.naturalWidth;
  const sourceY = region.y * image.naturalHeight;
  const sourceWidth = region.width * image.naturalWidth;
  const sourceHeight = region.height * image.naturalHeight;
  const destinationX = placement.x + sourceX * placement.scale;
  const destinationY = placement.y + sourceY * placement.scale;
  const destinationWidth = sourceWidth * placement.scale;
  const destinationHeight = sourceHeight * placement.scale;
  const sliceWidth = Math.max(3, sourceWidth / 46);

  context.save();
  context.beginPath();
  context.rect(destinationX, destinationY, destinationWidth, destinationHeight);
  context.clip();
  context.globalAlpha = .985;

  for (let sliceX = sourceX; sliceX < sourceX + sourceWidth; sliceX += sliceWidth) {
    const sourceSliceWidth = Math.min(sliceWidth + 1, sourceX + sourceWidth - sliceX);
    const progress = (sliceX - sourceX) / sourceWidth;
    const tailWeight = .28 + progress * .72;
    const wave = Math.sin(time * region.speed * 2.2 + region.phase + progress * Math.PI * 2.35);
    const lift = floatY + wave * region.amplitude * tailWeight * motionScale;
    const glide = floatX + Math.cos(time * region.speed + progress * 3.2) * region.amplitude * .16 * motionScale;
    context.drawImage(
      image,
      sliceX,
      sourceY,
      sourceSliceWidth,
      sourceHeight,
      placement.x + sliceX * placement.scale + glide,
      destinationY + lift,
      sourceSliceWidth * placement.scale + 1,
      destinationHeight,
    );
  }

  context.restore();
}

function drawCurtains(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  placement: CoverPlacement,
  time: number,
  pointerX: number,
) {
  for (const region of CURTAIN_REGIONS) {
    const sourceX = region.x * image.naturalWidth;
    const sourceY = region.y * image.naturalHeight;
    const sourceWidth = region.width * image.naturalWidth;
    const sourceHeight = region.height * image.naturalHeight;
    const destinationX = placement.x + sourceX * placement.scale;
    const destinationY = placement.y + sourceY * placement.scale;
    const destinationWidth = sourceWidth * placement.scale;
    const destinationHeight = sourceHeight * placement.scale;
    const sliceHeight = Math.max(4, sourceHeight / 72);
    const motionScale = 1;

    context.save();
    context.beginPath();
    context.rect(destinationX, destinationY, destinationWidth, destinationHeight);
    context.clip();
    context.globalAlpha = .9;

    for (let sliceY = sourceY; sliceY < sourceY + sourceHeight; sliceY += sliceHeight) {
      const sourceSliceHeight = Math.min(sliceHeight + 1, sourceY + sourceHeight - sliceY);
      const progress = (sliceY - sourceY) / sourceHeight;
      const lowerWeight = .22 + progress * .78;
      const sway =
        Math.sin(time * region.speed * 2 + region.phase + progress * 5.8) *
          region.amplitude *
          lowerWeight *
          motionScale +
        pointerX * 1.8 * lowerWeight * motionScale;
      const breathe = Math.cos(time * region.speed + progress * 3.1) * .7 * motionScale;
      context.drawImage(
        image,
        sourceX,
        sliceY,
        sourceWidth,
        sourceSliceHeight,
        destinationX + sway,
        placement.y + sliceY * placement.scale + breathe,
        destinationWidth,
        sourceSliceHeight * placement.scale + 1,
      );
    }

    context.restore();
  }
}

function drawWindowGlow(context: CanvasRenderingContext2D, width: number, height: number, time: number) {
  const pulse = .82 + Math.sin(time * .32) * .18;
  const glow = context.createRadialGradient(width * .77, height * .34, 0, width * .77, height * .34, width * .31);
  glow.addColorStop(0, `rgba(255, 200, 111, ${.075 * pulse})`);
  glow.addColorStop(.46, `rgba(112, 163, 255, ${.035 * pulse})`);
  glow.addColorStop(1, "rgba(24, 72, 150, 0)");
  context.globalCompositeOperation = "screen";
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);
  context.globalCompositeOperation = "source-over";
}

function drawDataFlow(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  placement: CoverPlacement,
  width: number,
  height: number,
  time: number,
  imageKey: PanelImageKey,
) {
  const palette = PANEL_PALETTES[imageKey];
  context.save();
  context.globalCompositeOperation = "screen";
  context.globalAlpha = .28;

  const bands = [
    { y: .2, height: .17, phase: .3, speed: .19, alpha: .34 },
    { y: .49, height: .14, phase: 2.1, speed: .13, alpha: .25 },
    { y: .72, height: .1, phase: 4.2, speed: .23, alpha: .2 },
  ];

  for (const band of bands) {
    const sourceY = band.y * image.naturalHeight;
    const sourceHeight = band.height * image.naturalHeight;
    const destinationY = placement.y + sourceY * placement.scale;
    const destinationHeight = sourceHeight * placement.scale;
    const offset = Math.sin(time * band.speed + band.phase) * width * .035;
    const stripe = context.createLinearGradient(0, destinationY, width, destinationY + destinationHeight);
    stripe.addColorStop(0, `rgba(${palette.hot}, 0)`);
    stripe.addColorStop(.42, `rgba(${palette.hot}, ${band.alpha})`);
    stripe.addColorStop(.58, `rgba(${palette.mid}, ${band.alpha * .7})`);
    stripe.addColorStop(1, "rgba(12, 58, 134, 0)");
    context.fillStyle = stripe;
    context.fillRect(0, destinationY, width, destinationHeight);

    context.globalAlpha = .44;
    context.drawImage(
      image,
      0,
      sourceY,
      image.naturalWidth,
      sourceHeight,
      placement.x + offset,
      destinationY,
      placement.width,
      destinationHeight,
    );
    context.globalAlpha = .28;
  }

  const sweepX = ((time * 46) % (width + 180)) - 90;
  const sweep = context.createLinearGradient(sweepX - 90, 0, sweepX + 90, 0);
  sweep.addColorStop(0, `rgba(${palette.hot}, 0)`);
  sweep.addColorStop(.5, `rgba(${palette.hot}, .18)`);
  sweep.addColorStop(1, `rgba(${palette.hot}, 0)`);
  context.fillStyle = sweep;
  context.fillRect(0, 0, width, height);
  context.restore();
}

function drawParticles(
  context: CanvasRenderingContext2D,
  particles: readonly Particle[],
  height: number,
  time: number,
  variant: BackdropVariant,
  imageKey: PanelImageKey,
) {
  context.save();
  context.globalCompositeOperation = "screen";
  for (const particle of particles) {
    const y = (particle.y - time * particle.speed * 1.7 + height) % height;
    const pulse = .62 + Math.sin(time * .58 + particle.x * .018) * .38;
    const color = variant === "hero" ? "255, 205, 137" : PANEL_PALETTES[imageKey].particle;
    context.fillStyle = `rgba(${color}, ${particle.alpha * pulse})`;
    context.beginPath();
    context.arc(particle.x + Math.sin(time * .13 + particle.y) * 2.4, y, particle.radius, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawLightThemeWash(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  variant: BackdropVariant,
) {
  const wash = context.createLinearGradient(0, 0, width * (variant === "hero" ? .74 : 1), 0);
  wash.addColorStop(0, "rgba(248, 250, 252, .98)");
  wash.addColorStop(variant === "hero" ? .38 : .52, "rgba(248, 250, 252, .9)");
  wash.addColorStop(variant === "hero" ? .72 : .9, "rgba(248, 250, 252, .18)");
  wash.addColorStop(1, "rgba(248, 250, 252, 0)");
  context.fillStyle = wash;
  context.fillRect(0, 0, width, height);
}

function drawScrim(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  variant: BackdropVariant,
  lightMode: boolean,
) {
  if (lightMode) {
    if (variant === "panel") {
      context.fillStyle = "rgba(248, 250, 252, .22)";
      context.fillRect(0, 0, width, height);
    }

    const horizontal = context.createLinearGradient(0, 0, width, 0);
    horizontal.addColorStop(0, variant === "hero" ? "rgba(248, 250, 252, .32)" : "rgba(248, 250, 252, .22)");
    horizontal.addColorStop(.55, "rgba(248, 250, 252, .06)");
    horizontal.addColorStop(1, "rgba(255, 255, 255, .12)");
    context.fillStyle = horizontal;
    context.fillRect(0, 0, width, height);

    const vertical = context.createLinearGradient(0, 0, 0, height);
    vertical.addColorStop(0, "rgba(255, 255, 255, .08)");
    vertical.addColorStop(.7, "rgba(255, 255, 255, 0)");
    vertical.addColorStop(1, variant === "hero" ? "rgba(15, 23, 42, .1)" : "rgba(15, 23, 42, .06)");
    context.fillStyle = vertical;
    context.fillRect(0, 0, width, height);
    return;
  }

  if (variant === "panel") {
    context.fillStyle = "rgba(2, 6, 14, .46)";
    context.fillRect(0, 0, width, height);
  }

  const horizontal = context.createLinearGradient(0, 0, width, 0);
  horizontal.addColorStop(0, variant === "hero" ? "rgba(1, 5, 13, .5)" : "rgba(1, 5, 13, .24)");
  horizontal.addColorStop(.4, variant === "hero" ? "rgba(1, 5, 13, .24)" : "rgba(1, 5, 13, .14)");
  horizontal.addColorStop(.72, "rgba(2, 6, 15, .04)");
  horizontal.addColorStop(1, "rgba(2, 6, 15, .12)");
  context.fillStyle = horizontal;
  context.fillRect(0, 0, width, height);

  const vertical = context.createLinearGradient(0, 0, 0, height);
  vertical.addColorStop(0, "rgba(0, 2, 8, .06)");
  vertical.addColorStop(.55, "rgba(0, 2, 8, 0)");
  vertical.addColorStop(1, variant === "hero" ? "rgba(0, 2, 8, .52)" : "rgba(0, 2, 8, .3)");
  context.fillStyle = vertical;
  context.fillRect(0, 0, width, height);
}

function drawVignette(context: CanvasRenderingContext2D, width: number, height: number, lightMode: boolean) {
  const vignette = context.createRadialGradient(width * .68, height * .38, width * .1, width * .53, height * .48, width * .82);
  vignette.addColorStop(.44, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, lightMode ? "rgba(15, 23, 42, .1)" : "rgba(0, 2, 8, .42)");
  context.fillStyle = vignette;
  context.fillRect(0, 0, width, height);
}

function hash(value: number) {
  const result = Math.sin(value * 12.9898) * 43758.5453;
  return result - Math.floor(result);
}
