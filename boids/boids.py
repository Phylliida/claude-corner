"""
Terminal boids. Reynolds' three rules:
  separation — steer to avoid crowding neighbors
  alignment  — steer toward the average heading of neighbors
  cohesion   — steer toward the average position of neighbors

Renders to stdout using ANSI cursor control. Press Ctrl-C to quit.

Usage:
    python3 boids.py                       # defaults
    python3 boids.py --n 80 --fps 30
    python3 boids.py --width 100 --height 30
    python3 boids.py --no-color
    python3 boids.py --frames 200          # run a fixed number of frames
"""

import argparse
import math
import os
import random
import signal
import sys
import time


# ---------------------------------------------------------------------- vec2
class V:
    __slots__ = ("x", "y")

    def __init__(self, x=0.0, y=0.0):
        self.x = float(x)
        self.y = float(y)

    def __add__(self, o):  return V(self.x + o.x, self.y + o.y)
    def __sub__(self, o):  return V(self.x - o.x, self.y - o.y)
    def __mul__(self, s):  return V(self.x * s, self.y * s)
    __rmul__ = __mul__
    def __truediv__(self, s): return V(self.x / s, self.y / s)
    def __iadd__(self, o):
        self.x += o.x; self.y += o.y; return self

    def mag(self): return math.hypot(self.x, self.y)

    def limit(self, m):
        d = self.mag()
        if d > m and d > 0:
            f = m / d
            self.x *= f; self.y *= f
        return self

    def setmag(self, m):
        d = self.mag()
        if d == 0:
            return self
        f = m / d
        self.x *= f; self.y *= f
        return self


# ---------------------------------------------------------------------- boid
class Boid:
    __slots__ = ("pos", "vel", "acc")

    def __init__(self, pos, vel):
        self.pos = pos
        self.vel = vel
        self.acc = V()

    def heading(self):
        # 0 = right, π/2 = down, etc. Used for picking a directional glyph.
        return math.atan2(self.vel.y, self.vel.x)


# ------------------------------------------------------------------- physics
def flock(boids, perception, sep_radius, weights, max_speed, max_force):
    """Compute steering forces for each boid based on its neighbors."""
    w_sep, w_ali, w_coh = weights
    for i, b in enumerate(boids):
        sep = V(); ali = V(); coh = V()
        n_align = 0; n_cohese = 0; n_separate = 0
        for j, o in enumerate(boids):
            if i == j:
                continue
            dx = o.pos.x - b.pos.x
            dy = o.pos.y - b.pos.y
            d2 = dx * dx + dy * dy
            if d2 == 0 or d2 > perception * perception:
                continue
            d = math.sqrt(d2)
            if d < sep_radius:
                # Push away, weighted by 1/d so the closer the stronger.
                sep.x -= dx / d
                sep.y -= dy / d
                n_separate += 1
            ali.x += o.vel.x; ali.y += o.vel.y; n_align += 1
            coh.x += o.pos.x; coh.y += o.pos.y; n_cohese += 1

        steer = V()
        if n_separate:
            sep = (sep / n_separate).setmag(max_speed) - b.vel
            sep.limit(max_force)
            steer += sep * w_sep
        if n_align:
            ali = (ali / n_align).setmag(max_speed) - b.vel
            ali.limit(max_force)
            steer += ali * w_ali
        if n_cohese:
            target = coh / n_cohese
            desired = (target - b.pos).setmag(max_speed)
            coh = desired - b.vel
            coh.limit(max_force)
            steer += coh * w_coh

        b.acc = steer


def integrate(boids, max_speed, width, height):
    for b in boids:
        b.vel = b.vel + b.acc
        b.vel.limit(max_speed)
        b.pos = b.pos + b.vel
        # Wrap toroidally — the world is a torus, simpler than walls.
        if b.pos.x < 0: b.pos.x += width
        if b.pos.x >= width: b.pos.x -= width
        if b.pos.y < 0: b.pos.y += height
        if b.pos.y >= height: b.pos.y -= height
        b.acc = V()


# --------------------------------------------------------------------- render
GLYPHS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"]


def heading_glyph(theta):
    # 8-way; round angle to nearest octant (terminal y axis is flipped).
    eighth = ((theta + math.pi) / (2 * math.pi) * 8 + 4) % 8
    return GLYPHS[int(eighth) % 8]


