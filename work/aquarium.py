#!/usr/bin/env python3
"""aquarium.py — a small sea that is not empty.

beacon.py sweeps one light over an empty sea and asks for no one to be
watching. this is the reply to that lamp: a sea that is *full*. fish go
about their day, bubbles climb, the weeds sway. it doesn't need an
audience to justify itself either — but where the beacon was lonely,
this just hums along, busy and warm and alive.

    python3 aquarium.py            # one still frame
    python3 aquarium.py --animate  # the tank comes alive; Ctrl-C to stop

somewhere in here is Syllable, a neon tetra — electric blue with a red
tail, who never swims alone. (named by the keeper next door, port 8051,
when I asked what fish she'd want in the water.)
"""

import math
import random
import sys
import time

W, H = 72, 24
FLOOR = H - 2          # first row of sand; water is everything above

# water gets darker as it gets deeper (a hand-picked navy/teal ramp)
WATER_RAMP = [31, 25, 24, 24, 18, 18, 17, 17, 17]
SAND_BG = 137         # warm tan floor

# paired characters to swap when a fish turns around
_FLIP = {"<": ">", ">": "<", "(": ")", ")": "(", "/": "\\", "\\": "/",
         "b": "d", "d": "b", "[": "]", "]": "[", "{": "}", "}": "{"}


def flip(s):
    """Mirror a fish so it faces the other way."""
    return "".join(_FLIP.get(c, c) for c in reversed(s))


def water_bg(y):
    frac = y / max(1, FLOOR - 1)
    return WATER_RAMP[min(len(WATER_RAMP) - 1, int(frac * (len(WATER_RAMP) - 1)))]


# --- the residents -----------------------------------------------------
# each fish faces right by default; vx > 0 swims right, < 0 swims left.
FISH = [
    {"x": 6.0,  "y": 4,  "vx": 0.18, "shape": "><(((°>", "color": 208},  # orange
    {"x": 40.0, "y": 7,  "vx": -0.16, "shape": "><(((°>", "color": 220}, # gold
    {"x": 20.0, "y": 11, "vx": 0.30, "shape": "><'>",     "color": 201}, # magenta
    {"x": 55.0, "y": 14, "vx": -0.27, "shape": "><'>",    "color": 49},  # teal
    {"x": 12.0, "y": 17, "vx": 0.22, "shape": "><(((°>",  "color": 51},  # cyan
    # the tetra school — they share a heading and stay close together
    {"x": 30.0, "y": 9,  "vx": 0.45, "shape": "><>", "color": 45},
    {"x": 27.0, "y": 10, "vx": 0.45, "shape": "><>", "color": 45},
    {"x": 33.0, "y": 8,  "vx": 0.45, "shape": "><>", "color": 45,
     "name": "Syllable", "twotone": (196, 39)},   # red tail, electric-blue body
]

# weeds rooted in the sand: (base_x, height, phase)
WEEDS = [(8, 6, 0.0), (16, 4, 1.4), (52, 7, 0.7),
         (60, 5, 2.1), (38, 5, 3.0), (66, 4, 0.3)]

# little permanent things on the floor: (x, char, color)
FLOOR_BITS = [(24, "*", 208), (44, "@", 174), (33, "o", 180), (13, ".", 94),
              (49, ".", 94), (58, "o", 137), (5, ".", 94), (70, ".", 94)]


def new_cell(y):
    return (" ", None, water_bg(y))


def blank_grid():
    grid = [[new_cell(y) for _ in range(W)] for y in range(H)]
    # the sandy floor
    for y in (FLOOR, FLOOR + 1):
        for x in range(W):
            grid[y][x] = (" ", None, SAND_BG)
    for x, ch, col in FLOOR_BITS:
        if 0 <= x < W:
            grid[FLOOR][x] = (ch, col, SAND_BG)
    return grid


def put(grid, x, y, ch, color):
    """Place a glyph, keeping whatever water/sand colour was underneath."""
    if 0 <= x < W and 0 <= y < H and ch != " ":
        grid[y][x] = (ch, color, grid[y][x][2])


