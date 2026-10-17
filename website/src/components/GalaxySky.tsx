import { useEffect, useRef } from 'react'

import skyUrl from '../assets/sky.jpg'
import {
  createMotes,
  drawGalaxyPlate,
  galaxyBreath,
  galaxyDrift,
  galaxyGridPattern,
  galaxyPlateSize,
  GALAXY_INK,
  paintGalaxy,
  paintGalaxyMotes,
  paintGalaxyStars,
  paintGalaxySweep,
  type GalaxyInk,
  type GalaxyDrift,
  type GalaxyMote,
  type GalaxyStar,
} from '../lib/galaxy-dots'

/**
 * The sky, built the same way as the Orbit site's.
 *
 * `lib/galaxy-dots.ts` is a copy of the Orbit module (copied, not reimplemented):
 * the artwork sampled onto the 6px terminal grid, the plate drifting and breathing
 * as one piece, the paper's graph grid underneath, the light sweep, the twinkling
 * stars and the motes. Only the picture under it is Tessera's.
 *
 * No meteors: the Tessera artwork is itself a sky of 3D five-point stars, so the
 * motion belongs to that vocabulary. The stars already in the plate twinkle, the
 * plate drifts, dust wanders — and five-point stars of the same palette drift down
 * through the frame, slowly enough to read as falling rather than as a streak.
 *
 * The site is dark only, so the ink is read once from the page's own `--ink` and
 * the plate is stamped at that colour.
 */

const SOURCE = skyUrl
/** The app's own cadence: one blink every 40ms is not 60fps. */
const FRAME_MS = 40

/**
 * The ink budget, tuned for Tessera's plate.
 *
 * The plate is the artwork in its own colours on light paper, so a cell is painted
 * solid rather than as a faint wash on black: the mosaic has to read as the
 * picture. What Orbit spends on alpha over a dark sky is spent here on the graph
 * paper (dark) and on the sparkles (white).
 */
const INK: GalaxyInk = {
  ...GALAXY_INK,
  nebulaFloor: 0,
  nebulaPeak: 1,
  nebulaGamma: 1,
  sat: 1.02,
  border: 0.05,
  starFloor: 0.93,
  starGap: 0.12,
  starPeak: 0.9,
}

/** Dark ink for the grid and the dust; white for the sparkles in the artwork. */
const SPARKLE = '255, 255, 255'
/**
 * Falling stars.
 *
 * The artwork's own 3D stars, drawn rather than sampled: an inflated five-point
 * solid with a butter top, a pink underside, a specular gloss and a soft halo.
 * A 6px cell cannot carry that shape, so these are the one thing on the page that
 * is not on the grid.
 *
 * They fall, hit the floor, bounce once, come down again — and on the second
 * landing they fade out and wait, then drop again from above. Per star:
 * `fall` (0 bounces) → bounce → `fall` (1 bounce) → through the floor and out →
 * `wait` → `fall` again. Only the first landing collides; the second drop leaves.
 */
type Bouncer = {
  x: number
  y: number
  /** px per millisecond. */
  vy: number
  radius: number
  angle: number
  spin: number
  palette: StarPalette
  bounce: number
  /** 1 at the moment of impact, decaying: drives the squash and the flash. */
  squash: number
  state: 'fall' | 'wait'
  waitUntil: number
  alpha: number
  /** The last landing: when, and how wide, for the dust ring it kicks up. */
  impactAt: number
  impactX: number
}

type StarPalette = { light: string; body: string; edge: string; glow: string }

const STAR_PALETTES: StarPalette[] = [
  { light: '#fff8de', body: '#ffd98f', edge: '#ffae7a', glow: '#ffcf9e' },
  { light: '#fff0f8', body: '#ffb8de', edge: '#d97fb6', glow: '#ffb2d5' },
  { light: '#f6f1ff', body: '#c9b4ff', edge: '#8e6fe0', glow: '#b9a6ff' },
  { light: '#ecfff9', body: '#9fe8cf', edge: '#4fbf9f', glow: '#93e8d6' },
]

