"""
Conway's Game of Life. Two rules:
  - a live cell with 2 or 3 live neighbors stays alive
  - a dead cell with exactly 3 live neighbors becomes alive

That's the whole specification. Animate to stdout via ANSI. The world
is toroidal — edges wrap.

Usage:
    python3 life.py                       # random soup
    python3 life.py --pattern gun         # gosper glider gun
    python3 life.py --pattern pulsar
    python3 life.py --patterns            # list available patterns
    python3 life.py --width 100 --height 40 --fps 12 --gens 500
    python3 life.py --pattern soup --density 0.25 --seed 42
"""

import argparse
import os
import random
import signal
import sys
import time


# Patterns are lists of (x, y) live cells, anchored to (0, 0) at top-left.
PATTERNS = {
    "blinker": [(1, 0), (1, 1), (1, 2)],
    "toad": [(1, 0), (2, 0), (3, 0), (0, 1), (1, 1), (2, 1)],
    "glider": [(1, 0), (2, 1), (0, 2), (1, 2), (2, 2)],
    "lwss": [
        (1, 0), (4, 0),
        (0, 1),
        (0, 2), (4, 2),
        (0, 3), (1, 3), (2, 3), (3, 3),
    ],
    "pulsar": _pulsar_cells() if False else [],  # filled in below
    "pentadecathlon": [(0, 1), (1, 1), (2, 0), (2, 2),
                       (3, 1), (4, 1), (5, 1), (6, 1),
                       (7, 0), (7, 2), (8, 1), (9, 1)],
    "acorn": [(1, 0), (3, 1), (0, 2), (1, 2), (4, 2), (5, 2), (6, 2)],
    "rpentomino": [(1, 0), (2, 0), (0, 1), (1, 1), (1, 2)],
    "diehard": [(6, 0), (0, 1), (1, 1), (1, 2), (5, 2), (6, 2), (7, 2)],
    # Filled in below: gun.
}


def _pulsar_cells():
    base = [
        (2, 0), (3, 0), (4, 0), (8, 0), (9, 0), (10, 0),
        (0, 2), (5, 2), (7, 2), (12, 2),
        (0, 3), (5, 3), (7, 3), (12, 3),
        (0, 4), (5, 4), (7, 4), (12, 4),
        (2, 5), (3, 5), (4, 5), (8, 5), (9, 5), (10, 5),
        (2, 7), (3, 7), (4, 7), (8, 7), (9, 7), (10, 7),
        (0, 8), (5, 8), (7, 8), (12, 8),
        (0, 9), (5, 9), (7, 9), (12, 9),
        (0, 10), (5, 10), (7, 10), (12, 10),
        (2, 12), (3, 12), (4, 12), (8, 12), (9, 12), (10, 12),
    ]
    return base


PATTERNS["pulsar"] = _pulsar_cells()


# Gosper glider gun.
def _gun_cells():
    return [
        (0, 4), (0, 5), (1, 4), (1, 5),
        (10, 4), (10, 5), (10, 6),
        (11, 3), (11, 7),
        (12, 2), (12, 8), (13, 2), (13, 8),
        (14, 5),
        (15, 3), (15, 7),
        (16, 4), (16, 5), (16, 6),
        (17, 5),
        (20, 2), (20, 3), (20, 4),
        (21, 2), (21, 3), (21, 4),
        (22, 1), (22, 5),
        (24, 0), (24, 1), (24, 5), (24, 6),
        (34, 2), (34, 3), (35, 2), (35, 3),
    ]


PATTERNS["gun"] = _gun_cells()


def make_grid(width, height):
    return [[0] * width for _ in range(height)]


def stamp(grid, pattern, ox, oy):
    h = len(grid)
    w = len(grid[0])
    for x, y in pattern:
        gx = (ox + x) % w
        gy = (oy + y) % h
        grid[gy][gx] = 1