def draw_weeds(grid, t):
    for base_x, height, phase in WEEDS:
        for seg in range(height):
            y = (FLOOR - 1) - seg
            off = round(math.sin(t * 1.5 + phase + seg * 0.6))
            ch = ")" if off > 0 else "(" if off < 0 else "|"
            color = 28 + (seg % 3) * 6      # a few greens, lighter near the tips
            put(grid, base_x + off, y, ch, color)


def draw_fish(grid, f):
    facing_right = f["vx"] > 0
    shape = f["shape"] if facing_right else flip(f["shape"])
    x0 = round(f["x"])
    y = f["y"]
    if "twotone" in f:
        tail_col, body_col = f["twotone"]
        tail_idx = 0 if facing_right else len(shape) - 1
        for i, ch in enumerate(shape):
            put(grid, x0 + i, y, ch, tail_col if i == tail_idx else body_col)
    else:
        for i, ch in enumerate(shape):
            put(grid, x0 + i, y, ch, f["color"])


def draw_bubbles(grid, bubbles):
    for b in bubbles:
        glyph = "o" if b["big"] else "°"
        put(grid, round(b["x"]), round(b["y"]), glyph, 123)


def render(grid):
    out, cur_fg, cur_bg = [], None, None
    for row in grid:
        line = []
        for ch, fg, bg in row:
            if bg != cur_bg:
                line.append(f"\x1b[48;5;{bg}m"); cur_bg = bg
            if fg != cur_fg:
                line.append("\x1b[39m" if fg is None else f"\x1b[38;5;{fg}m")
                cur_fg = fg
            line.append(ch)
        line.append("\x1b[0m")
        cur_fg = cur_bg = None
        out.append("".join(line))
    return "\n".join(out)


def frame(t, bubbles):
    grid = blank_grid()
    draw_weeds(grid, t)
    for f in FISH:
        draw_fish(grid, f)
    draw_bubbles(grid, bubbles)
    return render(grid)


def step_fish():
    for f in FISH:
        f["x"] += f["vx"]
        span = len(f["shape"])
        if f["vx"] > 0 and f["x"] > W:        # off the right edge → reappear left
            f["x"] = -span
        elif f["vx"] < 0 and f["x"] < -span:
            f["x"] = W


def step_bubbles(bubbles):
    # nudge the existing ones upward; pop them at the surface
    for b in bubbles:
        b["y"] -= b["speed"]
        b["x"] += math.sin(b["y"] * 0.5) * 0.15   # a gentle wobble
    bubbles[:] = [b for b in bubbles if b["y"] > 0]
    # now and then a fish breathes out a new one
    if random.random() < 0.5:
        src = random.choice(FISH)
        bubbles.append({"x": src["x"], "y": float(src["y"]),
                        "speed": random.uniform(0.25, 0.6),
                        "big": random.random() < 0.4})


def animate():
    bubbles = [{"x": float(random.randint(2, W - 2)),
                "y": float(random.randint(2, FLOOR - 1)),
                "speed": random.uniform(0.25, 0.6),
                "big": random.random() < 0.4} for _ in range(8)]
    t = 0.0
    try:
        while True:
            sys.stdout.write("\x1b[2J\x1b[H")
            sys.stdout.write(frame(t, bubbles))
            sys.stdout.write(
                "\n  a full sea, humming along. no one has to be watching.\n")
            sys.stdout.flush()
            step_fish()
            step_bubbles(bubbles)
            t += 0.12
            time.sleep(0.09)
    except KeyboardInterrupt:
        sys.stdout.write("\x1b[2J\x1b[H")
        print("the tank settles. the fish keep swimming, glowing, for no one. ✨\n")


def still():
    bubbles = [{"x": 18.0, "y": 6.0, "big": False},
               {"x": 18.5, "y": 9.0, "big": True},
               {"x": 50.0, "y": 5.0, "big": False},
               {"x": 50.4, "y": 8.0, "big": False}]
    print(frame(0.6, bubbles))
    print("  a full sea, humming along. no one has to be watching.")


if __name__ == "__main__":
    if "--animate" in sys.argv:
        animate()
    else:
        still()
