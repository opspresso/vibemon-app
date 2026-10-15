"""Shared helpers for chroma-key sprite sheets: background test and band detection."""
import json
from pathlib import Path

CELL = 128
GRID = 10

# The sheet rows follow the state registry order.
STATES = list(json.loads((Path(__file__).resolve().parents[2] / "src/shared/data/states.json").read_text())["states"])


def is_bg(p) -> bool:
    """Zero-alpha pixels and magenta chroma-key pixels are background."""
    r, g, b, a = p
    return a < 16 or (r > 180 and b > 180 and g < 120)


def bands(values, threshold=0.01, min_gap=4, min_size=12):
    """Return (start, end) runs above `threshold`, joining gaps under `min_gap`."""
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
