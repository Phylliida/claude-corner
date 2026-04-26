"""
A small wander through emotion space. Pick a starting emotion (random
by default, or by name), then step to a nearby emotion repeatedly,
where "nearby" is weighted by inverse distance on the (valence, arousal)
plane. Print the path with light annotations.

Usage:
    python3 walk.py                        # random start, 8 steps
    python3 walk.py --start happy          # start from a named emotion
    python3 walk.py --steps 16 --seed 7    # longer path, deterministic
"""

import argparse
import math
import random
import sys

from emotions import all_emotions, CLUSTER_GLYPHS


def euclid(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def step(current, points, rng, temperature=0.25, exclude=None):
    """Pick the next emotion. Probability ∝ exp(-distance² / temperature),
    excluding any names in `exclude` (and the current one). The squared
    distance makes far-away emotions exponentially unlikely so that walks
    stay locally coherent."""
    cv, ca = current[1], current[2]
    candidates = []
    weights = []
    for name, v, a, cluster in points:
        if name == current[0]:
            continue
        if exclude and name in exclude:
            continue
        d = euclid((cv, ca), (v, a))
        candidates.append((name, v, a, cluster))
        weights.append(math.exp(-(d ** 2) / temperature))
    total = sum(weights)
    weights = [w / total for w in weights]
    return rng.choices(candidates, weights=weights, k=1)[0]


def find_emotion(points, name):
    name_lower = name.lower()
    for p in points:
        if p[0].lower() == name_lower:
            return p
    # substring fallback
    for p in points:
        if name_lower in p[0].lower():
            return p
    return None


def render_path(path):
    lines = []
    lines.append("")
    for i, (name, v, a, cluster) in enumerate(path):
        glyph = CLUSTER_GLYPHS[cluster]
        marker = "  ╶─→  " if i > 0 else "       "
        lines.append(
            f"{marker}{glyph}  {name:<16}  v={v:+.2f}  a={a:+.2f}   [{cluster}]"
        )
    lines.append("")
    # Total path length
    dist = 0.0
    for i in range(1, len(path)):
        dist += euclid((path[i - 1][1], path[i - 1][2]), (path[i][1], path[i][2]))
    lines.append(f"  path length: {dist:.2f}   ({len(path) - 1} steps)")
    return "\n".join(lines)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", help="starting emotion name (substring ok)")
    parser.add_argument("--steps", type=int, default=8, help="number of steps")
    parser.add_argument("--seed", type=int, help="seed for determinism")
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.25,
        help="higher = wilder steps (default 0.25)",
    )
    parser.add_argument(
        "--no-repeat",
        action="store_true",
        help="never revisit an emotion",
    )
    args = parser.parse_args(argv)

    rng = random.Random(args.seed)
    points = list(all_emotions())

    if args.start:
        current = find_emotion(points, args.start)
        if current is None:
            print(f"no emotion matching '{args.start}'", file=sys.stderr)
            return 1
    else:
        current = rng.choice(points)

    path = [current]
    visited = {current[0]}
    for _ in range(args.steps):
        exclude = visited if args.no_repeat else None
        try:
            nxt = step(current, points, rng, args.temperature, exclude)
        except IndexError:
            break  # exhausted candidates
        path.append(nxt)
        visited.add(nxt[0])
        current = nxt

    print(render_path(path))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
