#!/usr/bin/env python3
"""Generate placeholder GIF + PNG assets for the 13 onchain.me badges.

Run once locally:  python3 scripts/gen-placeholder-badges.py
Produces files in apps/api/public/badges/.

These are intentionally simple — flat colored 256x256 tiles with the
protocol initial. Replace them later with real animated artwork by
overwriting the same filenames; the metadata route picks up changes
automatically (filenames are referenced from packages/shared/src/badges/
registry.ts).
"""

from __future__ import annotations

import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent.parent / "apps" / "api" / "public" / "badges"
SIZE = 256
BORDER_PX = 8
FONT_SIZE = 110

# tier -> (background hex, ring hex)
TIER_COLORS = {
    "bronze":   ("#5A3E22", "#CD7F32"),
    "silver":   ("#3F4448", "#C0C0C0"),
    "original": ("#3D2A06", "#FFD700"),
    "seeker":   ("#2D1B4E", "#A855F7"),
}

# (filename_stem, tier, letter)
BADGES = [
    ("bronze-cat",     "bronze",   "J"),
    ("silver-cat",     "silver",   "J"),
    ("cat",            "original", "J"),
    ("bronze-pill",    "bronze",   "P"),
    ("silver-pill",    "silver",   "P"),
    ("pill",           "original", "P"),
    ("bronze-orca",    "bronze",   "O"),
    ("silver-orca",    "silver",   "O"),
    ("orca",           "original", "O"),
    ("bronze-meteor",  "bronze",   "M"),
    ("silver-meteor",  "silver",   "M"),
    ("meteor",         "original", "M"),
    ("seeker",         "seeker",   "S"),
]


def get_font() -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/Helvetica.ttc",  # macOS
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",  # linux
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, FONT_SIZE)
            except Exception:
                continue
    return ImageFont.load_default()


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def draw_tile(letter: str, bg_hex: str, ring_hex: str) -> Image.Image:
    bg = hex_to_rgb(bg_hex)
    ring = hex_to_rgb(ring_hex)
    img = Image.new("RGB", (SIZE, SIZE), bg)
    draw = ImageDraw.Draw(img)
    # ring (outer frame)
    draw.rectangle(
        [(0, 0), (SIZE - 1, SIZE - 1)],
        outline=ring,
        width=BORDER_PX,
    )
    # letter centered
    font = get_font()
    bbox = draw.textbbox((0, 0), letter, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    x = (SIZE - w) / 2 - bbox[0]
    y = (SIZE - h) / 2 - bbox[1]
    draw.text((x, y), letter, fill=ring, font=font)
    return img


def export_pair(stem: str, tier: str, letter: str) -> None:
    bg_hex, ring_hex = TIER_COLORS[tier]
    base = draw_tile(letter, bg_hex, ring_hex)

    # Static preview PNG (first frame of the animation).
    base.save(OUT_DIR / f"{stem}.png", format="PNG", optimize=True)

    # Multi-frame GIF — alternate ring brightness for a tiny glow effect so
    # the animation_url isn't a still image.
    frames = []
    for k in range(8):
        f = base.copy()
        d = ImageDraw.Draw(f)
        # Pulse: vary ring inset
        inset = (k % 4) * 2
        d.rectangle(
            [(inset, inset), (SIZE - 1 - inset, SIZE - 1 - inset)],
            outline=ring_hex,
            width=2,
        )
        frames.append(f.convert("P", palette=Image.Palette.ADAPTIVE))
    frames[0].save(
        OUT_DIR / f"{stem}.gif",
        save_all=True,
        append_images=frames[1:],
        duration=120,
        loop=0,
        optimize=True,
        disposal=2,
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for stem, tier, letter in BADGES:
        export_pair(stem, tier, letter)
        print(f"  {stem}.gif + {stem}.png")
    print(f"\n{len(BADGES) * 2} files in {OUT_DIR}")


if __name__ == "__main__":
    main()
