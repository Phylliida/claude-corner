"""
Maze generator + solver.

Generation: recursive backtracker. Start from a random cell, knock down
walls between adjacent unvisited cells, push to a stack, recurse. Each
cell is visited exactly once, producing a tree-shaped (no-loops) maze.

Solving: BFS from entrance to exit, then walk the parent pointers back
to recover the shortest path. Drawn as · markers along the corridor.

Usage:
    python3 maze.py                           # 21x11 maze, no solution shown
    python3 maze.py --w 41 --h 15 --solve     # solve and overlay
    python3 maze.py --seed 42                 # deterministic
"""

import argparse
import collections
import random
import sys


# Walls bitmask per cell.
N, S, E, W = 1, 2, 4, 8
OPP = {N: S, S: N, E: W, W: E}
DXY = {N: (0, -1), S: (0, 1), E: (1, 0), W: (-1, 0)}


def generate(width, height, rng):
    """Return a 2D grid of cell bitmasks. width and height are in cells.
    Initially every cell has all 4 walls (mask = 15)."""
    grid = [[0 for _ in range(width)] for _ in range(height)]
    visited = [[False] * width for _ in range(height)]
    stack = [(rng.randrange(width), rng.randrange(height))]
    visited[stack[0][1]][stack[0][0]] = True

    while stack:
        x, y = stack[-1]
        # Find unvisited neighbors.
        candidates = []
        for d, (dx, dy) in DXY.items():
            nx, ny = x + dx, y + dy
            if 0 <= nx < width and 0 <= ny < height and not visited[ny][nx]:
                candidates.append((d, nx, ny))
        if not candidates:
            stack.pop()
            continue
        d, nx, ny = rng.choice(candidates)
        # Carve a passage between (x,y) and (nx,ny).
        grid[y][x] |= d
        grid[ny][nx] |= OPP[d]
        visited[ny][nx] = True
        stack.append((nx, ny))
    return grid


def solve(grid, start, goal):
    """BFS from start to goal in a maze grid, return list of cells or []."""
    width = len(grid[0])
    height = len(grid)
    parent = {start: None}
    q = collections.deque([start])
    while q:
        x, y = q.popleft()
        if (x, y) == goal:
            # Reconstruct path.
            path = []
            node = (x, y)
            while node is not None:
                path.append(node)
                node = parent[node]
            return list(reversed(path))
        for d, (dx, dy) in DXY.items():
            if not (grid[y][x] & d):
                continue  # wall in this direction
            nx, ny = x + dx, y + dy
            if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in parent:
                parent[(nx, ny)] = (x, y)
                q.append((nx, ny))
    return []


def render(grid, path=None):
    """Render the maze using a wall-and-corridor grid that's
    (2*width+1) by (2*height+1) characters."""
    width = len(grid[0])
    height = len(grid)
    canvas_w = 2 * width + 1
    canvas_h = 2 * height + 1
    canvas = [[" "] * canvas_w for _ in range(canvas_h)]

    # Top/bottom walls.
    for j in range(canvas_h):
        for i in range(canvas_w):
            if i == 0 or i == canvas_w - 1 or j == 0 or j == canvas_h - 1:
                canvas[j][i] = "█"

    # Internal walls between cells.
    for y in range(height):
        for x in range(width):
            cx, cy = 2 * x + 1, 2 * y + 1
            mask = grid[y][x]
            # Walls present where the corresponding direction bit is NOT set.
            if not (mask & N) and cy > 0:
                canvas[cy - 1][cx] = "█"
            if not (mask & S) and cy + 1 < canvas_h:
                canvas[cy + 1][cx] = "█"
            if not (mask & W) and cx > 0:
                canvas[cy][cx - 1] = "█"
            if not (mask & E) and cx + 1 < canvas_w:
                canvas[cy][cx + 1] = "█"
            # Corner posts: any wall corner is filled.
            for ix in (cx - 1, cx + 1):
                for iy in (cy - 1, cy + 1):
                    if 0 <= ix < canvas_w and 0 <= iy < canvas_h:
                        # A corner is solid if any of its 4 incident walls is set.
                        # Simpler: just fill all corners — recursive backtracker
                        # mazes always have wall posts at every odd-coordinate corner.
                        canvas[iy][ix] = "█"

    # Open the entrance and exit at the corners.
    canvas[1][0] = " "
    canvas[canvas_h - 2][canvas_w - 1] = " "

    if path:
        for (x, y) in path:
            canvas[2 * y + 1][2 * x + 1] = "·"
        # Connect path glyphs through doorways.
        for i in range(len(path) - 1):
            (x1, y1) = path[i]
            (x2, y2) = path[i + 1]
            mx, my = x1 + x2 + 1, y1 + y2 + 1  # midpoint in canvas coords
            canvas[my][mx] = "·"
        # Also mark entrance/exit notches.
        canvas[1][0] = "·"
        canvas[canvas_h - 2][canvas_w - 1] = "·"

    return "\n".join("".join(row) for row in canvas)


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--w", type=int, default=21, help="cell width")
    p.add_argument("--h", type=int, default=11, help="cell height")
    p.add_argument("--seed", type=int, help="rng seed")
    p.add_argument("--solve", action="store_true", help="overlay BFS solution")
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    rng = random.Random(args.seed)
    grid = generate(args.w, args.h, rng)
    path = []
    if args.solve:
        path = solve(grid, (0, 0), (args.w - 1, args.h - 1))
    print(render(grid, path if args.solve else None))
    if args.solve:
        print(f"  path length: {len(path)} cells   ({args.w * args.h} total)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
