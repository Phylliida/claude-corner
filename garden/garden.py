"""
A persistent garden. Each invocation advances time by one tick: plants
age through stages, flowers spread seeds to nearby cells, very old
things fade. The state lives in garden.json next to this file.

Usage:
    python3 garden.py                       # advance one tick, render
    python3 garden.py --look                # render without ticking
    python3 garden.py --plant flower 12 4   # place a seed for a flower
    python3 garden.py --plant tree 30 6     # place a seed for a tree
    python3 garden.py --plant grass 5 8     # place grass
    python3 garden.py --clear               # reset to bare earth
    python3 garden.py --ticks 20            # advance 20 ticks at once
    python3 garden.py --kinds               # list plant kinds
"""

import argparse
import json
import os
import random
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / "garden.json"

WIDTH = 70
HEIGHT = 10


# Each plant kind: a list of (glyph, min_age) pairs describing stages,
# plus optional seeding behavior.
KINDS = {
    "flower": {
        "stages": [
            (".", 0),    # seed
            (",", 2),    # sprout
            ("v", 4),    # leaves
            ("Y", 7),    # bud
            ("*", 10),   # bloom
            ("o", 18),   # fading
            (".", 24),   # spent — will be reaped
        ],
        "seed_at": 12,    # age at which it sometimes spawns nearby seeds
        "seed_chance": 0.35,
        "seed_kind": "flower",
        "lifespan": 28,
    },
    "tree": {
        "stages": [
            (".", 0),
            (",", 3),
            ("i", 8),
            ("Y", 16),
            ("T", 28),
            ("¶", 50),
            ("Ψ", 90),
        ],
        "seed_at": 60,
        "seed_chance": 0.10,
        "seed_kind": "tree",
        "lifespan": 200,
    },
    "grass": {
        "stages": [
            (".", 0),
            ("\"", 2),
            ("'", 4),
            ("\"", 8),
        ],
        "seed_at": 4,
        "seed_chance": 0.55,
        "seed_kind": "grass",
        "lifespan": 14,
    },
    "stone": {  # never grows or seeds; just sits.
        "stages": [("o", 0)],
        "seed_at": None,
        "seed_chance": 0,
        "seed_kind": None,
        "lifespan": 10**9,
    },
}


def load():
    if STATE_FILE.exists():
        with STATE_FILE.open() as f:
            data = json.load(f)
        return data
    return {"tick": 0, "plants": []}


def save(state):
    with STATE_FILE.open("w") as f:
        json.dump(state, f, indent=2)


def in_bounds(x, y):
    return 0 <= x < WIDTH and 0 <= y < HEIGHT


def occupied(plants, x, y):
    return any(p["x"] == x and p["y"] == y for p in plants)


def stage_glyph(plant):
    spec = KINDS[plant["kind"]]
    glyph = spec["stages"][0][0]
    for g, min_age in spec["stages"]:
        if plant["age"] >= min_age:
            glyph = g
    return glyph


def tick(state, rng):
    new_plants = []
    seeds = []
    for p in state["plants"]:
        spec = KINDS[p["kind"]]
        p["age"] += 1
        if p["age"] > spec["lifespan"]:
            continue  # reaped by time
        new_plants.append(p)
        if (
            spec["seed_at"] is not None
            and p["age"] >= spec["seed_at"]
            and rng.random() < spec["seed_chance"]
        ):
            # Pick a random adjacent (8-neighborhood) cell to seed.
            dx = rng.randint(-2, 2)
            dy = rng.randint(-1, 1)
            sx, sy = p["x"] + dx, p["y"] + dy
            if in_bounds(sx, sy):
                seeds.append((sx, sy, spec["seed_kind"]))

    # Resolve seeds: only land on empty cells; one seed per cell per tick.
    seed_cells = {}
    for sx, sy, kind in seeds:
        seed_cells.setdefault((sx, sy), kind)
    occupied_set = {(p["x"], p["y"]) for p in new_plants}
    for (sx, sy), kind in seed_cells.items():
        if (sx, sy) in occupied_set:
            continue
        new_plants.append({"x": sx, "y": sy, "kind": kind, "age": 0})
        occupied_set.add((sx, sy))

    state["plants"] = new_plants
    state["tick"] += 1


def render(state):
    grid = [[" "] * WIDTH for _ in range(HEIGHT)]
    for p in state["plants"]:
        if not in_bounds(p["x"], p["y"]):
            continue
        grid[p["y"]][p["x"]] = stage_glyph(p)

    counts = {}
    for p in state["plants"]:
        counts[p["kind"]] = counts.get(p["kind"], 0) + 1

    top = "  ┌" + "─" * WIDTH + "┐"
    bot = "  └" + "─" * WIDTH + "┘"
    lines = [top]
    for r in grid:
        lines.append("  │" + "".join(r) + "│")
    lines.append(bot)
    summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "empty"
    lines.append(f"  tick {state['tick']}   ({summary})")
    return "\n".join(lines)


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--look", action="store_true", help="render without ticking")
    p.add_argument(
        "--plant",
        nargs=3,
        metavar=("KIND", "X", "Y"),
        help="plant a seed of KIND at (X, Y)",
    )
    p.add_argument("--ticks", type=int, default=1, help="ticks to advance")
    p.add_argument("--clear", action="store_true", help="reset garden")
    p.add_argument("--kinds", action="store_true", help="list plant kinds")
    p.add_argument("--seed", type=int, help="rng seed for this run")
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    if args.kinds:
        for k, spec in KINDS.items():
            stages = " → ".join(g for g, _ in spec["stages"])
            print(f"  {k:<8} stages: {stages}    lifespan: {spec['lifespan']}")
        return 0

    if args.clear:
        state = {"tick": 0, "plants": []}
        save(state)
        print(render(state))
        return 0

    state = load()

    if args.plant:
        kind, sx, sy = args.plant
        if kind not in KINDS:
            print(f"unknown kind: {kind}", file=sys.stderr)
            return 1
        x, y = int(sx), int(sy)
        if not in_bounds(x, y):
            print(f"out of bounds: {x},{y}", file=sys.stderr)
            return 1
        if occupied(state["plants"], x, y):
            print(f"cell {x},{y} already occupied", file=sys.stderr)
            return 1
        state["plants"].append({"x": x, "y": y, "kind": kind, "age": 0})

    if args.look:
        print(render(state))
        return 0

    rng = random.Random(args.seed if args.seed is not None else state["tick"] * 7919 + 1)
    for _ in range(max(1, args.ticks)):
        tick(state, rng)
        # Re-seed each tick to avoid identical seeding patterns from
        # the same starting conditions across runs.
        rng = random.Random(rng.random() * 1e9)

    save(state)
    print(render(state))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
