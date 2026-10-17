#!/usr/bin/env python3
"""
Regenerate the site's artwork from the two source plates.

    python3 scripts/make-assets.py

Inputs (design sources, not shipped as-is):
    assets-src/backdrop.png   the pastel scene
    assets-src/owl.png        the mascot on a flat light ground

Outputs:
    src/assets/sky.jpg            the scene, optimized for the ASCII grid
    src/assets/tessera-mark.webp  the mascot, ground removed, cropped to its body
    public/favicon-*.png, icon-*.png, apple-touch-icon.png
    public/social-card.jpg

The owl's ground is removed by growing a region from the border through
near-white pixels, not by keying every white pixel: the eyes, glasses and the
chart card are white too, and they must stay opaque.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src"
ASSETS = ROOT / "src" / "assets"
PUBLIC = ROOT / "public"


def remove_ground(image: Image.Image, threshold: int = 232, spread: int = 14) -> Image.Image:
    """Flood-fill a flat light ground from the border and make it transparent."""
    image = image.convert("RGBA")
    width, height = image.size
    pixels = np.array(image)
    rgb = pixels[..., :3].astype(np.int16)
    backgroundish = (rgb.min(axis=2) > threshold) & ((rgb.max(axis=2) - rgb.min(axis=2)) < spread)

    seen = np.zeros((height, width), bool)
    queue: deque[tuple[int, int]] = deque()

    def seed(y: int, x: int) -> None:
        if backgroundish[y, x] and not seen[y, x]:
            seen[y, x] = True
            queue.append((y, x))

    for x in range(width):
        seed(0, x)
        seed(height - 1, x)
    for y in range(height):
        seed(y, 0)
        seed(y, width - 1)

    while queue:
        y, x = queue.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < height and 0 <= nx < width and backgroundish[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                queue.append((ny, nx))

    alpha = np.where(seen, 0, 255).astype(np.uint8)
    softened = np.array(Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(1.0)))
    pixels[..., 3] = softened
    out = Image.fromarray(pixels, "RGBA")
    return out.crop(out.getbbox())


def square_icon(subject: Image.Image, size: int, pad_ratio: float = 0.045) -> Image.Image:
    """The mascot on a transparent square — no plate behind it."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    box = int(size * (1 - pad_ratio * 2))
    scaled = subject.copy()
    scaled.thumbnail((box, box), Image.LANCZOS)
    canvas.alpha_composite(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2))
    return canvas


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)

    backdrop = Image.open(SRC / "backdrop.png").convert("RGB")
    # The plate is the artwork exactly as drawn — no tone map, no hue shift. The
    # grid samples it at 6px cells, so anything wider than a couple of thousand
    # pixels is detail no screen will ever see.
    plate = backdrop
    if plate.width > 1600:
        plate = plate.resize((1600, round(plate.height * 1600 / plate.width)), Image.LANCZOS)
    plate.save(ASSETS / "sky.jpg", quality=92, optimize=True, progressive=True)

    owl_full = remove_ground(Image.open(SRC / "owl.png"))

    # The floating stars are charming in the hero and mush at 16px, so the icon
    # and the bar mark crop in to the body before they are scaled down.
    width, height = owl_full.size
    owl_tight = owl_full.crop((int(width * 0.10), 0, int(width * 0.90), height))
    owl_tight.save(ASSETS / "tessera-mark.webp", quality=92, method=6)

    for size, name in [
        (32, "favicon-32.png"),
        (64, "favicon-64.png"),
        (180, "apple-touch-icon.png"),
        (192, "icon-192.png"),
        (512, "icon-512.png"),
    ]:
        square_icon(owl_tight, size).save(PUBLIC / name)

    # Social card: the scene, cropped to 1200×630, washed light under the copy.
    card = Image.new("RGB", (1200, 630))
    scale = max(1200 / backdrop.width, 630 / backdrop.height)
    scene = backdrop.resize(
        (round(backdrop.width * scale), round(backdrop.height * scale)), Image.LANCZOS
    )
    left = (scene.width - 1200) // 2
    top = (scene.height - 630) // 2
    card.paste(scene.crop((left, top, left + 1200, top + 630)))
    # A radial paper wash behind the copy area, built once with numpy.
    grid_y, grid_x = np.mgrid[0:630, 0:1200]
    distance = np.sqrt(((grid_x - 600) / 520) ** 2 + ((grid_y - 315) / 290) ** 2)
    strength = np.clip(1 - distance, 0, 1) ** 1.25
    wash = np.zeros((630, 1200, 4), np.uint8)
    wash[..., 0:3] = (250, 248, 255)
    wash[..., 3] = (strength * 210).astype(np.uint8)
    card = Image.alpha_composite(card.convert("RGBA"), Image.fromarray(wash, "RGBA"))

    subject = owl_tight.copy()
    subject.thumbnail((420, 420), Image.LANCZOS)
    card.alpha_composite(subject, (760, (630 - subject.height) // 2))
    card.convert("RGB").save(PUBLIC / "social-card.jpg", quality=90, optimize=True)


if __name__ == "__main__":
    main()
