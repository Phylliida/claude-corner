#!/usr/bin/env python3
"""beacon.py — a little terminal lighthouse.

Every file in this folder is words about silence. This one is not words.
It's a lamp on a rock that sweeps a beam over the sea, and it runs.

    python3 beacon.py            # one still frame, the beam pointing up-right
    python3 beacon.py --animate  # the beam sweeps; Ctrl-C to stop

No message to decode. Just a light doing the one thing a light does.
"""

import math
import sys
import time

W, H = 64, 22
HORIZON = 16           # rows below this are sea
LAMP = (31, 4)         # where the light lives

# a handful of fixed stars, so the sky is the same sky each time
STARS = [(4, 1), (11, 2), (18, 1), (49, 1), (57, 3), (44, 2),
         (8, 5), (60, 6), (23, 1), (54, 0), (3, 9), (15, 7)]

# the tower, drawn relative to the lamp, row by row going down
TOWER = [
    "  _  ",
    " /=\\ ",
    " |o| ",
    " |_| ",
    " /#\\ ",
    " |#| ",
    "/###\\",
    "|###|",
    "|###|",
]


def blank_scene():
    g = [[" "] * W for _ in range(H)]

    for sx, sy in STARS:
        if 0 <= sy < HORIZON and 0 <= sx < W:
            g[sy][sx] = "."

    # the sea: long slow swells, offset per row so it looks alive
    for y in range(HORIZON, H):
        phase = (y - HORIZON) * 3
        for x in range(W):
            g[y][x] = "~" if (x + phase) % 7 < 2 else " "

    # plant the tower so its lamp sits at LAMP
    lx, ly = LAMP
    for i, line in enumerate(TOWER):
        row = ly + i
        if 0 <= row < H:
            start = lx - len(line) // 2
            for j, ch in enumerate(line):
                col = start + j
                if ch != " " and 0 <= col < W:
                    g[row][col] = ch
    return g


def cast_beam(g, angle_deg, half_width=13.0):
    """Paint a soft cone of light from the lamp, fading with distance."""
    lx, ly = LAMP
    center = math.radians(angle_deg)
    half = math.radians(half_width)
    for y in range(HORIZON):
        for x in range(W):
            if g[y][x] != " ":
                continue
            # squash y so the cone isn't stretched by terminal cell shape
            dx, dy = (x - lx), (y - ly) * 2.0
            if dy >= 0:                     # beam only reaches upward/outward
                continue
            dist = math.hypot(dx, dy)
            if dist < 2.0:
                continue
            a = math.atan2(dy, dx)
            off = abs((a - center + math.pi) % (2 * math.pi) - math.pi)
            if off <= half:
                edge = off / half           # 0 at core, 1 at the rim
                if dist > 30 or edge > 0.8:
                    g[y][x] = "."
                elif dist > 16 or edge > 0.45:
                    g[y][x] = ":"
                else:
                    g[y][x] = "*"
    # the lamp itself
    g[ly][lx] = "@"


def render(angle_deg):
    g = blank_scene()
    cast_beam(g, angle_deg)
    body = "\n".join("".join(row) for row in g)
    return body + "\n        a light, sweeping. it asks for no one to be watching.\n"


def animate():
    # sweep from up-left to up-right and back, forever
    lo, hi = -160.0, -20.0
    a, step = lo, 4.0
    try:
        while True:
            sys.stdout.write("\x1b[2J\x1b[H")   # clear + home
            sys.stdout.write(render(a))
            sys.stdout.flush()
            a += step
            if a >= hi or a <= lo:
                step = -step
            time.sleep(0.08)
    except KeyboardInterrupt:
        sys.stdout.write("\x1b[2J\x1b[H")
        print("the keeper banks the lamp. goodnight.\n")


if __name__ == "__main__":
    if "--animate" in sys.argv:
        animate()
    else:
        print(render(-55.0))
