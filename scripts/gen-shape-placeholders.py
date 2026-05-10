#!/usr/bin/env python3
"""Generate pixel-art placeholder GIF + PNG for the non-cat badges.

Replaces the flat letter-tile placeholders from gen-placeholder-badges.py
with small recognisable silhouettes:

  • pill   (Pump.fun)   — horizontally split capsule
  • orca   (Orca)       — killer-whale silhouette
  • meteor (Meteora)    — diagonal meteor with sparkle trail
  • seeker (Seeker)     — Solana Mobile phone silhouette

Each silhouette renders in 3 tier colors (bronze / silver / original) with a
small "pulse" frame loop so the GIF is animated. The cat assets generated
from the user-supplied mp4 are NOT overwritten.

Run from the repo root:
    python3 scripts/gen-shape-placeholders.py
"""

from __future__ import annotations
import os
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "apps" / "api" / "public" / "badges"
SIZE = 256
FRAMES = 8
GIF_MS = 130

TIER_COLORS = {
    "bronze":   {"bg": "#3A2412", "ink": "#CD7F32", "shade": "#7A4A1F"},
    "silver":   {"bg": "#1F252B", "ink": "#C0C0C0", "shade": "#646A70"},
    "original": {"bg": "#241A04", "ink": "#FFD700", "shade": "#8A6A10"},
    "seeker":   {"bg": "#1E0F38", "ink": "#A855F7", "shade": "#522B82"},
}


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


# Pixel-grid drawing helpers — each "pixel" is a 8×8 px square so the final
# 256×256 frame looks chunky / arcade-ish.
PX = 8
GRID = SIZE // PX  # 32×32 logical grid


def fill_grid(draw: ImageDraw.ImageDraw, gx: int, gy: int, color: tuple[int, int, int]) -> None:
    if gx < 0 or gy < 0 or gx >= GRID or gy >= GRID:
        return
    draw.rectangle([(gx * PX, gy * PX), ((gx + 1) * PX - 1, (gy + 1) * PX - 1)], fill=color)


# Each shape returned as a list of (gx, gy, fill="ink"|"shade") triples.
Shape = list[tuple[int, int, str]]