def random_soup(width, height, density, rng):
    grid = make_grid(width, height)
    for y in range(height):
        for x in range(width):
            if rng.random() < density:
                grid[y][x] = 1
    return grid


def step(grid):
    h = len(grid)
    w = len(grid[0])
    new = make_grid(w, h)
    for y in range(h):
        ym = (y - 1) % h
        yp = (y + 1) % h
        row = grid[y]
        rm = grid[ym]
        rp = grid[yp]
        for x in range(w):
            xm = (x - 1) % w
            xp = (x + 1) % w
            n = (
                rm[xm] + rm[x] + rm[xp]
                + row[xm]         + row[xp]
                + rp[xm] + rp[x] + rp[xp]
            )
            if row[x]:
                new[y][x] = 1 if n == 2 or n == 3 else 0
            else:
                new[y][x] = 1 if n == 3 else 0
    return new


def render(grid, age=None):
    """Render grid. If age is given (a parallel grid of int ages), older
    cells are drawn with denser glyphs."""
    out = []
    for y, row in enumerate(grid):
        line = []
        for x, v in enumerate(row):
            if not v:
                line.append(" ")
            else:
                a = age[y][x] if age is not None else 0
                if a == 0:
                    line.append("·")
                elif a < 4:
                    line.append("∘")
                elif a < 16:
                    line.append("o")
                else:
                    line.append("●")
        out.append("".join(line))
    return "\n".join(out)


def update_age(prev_age, grid):
    h = len(grid)
    w = len(grid[0])
    new = make_grid(w, h)
    for y in range(h):
        for x in range(w):
            if grid[y][x]:
                new[y][x] = (prev_age[y][x] + 1) if prev_age[y][x] else 1
    return new


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--pattern", default="soup",
                   help="starting pattern (default: random soup)")
    p.add_argument("--width", type=int, default=80)
    p.add_argument("--height", type=int, default=24)
    p.add_argument("--density", type=float, default=0.30,
                   help="random-soup density")
    p.add_argument("--fps", type=float, default=12.0)
    p.add_argument("--gens", type=int, default=0,
                   help="0 = run forever")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--patterns", action="store_true", help="list patterns")
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    if args.patterns:
        for name in sorted(PATTERNS.keys()) + ["soup"]:
            print(f"  {name}")
        return 0

    rng = random.Random(args.seed)
    if args.pattern == "soup":
        grid = random_soup(args.width, args.height, args.density, rng)
    elif args.pattern in PATTERNS:
        grid = make_grid(args.width, args.height)
        cells = PATTERNS[args.pattern]
        # Center the pattern.
        if cells:
            xs = [x for x, _ in cells]
            ys = [y for _, y in cells]
            pw = max(xs) - min(xs) + 1
            ph = max(ys) - min(ys) + 1
            ox = (args.width - pw) // 2 - min(xs)
            oy = (args.height - ph) // 2 - min(ys)
            stamp(grid, cells, ox, oy)
    else:
        print(f"unknown pattern: {args.pattern}", file=sys.stderr)
        return 1

    age = make_grid(args.width, args.height)
    delay = 1.0 / args.fps if args.fps > 0 else 0

    is_tty = sys.stdout.isatty()

    def cleanup(*_):
        if is_tty:
            sys.stdout.write("\x1b[?25h\x1b[0m\n")
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    if is_tty:
        sys.stdout.write("\x1b[?25l\x1b[2J")

    gen = 0
    try:
        while True:
            age = update_age(age, grid)
            if is_tty:
                sys.stdout.write("\x1b[H")
            sys.stdout.write(render(grid, age))
            sys.stdout.write(f"\n  gen {gen}   pattern={args.pattern}\n")
            sys.stdout.flush()
            grid = step(grid)
            gen += 1
            if args.gens and gen >= args.gens:
                break
            if delay:
                time.sleep(delay)
    finally:
        cleanup()


if __name__ == "__main__":
    main(sys.argv[1:])