/**
 * Gravity, in px per ms².
 *
 * Free fall, not a float: a star crosses the frame in a bit over a second and
 * arrives at ~1.6 px/ms. Scaled to the screen, this is close to 9.8 m/s² on a
 * one-metre-tall viewport — real enough to read as weight, slow enough to watch.
 */
const GRAVITY = 0.0015
/** What the floor gives back. */
const RESTITUTION = 0.52
/** Above this the star is a blur; the frame is only 25fps. */
const TERMINAL_VY = 2.4

function spawnBouncer(width: number, height: number, delay = 0): Bouncer {
  const radius = 34 + Math.random() * 30
  return {
    x: radius * 2 + Math.random() * (width - radius * 4),
    y: -radius * 2.4 - Math.random() * height * 0.4,
    vy: 0,
    radius,
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() < 0.5 ? -1 : 1) * (0.0004 + Math.random() * 0.0005),
    palette: STAR_PALETTES[Math.floor(Math.random() * STAR_PALETTES.length)]!,
    bounce: 0,
    squash: 0,
    state: 'wait',
    waitUntil: delay,
    alpha: 0.92 + Math.random() * 0.08,
    impactAt: 0,
    impactX: 0,
  }
}

/** Restart a star above the frame, and let it wait a beat first. */
function resetBouncer(star: Bouncer, width: number) {
  star.radius = 34 + Math.random() * 30
  star.x = star.radius * 2 + Math.random() * (width - star.radius * 4)
  star.y = -star.radius * 2.4
  star.vy = 0
  star.angle = Math.random() * Math.PI * 2
  star.spin = (Math.random() < 0.5 ? -1 : 1) * (0.0004 + Math.random() * 0.0005)
  star.palette = STAR_PALETTES[Math.floor(Math.random() * STAR_PALETTES.length)]!
  star.bounce = 0
  star.squash = 0
  star.state = 'fall'
  star.alpha = 0.92 + Math.random() * 0.08
  star.impactAt = 0
  star.impactX = 0
}

function updateBouncers(
  stars: Bouncer[],
  dt: number,
  now: number,
  width: number,
  height: number,
) {
  for (const star of stars) {
    if (star.state === 'wait') {
      if (now >= star.waitUntil) resetBouncer(star, width)
      continue
    }

    star.vy += GRAVITY * dt
    star.vy = Math.min(star.vy, TERMINAL_VY)
    star.y += star.vy * dt
    star.angle += star.spin * dt
    star.squash = Math.max(0, star.squash - dt / 260)

    // Two landings, and only the first one is a collision. The second drop goes
    // straight through the frame and off the bottom — it is not landing again.
    if (star.bounce > 1) {
      if (star.y - star.radius > height + 24) {
        star.state = 'wait'
        star.waitUntil = now + 5000 + Math.random() * 4000
      }
      continue
    }

    const floor = height - star.radius * 0.9
    if (star.y >= floor) {
      star.y = floor
      star.impactAt = now
      star.impactX = star.x
      star.squash = Math.min(1, 0.45 + star.vy * 0.5)
      star.spin *= 0.72
      if (star.bounce === 0) {
        // One bounce, with the floor taking its share of the energy back.
        star.vy = -star.vy * RESTITUTION
        star.bounce = 1
      } else {
        // Second landing: no floor any more, it is already on its way out.
        star.bounce = 2
        star.squash = 1
      }
    }
  }
}

