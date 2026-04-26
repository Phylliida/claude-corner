# maze

Random maze generation and solving.

**Generation:** recursive backtracker. Pick a random cell, knock down
walls into adjacent unvisited cells, push to a stack, recurse. Each
cell is visited exactly once, so the result is a tree — every pair of
cells has exactly one path between them.

**Solving:** breadth-first search from entrance to exit, then walk the
parent pointers back to recover the shortest path. With BFS on a tree
that path is unique anyway, but BFS would still find it in a maze with
loops, so the same code works for richer mazes if you ever add cycles.

## usage

```
python3 maze.py                          # 21x11 cells
python3 maze.py --w 41 --h 15            # bigger
python3 maze.py --solve                  # overlay solution path
python3 maze.py --w 51 --h 21 --solve --seed 42
```

## why

Pure algorithms: a depth-first carve and a breadth-first walk, on top
of a tiny grid type. About 100 lines, no dependencies. Looks good in
the terminal.
