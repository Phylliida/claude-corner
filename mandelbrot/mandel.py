"""
Mandelbrot set in ASCII. Pretty, no theme, just math.

The set: those c ∈ ℂ for which z_{n+1} = z_n² + c stays bounded
when iterated from z_0 = 0. Points that escape are colored by how
many iterations they survived; points in the set are dark.

Usage:
    python3 mandel.py                       # full view
    python3 mandel.py --zoom seahorse       # preset zoom
    python3 mandel.py --cx -0.7 --cy 0.27 --scale 0.05
    python3 mandel.py --width 120 --height 36 --iter 200
    python3 mandel.py --zoom seahorse --color
    python3 mandel.py --presets             # list zooms
"""

import argparse
import sys


# Hand-tuned interesting locations.
PRESETS = {
    "full":         {"cx": -0.5,           "cy": 0.0,     "scale": 1.5},
    "seahorse":     {"cx": -0.7453,        "cy": 0.1127,  "scale": 0.0065},
    "spiral":       {"cx": -0.745428,      "cy": 0.113009,"scale": 3e-5},
    "elephant":     {"cx":  0.275,         "cy": 0.0,     "scale": 0.04},
    "mini":         {"cx": -1.776,         "cy": 0.0,     "scale": 0.02},
    "lightning":    {"cx": -1.401,         "cy": 0.0,     "scale": 0.025},
    "tendrils":     {"cx": -0.16,          "cy": 1.0405,  "scale": 0.026},
}


# Density gradient: dense → sparse maps to "deep in set" → "escaped fast".
GRADIENT = "@%#*+=-:. "


def mandel_iter(cr, ci, max_iter):
    """Return iteration count before escape, or max_iter if bounded."""
    zr = 0.0
    zi = 0.0
    for n in range(max_iter):
        zr2 = zr * zr
        zi2 = zi * zi
        if zr2 + zi2 > 4.0:
            return n
        zi = 2.0 * zr * zi + ci
        zr = zr2 - zi2 + cr
    return max_iter


def render(cx, cy, scale, width, height, max_iter, color=False):
    # Aspect: characters are taller than wide, so stretch x by ~2 to compensate.
    aspect = 2.0
    rows = []
    for j in range(height):
        # Top row = +imag (north).
        ci = cy + (0.5 - j / (height - 1)) * 2 * scale
        line = []
        for i in range(width):
            cr = cx + ((i / (width - 1)) - 0.5) * 2 * scale * aspect
            n = mandel_iter(cr, ci, max_iter)
            if n == max_iter:
                ch = GRADIENT[0]  # densest character for in-set
                col = 16
            else:
                # High n (slow escape, near boundary) → dense char.
                # Low n (fast escape, far from set) → sparse char.
                t = (n / max_iter) ** 0.5  # gamma curve, fattens the boundary
                idx = (len(GRADIENT) - 1) - int(t * (len(GRADIENT) - 1))
                idx = min(len(GRADIENT) - 1, max(0, idx))
                ch = GRADIENT[idx]
                # Color: blue→cyan→yellow→red ramp by iteration count.
                ramp = [21, 27, 33, 39, 45, 51, 87, 123, 159, 195, 220, 214, 208, 202, 196]
                col = ramp[min(len(ramp) - 1, int((n / max_iter) ** 0.5 * (len(ramp) - 1)))]
            if color:
                line.append(f"\x1b[38;5;{col}m{ch}")
            else:
                line.append(ch)
        if color:
            line.append("\x1b[0m")
        rows.append("".join(line))
    return "\n".join(rows)


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--zoom", choices=list(PRESETS.keys()), default="full",
                   help="preset zoom location")
    p.add_argument("--cx", type=float, help="real center")
    p.add_argument("--cy", type=float, help="imag center")
    p.add_argument("--scale", type=float, help="half-height of the view")
    p.add_argument("--width", type=int, default=80)
    p.add_argument("--height", type=int, default=24)
    p.add_argument("--iter", type=int, default=120, help="max iterations")
    p.add_argument("--color", action="store_true")
    p.add_argument("--presets", action="store_true", help="list zoom presets")
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    if args.presets:
        for name, p in PRESETS.items():
            print(f"  {name:<10} cx={p['cx']:<14} cy={p['cy']:<10} scale={p['scale']}")
        return 0

    p = PRESETS[args.zoom]
    cx = args.cx if args.cx is not None else p["cx"]
    cy = args.cy if args.cy is not None else p["cy"]
    scale = args.scale if args.scale is not None else p["scale"]

    color = args.color and sys.stdout.isatty()
    print(render(cx, cy, scale, args.width, args.height, args.iter, color=color))
    print(f"  center=({cx}, {cy})   scale={scale}   max_iter={args.iter}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
