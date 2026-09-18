#!/usr/bin/env python3
"""Render the DMG window background as a multi-resolution TIFF.

Two pages (1x 540x380, 2x 1080x760) so Finder/NSImage picks the right
representation per display scale — a plain 2x PNG would be cropped instead.
Layout must match create-dmg flags in scripts/make-dmg.sh:
  window 540x380, icon-size 100, GatewayHub.app (140,195), Applications (400,195).

Palette is tied to the octopus logo: ink-black strokes on warm paper,
so the background is a cool slate grid with a dark ink arrow.
"""

import argparse
import os

from PIL import Image, ImageDraw

W, H = 540, 380
# Cool slate base, barely-there vertical falloff.
TOP = (0xF4, 0xF6, 0xF7)
BOTTOM = (0xE9, 0xED, 0xEF)
# Graph-paper grid: fine lines every cell, slightly stronger every 5th.
GRID_MINOR = (0xD9, 0xE0, 0xE3)
GRID_MAJOR = (0xCD, 0xD5, 0xDA)
CELL = 24
MAJOR_EVERY = 5
# Ink, matching the logo's #111111 stroke.
INK = (0x2B, 0x33, 0x38)

# Arrow sits between the two 100px icons (edges at x=190 and x=350).
ARROW_Y = 195
ARROW_X0, ARROW_X1 = 214, 326


def render(scale: int) -> Image.Image:
    w, h = W * scale, H * scale
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / (h - 1)
        d.line(
            [(0, y), (w, y)],
            fill=tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)),
        )

    cell = CELL * scale
    minor_w = scale
    major_w = scale
    for i, x in enumerate(range(0, w + 1, cell)):
        major = i % MAJOR_EVERY == 0
        d.line(
            [(x, 0), (x, h)],
            fill=GRID_MAJOR if major else GRID_MINOR,
            width=major_w if major else minor_w,
        )
    for i, y in enumerate(range(0, h + 1, cell)):
        major = i % MAJOR_EVERY == 0
        d.line(
            [(0, y), (w, y)],
            fill=GRID_MAJOR if major else GRID_MINOR,
            width=major_w if major else minor_w,
        )

    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    y = ARROW_Y * scale
    x0, x1 = ARROW_X0 * scale, ARROW_X1 * scale
    lw = 3 * scale
    ink = INK + (200,)
    od.line([(x0, y), (x1, y)], fill=ink, width=lw)
    head = 13 * scale
    wing = 7 * scale
    od.line([(x1 - head, y - wing), (x1, y)], fill=ink, width=lw)
    od.line([(x1 - head, y + wing), (x1, y)], fill=ink, width=lw)
    # round the shaft's tail cap
    r = lw / 2
    od.ellipse([x0 - r, y - r, x0 + r, y + r], fill=ink)
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    img1 = render(1)
    img2 = render(2)
    img1.save(args.out, save_all=True, append_images=[img2], compression="tiff_deflate")


if __name__ == "__main__":
    main()