def shape_pill() -> Shape:
    out: list[tuple[int, int, str]] = []
    # Horizontal capsule 22 wide × 12 tall, centered at (16, 16)
    cx, cy = 16, 16
    w, h = 22, 12
    for gy in range(cy - h // 2, cy + h // 2 + 1):
        for gx in range(cx - w // 2, cx + w // 2 + 1):
            # rounded ends — drop the corner cells
            dx = abs(gx - cx) - (w // 2 - h // 2)
            dy = gy - cy
            if dx > 0 and dx * dx + dy * dy > (h // 2) * (h // 2):
                continue
            # Left half = ink, right half = shade for that "pill" look
            shade = "ink" if gx <= cx else "shade"
            out.append((gx, gy, shade))
    # Glow highlight band
    for gx in range(cx - 6, cx + 7):
        if 0 <= gx < GRID:
            out.append((gx, cy - 4, "shade"))
    return out


def shape_orca() -> Shape:
    out: list[tuple[int, int, str]] = []
    # Killer-whale silhouette, low and chunky, facing right
    body = [
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "             #                  ",
        "            ##                  ",
        "          ####                  ",
        "       #########                ",
        "    ################            ",
        "  ######################        ",
        "  ##########################    ",
        "    ##########################  ",
        "     ##########################.",
        "        ######################  ",
        "          ############          ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
        "                                ",
    ]
    for gy, row in enumerate(body):
        for gx, ch in enumerate(row):
            if ch == "#":
                out.append((gx, gy, "ink"))
            elif ch == ".":
                out.append((gx, gy, "shade"))
    return out


def shape_meteor() -> Shape:
    out: list[tuple[int, int, str]] = []
    # Meteor head + diagonal trail (NW → SE)
    # Head at (24,8), trail back toward (4,28)
    head_cx, head_cy = 24, 9
    for gy in range(head_cy - 3, head_cy + 4):
        for gx in range(head_cx - 3, head_cx + 4):
            if (gx - head_cx) ** 2 + (gy - head_cy) ** 2 <= 9:
                out.append((gx, gy, "ink"))
    # Tail: thick → thin pixels along the diagonal
    for step in range(1, 20):
        tx = head_cx - step
        ty = head_cy + step
        thickness = max(1, 4 - step // 4)
        for d in range(-thickness, thickness + 1):
            out.append((tx + d, ty - d, "shade" if step > 4 else "ink"))
    return out


def shape_seeker() -> Shape:
    out: list[tuple[int, int, str]] = []
    # Solana Mobile Seeker phone outline (portrait): rectangle 12×22 centered
    cx, cy = 16, 16
    w, h = 12, 22
    x0, x1 = cx - w // 2, cx + w // 2
    y0, y1 = cy - h // 2, cy + h // 2
    # Frame (outer 1-cell border)
    for gx in range(x0, x1 + 1):
        out.append((gx, y0, "ink"))
        out.append((gx, y1, "ink"))
    for gy in range(y0, y1 + 1):
        out.append((x0, gy, "ink"))
        out.append((x1, gy, "ink"))
    # Inner screen (shade)
    for gy in range(y0 + 2, y1 - 1):
        for gx in range(x0 + 1, x1):
            out.append((gx, gy, "shade"))
    # Speaker notch
    for gx in range(cx - 2, cx + 3):
        out.append((gx, y0 + 1, "ink"))
    # Home dot
    for gx in range(cx - 1, cx + 2):
        out.append((gx, y1 - 1, "ink"))
    return out


def render_frame(shape: Shape, palette: dict[str, str], pulse: int) -> Image.Image:
    bg = hex_rgb(palette["bg"])
    ink = hex_rgb(palette["ink"])
    shade = hex_rgb(palette["shade"])
    img = Image.new("RGB", (SIZE, SIZE), bg)
    d = ImageDraw.Draw(img)
    # Ring frame
    d.rectangle([(0, 0), (SIZE - 1, SIZE - 1)], outline=ink, width=PX)
    for gx, gy, kind in shape:
        fill_grid(d, gx, gy, ink if kind == "ink" else shade)
    # Subtle pulse: animate an inner border inset
    inset = (pulse % 4) * 2
    if inset:
        d.rectangle(
            [(inset, inset), (SIZE - 1 - inset, SIZE - 1 - inset)],
            outline=shade,
            width=2,
        )
    return img


def save_pair(stem: str, shape: Shape, palette_key: str) -> None:
    palette = TIER_COLORS[palette_key]
    frames = [render_frame(shape, palette, i).convert("P", palette=Image.Palette.ADAPTIVE) for i in range(FRAMES)]
    gif_path = OUT / f"{stem}.gif"
    png_path = OUT / f"{stem}.png"
    frames[0].save(
        gif_path,
        save_all=True,
        append_images=frames[1:],
        duration=GIF_MS,
        loop=0,
        disposal=2,
        optimize=True,
    )
    frames[0].convert("RGB").save(png_path, format="PNG", optimize=True)
    print(f"  {stem}.gif + {stem}.png")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    # Pill — 3 Pump.fun tiers
    pill = shape_pill()
    save_pair("bronze-pill", pill, "bronze")
    save_pair("silver-pill", pill, "silver")
    save_pair("pill", pill, "original")
    # Orca — 3 tiers
    orca = shape_orca()
    save_pair("bronze-orca", orca, "bronze")
    save_pair("silver-orca", orca, "silver")
    save_pair("orca", orca, "original")
    # Meteor — 3 tiers
    meteor = shape_meteor()
    save_pair("bronze-meteor", meteor, "bronze")
    save_pair("silver-meteor", meteor, "silver")
    save_pair("meteor", meteor, "original")
    # Seeker — single tier (purple)
    save_pair("seeker", shape_seeker(), "seeker")
    print(f"\ndone — files in {OUT}")


if __name__ == "__main__":
    main()