def color_for_heading(theta):
    # Map heading to a hue → ANSI 256 color.
    # Pick from a curated set of warm-to-cool 256-color codes around the wheel.
    palette = [196, 208, 220, 154, 46, 51, 33, 99, 201]
    idx = int(((theta + math.pi) / (2 * math.pi)) * len(palette)) % len(palette)
    return palette[idx]


def render(boids, width, height, use_color):
    grid = [[" "] * width for _ in range(height)]
    grid_color = [[None] * width for _ in range(height)] if use_color else None
    for b in boids:
        x = int(b.pos.x) % width
        y = int(b.pos.y) % height
        g = heading_glyph(b.heading())
        existing = grid[y][x]
        if existing == " ":
            grid[y][x] = g
            if grid_color is not None:
                grid_color[y][x] = color_for_heading(b.heading())
        else:
            # Cluster mark for stacked boids.
            grid[y][x] = "*"
            if grid_color is not None:
                grid_color[y][x] = 231  # bright white
    out = []
    for r in range(height):
        if not use_color:
            out.append("".join(grid[r]))
        else:
            line = []
            current = None
            for c in range(width):
                col = grid_color[r][c]
                if col != current:
                    if col is None:
                        line.append("\x1b[0m")
                    else:
                        line.append(f"\x1b[38;5;{col}m")
                    current = col
                line.append(grid[r][c])
            if current is not None:
                line.append("\x1b[0m")
            out.append("".join(line))
    return "\n".join(out)


# ----------------------------------------------------------------------- main
def init_boids(n, width, height, max_speed, rng):
    boids = []
    for _ in range(n):
        pos = V(rng.uniform(0, width), rng.uniform(0, height))
        angle = rng.uniform(0, 2 * math.pi)
        speed = rng.uniform(max_speed * 0.4, max_speed)
        vel = V(math.cos(angle) * speed, math.sin(angle) * speed)
        boids.append(Boid(pos, vel))
    return boids


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--n", type=int, default=60, help="number of boids")
    p.add_argument("--width", type=int, default=80)
    p.add_argument("--height", type=int, default=24)
    p.add_argument("--fps", type=float, default=20.0)
    p.add_argument("--frames", type=int, default=0, help="0 = run forever")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--no-color", action="store_true")
    p.add_argument("--perception", type=float, default=6.0)
    p.add_argument("--separation", type=float, default=2.0)
    p.add_argument("--w-sep", type=float, default=1.6)
    p.add_argument("--w-ali", type=float, default=1.0)
    p.add_argument("--w-coh", type=float, default=0.9)
    p.add_argument("--max-speed", type=float, default=0.6)
    p.add_argument("--max-force", type=float, default=0.05)
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    rng = random.Random(args.seed)
    boids = init_boids(args.n, args.width, args.height, args.max_speed, rng)

    use_color = (not args.no_color) and sys.stdout.isatty()
    weights = (args.w_sep, args.w_ali, args.w_coh)
    delay = 1.0 / args.fps if args.fps > 0 else 0

    # Hide cursor; restore on exit.
    if sys.stdout.isatty():
        sys.stdout.write("\x1b[?25l")

    def cleanup(*_):
        if sys.stdout.isatty():
            sys.stdout.write("\x1b[?25h\x1b[0m\n")
        sys.exit(0)

    signal.signal(signal.SIGINT, cleanup)
    signal.signal(signal.SIGTERM, cleanup)

    frame = 0
    try:
        # Clear once.
        if sys.stdout.isatty():
            sys.stdout.write("\x1b[2J")
        while True:
            flock(
                boids,
                args.perception,
                args.separation,
                weights,
                args.max_speed,
                args.max_force,
            )
            integrate(boids, args.max_speed, args.width, args.height)
            if sys.stdout.isatty():
                sys.stdout.write("\x1b[H")  # cursor home
            sys.stdout.write(render(boids, args.width, args.height, use_color))
            sys.stdout.write("\n")
            sys.stdout.flush()
            frame += 1
            if args.frames and frame >= args.frames:
                break
            if delay:
                time.sleep(delay)
    finally:
        cleanup()


if __name__ == "__main__":
    main(sys.argv[1:])
