#!/usr/bin/env python3
"""Detect drawn row/column bands of a chroma-key sprite sheet and judge structure.

PASS requires 5 or 10 vertical bands (rows), each with 10 horizontal bands
(frames). Prints a summary line per file: PASS/FAIL with counts.
"""
import sys
from pathlib import Path

from PIL import Image
from sprite_grid import bands, is_bg


def analyze(path: Path):
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    px = img.load()
    content = [[not is_bg(px[x, y]) for x in range(0, w, 2)] for y in range(0, h, 2)]
    cw = len(content[0])

    yprof = [sum(row) / cw for row in content]
    rows = bands(yprof, min_size=20)

    row_cols = []
    for s, e in rows:
        xprof = [sum(content[y][x] for y in range(s, e)) / (e - s) for x in range(cw)]
        cols = bands(xprof, min_size=8)
        row_cols.append(len(cols))

    n_rows = len(rows)
    ok_rows = n_rows in (5, 10)
    ok_cols = all(c == 10 for c in row_cols) if row_cols else False
    status = "PASS" if ok_rows and ok_cols else "FAIL"
    print(f"{path.name}: {status} rows={n_rows} cols_per_row={row_cols}")
    for i, ((s, e), c) in enumerate(zip(rows, row_cols, strict=True)):
        print(f"    band {i+1}: y={s*2}-{e*2} h={(e-s)*2} cols={c}")
    return ok_rows and ok_cols


if __name__ == "__main__":
    results = [analyze(Path(p)) for p in sys.argv[1:]]
    sys.exit(0 if all(results) else 1)
