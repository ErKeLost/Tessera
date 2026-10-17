# tessera site

The landing page: one screen, centred, the artwork printed as an ASCII mosaic
behind it, and the install command as the only action.

Scaffolded with the TanStack CLI in router-only mode
(`@tanstack/cli create --router-only --blank`), so it is the same stack as the
Orbit site: Vite + React + TypeScript, file-based TanStack Router, hand-written
CSS, no UI kit.

```bash
cd website
bun install
bun run dev        # http://localhost:8790
bun run build      # dist/
bun run preview
```

## One screen, three rows

```
┌──────────────────────────────────────────────┐
│ mark · Tessera          GitHub · EN/中        │   auto
│                                              │
│              Ask your data.                  │   1fr, centred
│            See the evidence.                 │
│    lede · npx pill · GitHub                  │
│                                              │
│              WORKS WITH                      │   auto
│   PostgreSQL MySQL SQLite Turso MongoDB      │
└──────────────────────────────────────────────┘
```

`100svh`, no scroll and no sections. Sizes are viewport functions, so the
composition holds from 1440×900 down to 320×640.

`src/routes/__root.tsx` owns the providers, the fixed sky and the three style
sheets; `src/routes/index.tsx` only owns the URL and renders `<Stage />`.

## The button is the command

`npx @open-tessera/studio@latest` is the call to action, in the same pastel pill
the Orbit site uses for its download. Pressing it copies the string exactly and
flips to "Copied" for 1.8s.

The command works on its own (Studio starts unconfigured and shows its settings
screen); appending a database URL skips that step, which the CLI accepts as a
positional argument.

## The sky is the artwork, on the grid

`src/lib/galaxy-dots.ts` is a copy of the Orbit module the app's backdrop is built
from: one 6px cell per sample, a 1px graph-paper gap, the plate drifting and
breathing as a single piece, a light sweep, twinkling stars, and slow motes.
`src/components/GalaxySky.tsx` drives it at 40ms frames, pauses when the tab is
hidden, and draws a still frame under `prefers-reduced-motion`.

The plate is the artwork **in its own colours, unmodified** — no tone map, no hue
shift, `sky.jpg` is just the source image resized. Because the scene is light, the
site is a light site: the cells are painted solid, the graph paper is dark, the
sparkles are white, and the ink under the copy is near-black. Orbit's dark version
spends its budget on alpha over a black sky; this one spends it on contrast.

Two things are Tessera's:

- **No meteors.** The artwork is already a sky of 3D five-point stars, so the
  motion is those stars. Big ones (68–128px) free-fall straight down under gravity
  — no sway, no trail — land on the floor, bounce once with a little squash and a
  dust ring, come down again, and the second time they go straight through the
  bottom of the frame and out of sight, then wait off-screen before dropping again.
  They are drawn as shapes, not as cells: a 6px mask cannot carry an inflated
  five-point solid with a gloss.

  The fall is real free fall scaled to the screen: `GRAVITY = 0.0015 px/ms²`
  (≈9.8 m/s² on a one-metre viewport), restitution `0.52`, terminal velocity
  `2.4 px/ms`. Change those three numbers in `GalaxySky.tsx` to change the weight.
- **The wash.** A shallow paper-coloured radial sits behind the copy so the words
  never land on a hard grid edge, and a matching vignette keeps the bar and the
  floor quiet. Both are in `.sky::after`.

The knobs, in the order to reach for them:

| what | where |
| --- | --- |
| cell colour and density | `INK` in `GalaxySky.tsx` (`nebulaPeak`, `nebulaGamma`, `sat`, `border`) |
| sparkles | `starFloor` / `starGap` in `INK`; colour is `SPARKLE` |
| star size / density / colours / wait | `spawnBouncer`, `STAR_PALETTES` in `GalaxySky.tsx` |
| fall weight, bounce, term. velocity | `GRAVITY`, `RESTITUTION`, `TERMINAL_VY` |
| top, bottom and copy washes | `.sky::after` in `styles/base.css` |
| paper, ink, hairlines | `styles/tokens.css` |

## Artwork

`scripts/make-assets.py` regenerates everything from `assets-src/`:

| source | output |
| --- | --- |
| `backdrop.png` (2560×1440) | `src/assets/sky.jpg` — the plate the grid samples, in its own colours |
| `owl.png` | `src/assets/tessera-mark.webp` — the mascot, ground removed |
| — | favicons, apple-touch icon, `public/social-card.jpg` |

The mascot's light ground is removed by growing a region from the border through
near-white pixels, not by keying every white pixel: the eyes, the glasses and the
chart card are white too and must stay opaque. The mark carries **no plate** —
transparent at every size. `sky.jpg` is only ever sampled to 6px cells; it is
never shown as an image.

Re-run the script after changing either source, then check the icon at 32px on
white and on dark before committing it.

## Copy

`src/content/copy.ts` holds every string in both languages. `zh` is declared as
`Copy`, so a missing or renamed string is a compile error rather than a silent
fallback to English. English is the default whatever the browser asks for;
`?lang=zh` and the corner switch override it and the choice is remembered.

Claims on the page are the product's own: local-first, governed tools, verifiable
evidence, durable session memory, and the five supported databases (PostgreSQL,
MySQL, SQLite, Turso, MongoDB). If a boundary changes in the runtime, change it
here in the same commit.

## Deploy

Live at **https://tessera-agent.netlify.app** (Netlify project `tessera-agent`, team
`erkelost`). The existing `open-tessera` project still serves the docs — this is a
separate site on purpose, so publishing the landing page never takes the docs down.

```bash
cd website
bun run build
npx netlify-cli deploy --prod --dir=dist
```

The CLI runs the `netlify.toml` build locally before uploading, so a deploy from a
clean checkout is self-contained. The config also carries immutable caching for
hashed assets and the single-page fallback; a deep link returns the page with 200.

Update `og:image` / `og:url` in `index.html` to absolute URLs once a custom domain
exists.
