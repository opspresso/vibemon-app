#!/usr/bin/env python3
"""Verify a generated sprite sheet against spritesheet.md constraints (programmatic checks).

Background = zero-alpha pixels OR chroma-key magenta (#FF00FF) pixels.
"""
import sys
from pathlib import Path

from PIL import Image

CELL = 128
STATES = [
    "start", "idle", "thinking", "planning", "working",
    "packing", "notification", "done", "sleep", "alert",
]


def is_bg(p) -> bool:
    r, g, b, a = p
    if a < 16:
        return True
    return r > 180 and b > 180 and g < 120  # magenta-ish chroma key


def main() -> None:
    path = Path(sys.argv[1])
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    px = img.load()
    print(f"size: {w}x{h}")

    bg_count = sum(1 for y in range(0, h, 4) for x in range(0, w, 4) if is_bg(px[x, y]))
    total = len(range(0, h, 4)) * len(range(0, w, 4))
    print(f"background_pixel_ratio(sampled): {bg_count / total:.2%}")

    # background purity: among bg-classified opaque pixels, how uniform is the color?
    from collections import Counter
    corner_colors = Counter(
        px[x, y][:3] for x, y in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
    )
    print(f"corner_colors: {dict(corner_colors)}")

    rows = h // CELL
    cols = w // CELL
    print(f"grid: {rows} rows x {cols} cols (cell {CELL}px), remainder: {w % CELL}x{h % CELL}")

    print("\nrow occupancy (frames with content per row):")
    for r in range(rows):
        occupied = []
        for c in range(cols):
            nonbg = sum(
                1
                for y in range(r * CELL, (r + 1) * CELL, 2)
                for x in range(c * CELL, (c + 1) * CELL, 2)
                if not is_bg(px[x, y])
            )
            frac = nonbg / (CELL * CELL / 4)
            occupied.append(frac)
        cells = "".join("#" if f > 0.02 else ("." if f > 0.002 else " ") for f in occupied)
        used = sum(1 for f in occupied if f > 0.02)
        label = STATES[r] if r < len(STATES) else f"row{r+1}"
        print(f"  row {r+1:2d} [{label:12s}] |{cells}| frames~{used}")

    print("\nrow-boundary bleed (content on y=k*128 lines):")
    for r in range(1, rows):
        y = r * CELL
        bleed = sum(1 for x in range(w) if not is_bg(px[x, y])) / w
        print(f"  y={y}: {bleed:.2%}", end="")
    print()
    print("\ncolumn-boundary bleed (content on x=k*128 lines):")
    for c in range(1, cols):
        x = c * CELL
        bleed = sum(1 for y in range(h) if not is_bg(px[x, y])) / h
        print(f"  x={x}: {bleed:.2%}", end="")
    print()


if __name__ == "__main__":
    main()