/** A five-point outline, points up, `r` from centre to tip. */
function starPath(ctx: CanvasRenderingContext2D, r: number) {
  const inner = r * 0.44
  ctx.beginPath()
  for (let point = 0; point < 10; point += 1) {
    const radius = point % 2 === 0 ? r : inner
    const angle = (Math.PI / 5) * point - Math.PI / 2
    const x = Math.cos(angle) * radius
    const y = Math.sin(angle) * radius
    if (point === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function paintStar(ctx: CanvasRenderingContext2D, r: number, palette: StarPalette) {
  // Thickness: the silhouette again, a little lower, in the darkest stop.
  ctx.save()
  ctx.translate(0, r * 0.17)
  starPath(ctx, r)
  ctx.fillStyle = palette.edge
  ctx.fill()
  ctx.restore()

  // Face: butter at the top, the deep stop at the underside.
  const face = ctx.createLinearGradient(0, -r, 0, r)
  face.addColorStop(0, palette.light)
  face.addColorStop(0.56, palette.body)
  face.addColorStop(1, palette.edge)
  starPath(ctx, r)
  ctx.fillStyle = face
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)'
  ctx.lineWidth = Math.max(1, r * 0.05)
  ctx.stroke()

  // Gloss: clipped to the silhouette so it reads as a surface, not a bubble.
  ctx.save()
  starPath(ctx, r)
  ctx.clip()
  const gloss = ctx.createRadialGradient(-r * 0.26, -r * 0.36, 0, -r * 0.26, -r * 0.36, r * 0.62)
  gloss.addColorStop(0, 'rgba(255, 255, 255, 0.9)')
  gloss.addColorStop(0.55, 'rgba(255, 255, 255, 0.28)')
  gloss.addColorStop(1, 'rgba(255, 255, 255, 0)')
  ctx.fillStyle = gloss
  ctx.fillRect(-r, -r, r * 2, r * 2)
  ctx.restore()
}

function paintBouncers(
  ctx: CanvasRenderingContext2D,
  stars: Bouncer[],
  now: number,
  width: number,
) {
  for (const star of stars) {
    if (star.state === 'wait') continue

    const alpha = star.alpha
    if (alpha <= 0.02) continue

    // Free fall is straight down: no sway, no curve — gravity and a bounce.
    const x = Math.min(Math.max(star.x, star.radius), width - star.radius)
    if (star.y < -star.radius * 3) continue

    // The squash is a landing, not a jelly: it decays before the next frame.
    const squash = star.squash
    const scaleX = 1 + squash * 0.16
    const scaleY = 1 - squash * 0.16

    // The dust ring from the landing, a beat behind the star itself.
    const sinceImpact = now - star.impactAt
    if (star.bounce < 2 && sinceImpact >= 0 && sinceImpact < 420) {
      const progress = sinceImpact / 420
      ctx.save()
      ctx.globalAlpha = 0.5 * (1 - progress) * alpha
      ctx.strokeStyle = star.palette.edge
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.ellipse(
        star.impactX,
        star.y + star.radius * 0.86,
        star.radius * (0.5 + progress * 1.5),
        star.radius * (0.14 + progress * 0.3),
        0,
        0,
        Math.PI * 2,
      )
      ctx.stroke()
      ctx.restore()
    }

    ctx.save()
    ctx.translate(x, star.y)
    ctx.scale(scaleX, scaleY)
    ctx.rotate(star.angle)
    ctx.globalAlpha = alpha
    ctx.shadowColor = star.palette.glow
    ctx.shadowBlur = star.radius * 0.8
    paintStar(ctx, star.radius, star.palette)
    ctx.restore()
  }
  ctx.globalAlpha = 1
}

function inkRgb(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()
  const match = value.match(/\d+/g)
  if (!match || match.length < 3) return '245, 242, 255'
  return `${match[0]}, ${match[1]}, ${match[2]}`
}

export function GalaxySky() {
  const root = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const host = root.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!host || !canvas || !ctx) return

    let raf = 0
    let lastFrame = 0
    let rgb = inkRgb()
    let pattern: CanvasPattern | null = null
    let stars: GalaxyStar[] = []
    let drift: GalaxyDrift = { x: 0, y: 0 }
    let float = { x: true, y: true }
    let pointer: { x: number; y: number } | null = null
    let motes: GalaxyMote[] = []
    let bouncers: Bouncer[] = []
    let width = 0
    let height = 0
    let ready = false

    const plate = document.createElement('canvas')
    const plateCtx = plate.getContext('2d')
    const image = new Image()
    const still = window.matchMedia('(prefers-reduced-motion: reduce)')

    const layout = () => {
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      width = rect.width
      height = rect.height
      // One CSS pixel per pixel, like the app: the plate only lands on whole
      // pixels, and nearest-neighbour keeps every square square.
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.imageSmoothingEnabled = false

      motes = createMotes(width, height)
      // Staggered, so the sky is never three stars landing at the same instant.
      const count = width < 700 ? 1 : 2
      bouncers = Array.from({ length: count }, (_, index) =>
        spawnBouncer(width, height, performance.now() + index * 6000 + Math.random() * 2000),
      )
      // Dev only: the falling stars are easier to tune when their state is readable.
      if (import.meta.env.DEV) (window as unknown as { __stars?: Bouncer[] }).__stars = bouncers
      if (!ready) return

      const size = galaxyPlateSize(width, height)
      plate.width = size.width
      plate.height = size.height
      plateCtx?.setTransform(1, 0, 0, 1, 0, 0)

      if (plateCtx) {
        const stamp = paintGalaxy(plateCtx, {
          image,
          imageWidth: image.naturalWidth,
          imageHeight: image.naturalHeight,
          width,
          height,
          rgb,
          ink: INK,
        })
        stars = stamp.stars
        float = stamp.float
      }
      pattern = galaxyGridPattern(ctx, rgb, INK)
    }

    const draw = (time: number) => {
      if (document.hidden) {
        raf = 0
        return
      }
      raf = requestAnimationFrame(draw)
      if (time - lastFrame < FRAME_MS) return
      const dt = Math.min(120, time - lastFrame || FRAME_MS)
      lastFrame = time

      const motion = !still.matches
      const clock = motion ? time : 0

      drift = galaxyDrift(clock, motion, float, pointer)
      ctx.clearRect(0, 0, width, height)
      ctx.imageSmoothingEnabled = false
      if (pattern) {
        ctx.globalAlpha = 1
        ctx.fillStyle = pattern
        ctx.fillRect(0, 0, width, height)
      }
      drawGalaxyPlate(ctx, plate, drift, galaxyBreath(clock, motion))
      paintGalaxySweep(ctx, clock, width, height)
      paintGalaxyStars(ctx, stars, motion ? time : 180, SPARKLE, INK, drift)
      if (!motion) return

      updateBouncers(bouncers, dt, time, width, height)
      paintBouncers(ctx, bouncers, time, width)
      paintGalaxyMotes(ctx, motes, time, width, height, rgb, INK)
    }

    const start = () => {
      if (raf) return
      lastFrame = 0
      raf = requestAnimationFrame(draw)
    }

    image.onload = () => {
      ready = true
      layout()
      start()
    }
    image.src = SOURCE
    layout()

    const onVisible = () => {
      if (!document.hidden) start()
    }
    document.addEventListener('visibilitychange', onVisible)
    still.addEventListener('change', onVisible)

    // A few pixels of give under the cursor, exactly as in the app.
    const onPointerMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return
      pointer = {
        x: Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1)),
        y: Math.max(-1, Math.min(1, ((event.clientY - rect.top) / rect.height) * 2 - 1)),
      }
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    const resize = new ResizeObserver(() => {
      layout()
      onVisible()
    })
    resize.observe(host)

    return () => {
      cancelAnimationFrame(raf)
      image.onload = null
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('visibilitychange', onVisible)
      still.removeEventListener('change', onVisible)
      resize.disconnect()
    }
  }, [])

  return (
    <div ref={root} aria-hidden className="galaxy-sky">
      <canvas ref={canvasRef} />
    </div>
  )
}
