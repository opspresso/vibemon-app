#!/usr/bin/env python3
"""Post-process a chroma-key sprite sheet into a transparent 1280-wide sheet with 5 or 10 rows.

Steps:
1. Detect 5 or 10 drawn row bands and each row's frame bands (content layout).
2. Remove the magenta chroma-key background into true alpha (with despill).
3. Re-place every detected frame centered into an exact 128x128 grid cell.

Usage: postprocess_sprite.py <input.png> <output.png>
"""
import sys
from pathlib import Path

from PIL import Image

CELL = 128
GRID = 10


def is_bg(p) -> bool:
    r, g, b, a = p
    return a < 16 or (r > 180 and b > 180 and g < 120)


def bands(values, threshold=0.01, min_gap=4, min_size=12):
    out, in_band, start = [], False, 0
    for i, v in enumerate(values):
        if v > threshold and not in_band:
            start, in_band = i, True
        elif v <= threshold and in_band:
            out.append([start, i])
            in_band = False
    if in_band:
        out.append([start, len(values)])
    merged = []
    for b in out:
        if merged and b[0] - merged[-1][1] < min_gap:
            merged[-1][1] = b[1]
        else:
            merged.append(b)
    return [(s, e) for s, e in merged if e - s >= min_size]


def chroma_key(img: Image.Image) -> Image.Image:
    """Convert magenta background to transparency, with despill on edges."""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            m = min(r, b) - g  # magenta-ness
            if m > 110:
                px[x, y] = (0, 0, 0, 0)
            elif m > 50:
                # edge: fade alpha and remove magenta tint
                k = (m - 50) / 60
                alpha = int(a * (1 - k))
                avg = (r + g + b) // 3
                px[x, y] = (avg, avg, avg, alpha)
    return img


def main() -> None:
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    img = Image.open(src).convert("RGBA")
    w, h = img.size
    px = img.load()

    content = [[not is_bg(px[x, y]) for x in range(w)] for y in range(h)]
    yprof = [sum(row) / w for row in content]
    rows = bands(yprof, min_size=40)
    if len(rows) not in (GRID // 2, GRID):
        print(f"ERROR: expected {GRID // 2} or {GRID} row bands, found {len(rows)}")
        sys.exit(1)
    row_count = len(rows)

    keyed = chroma_key(img)
    out = Image.new("RGBA", (CELL * GRID, CELL * row_count), (0, 0, 0, 0))

    for ri, (ys, ye) in enumerate(rows):
        xprof = [sum(content[y][x] for y in range(ys, ye)) / (ye - ys) for x in range(w)]
        detected_cols = bands(xprof, min_size=16)
        if len(detected_cols) == GRID:
            cols = detected_cols
        elif w == CELL * GRID:
            cols = [(ci * CELL, (ci + 1) * CELL) for ci in range(GRID)]
        else:
            cols = detected_cols
            if len(cols) > GRID:
                print(f"WARN: row {ri+1} has {len(cols)} frame bands; keeping first {GRID}")
                cols = cols[:GRID]
        for ci, (xs, xe) in enumerate(cols):
            # tight bbox within the band
            frame = keyed.crop((xs, ys, xe, ye))
            bbox = frame.getbbox()
            if bbox:
                frame = frame.crop(bbox)
            fw, fh = frame.size
            if fw > CELL - 4 or fh > CELL - 4:
                scale = min((CELL - 4) / fw, (CELL - 4) / fh)
                frame = frame.resize((max(1, int(fw * scale)), max(1, int(fh * scale))), Image.LANCZOS)
                fw, fh = frame.size
            cx = ci * CELL + (CELL - fw) // 2
            cy = ri * CELL + (CELL - fh) // 2
            out.paste(frame, (cx, cy), frame)
        print(f"row {ri+1}: {len(cols)} frames placed")

    out.save(dst)
    print(f"Saved {dst}")


if __name__ == "__main__":
    main()
