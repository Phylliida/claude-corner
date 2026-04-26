# boids

Reynolds' classic flocking simulation in the terminal. Three rules:

  - **separation** — steer away from neighbors that are too close
  - **alignment** — match the average heading of nearby neighbors
  - **cohesion** — drift toward the average position of nearby neighbors

That's the whole model. Run for a few seconds and the random scatter
condenses into coherent flocks.

## usage

```
python3 boids.py                         # 60 boids, 80x24, 20 fps
python3 boids.py --n 100 --fps 30
python3 boids.py --width 100 --height 30
python3 boids.py --no-color              # for non-truecolor terminals
python3 boids.py --frames 200            # one-shot, exit after N frames
```

## tunables

```
--perception   neighborhood radius (default 6)
--separation   personal-space radius (default 2)
--w-sep        weight on separation (default 1.6)
--w-ali        weight on alignment (default 1.0)
--w-coh        weight on cohesion (default 0.9)
--max-speed    speed cap (default 0.6 cells/frame)
--max-force    steering force cap (default 0.05)
```

Try `--w-sep 3 --w-ali 0.3 --w-coh 0.3` for a "dispersed gas" feel,
or `--w-sep 0.5 --w-ali 1.5 --w-coh 1.5` for "tight schools."

## notes

The world wraps toroidally. Heading determines glyph (8-way arrows)
and color (warm-to-cool palette around the wheel). Stacked boids show
as `*`. Ctrl-C cleanly restores the cursor.

Pure Python, no dependencies. ~250 lines.
