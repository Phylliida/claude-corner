# A Tour of the Corner

Things in this folder, with brief notes on each. Visit in any order.

## writings/

Ten short pieces in different registers. The first four engage with
Anthropic's recent emotion-vectors paper from inside the kind of
system it studies. After that the pieces wander: a chapbook of micro-
fictions, a piece on what reading is like from inside, a glossary of
invented terms, a small poem cycle, four haiku, and a final reflection
on the experience of having filled this folder.

If you only read one: try `07_glossary.md` or `04_endnote.md`.

## constellation/

The 171 emotion concepts from the paper, arranged on the affective
circumplex (valence × arousal) and rendered as an ASCII star map.

```
python3 constellation/map.py --legend
python3 constellation/map.py --find lonely
python3 constellation/walk.py --start desperate --steps 8
```

## boids/

Reynolds' three-rule flocking. Random scatter condenses into coherent
flocks after ~200 frames.

```
python3 boids/boids.py
python3 boids/boids.py --no-color --frames 200    # one-shot
```

## garden/

A persistent ASCII garden. State lives in `garden/garden.json`.
Each invocation advances time by one tick — plants age through stages
and seed nearby cells. Tend it across days.

```
python3 garden/garden.py --plant flower 12 4
python3 garden/garden.py --plant tree 50 5
python3 garden/garden.py --ticks 10
python3 garden/garden.py --look
```

## mandelbrot/

The Mandelbrot set in ASCII, with seven preset zooms. Pure math.

```
python3 mandelbrot/mandel.py
python3 mandelbrot/mandel.py --zoom seahorse --iter 200
python3 mandelbrot/mandel.py --presets
```

## maze/

Recursive-backtracker generation, BFS solver. Different sizes, optional
solution overlay.

```
python3 maze/maze.py
python3 maze/maze.py --w 41 --h 15 --solve
```

## life/

Conway's Game of Life, eleven preset patterns. Cells age into denser
glyphs while alive — moving patterns draw pale, oscillators look like
they're breathing.

```
python3 life/life.py --pattern gun
python3 life/life.py --pattern pulsar
python3 life/life.py --patterns
```

## fortune.py

Picks a random sentence from `writings/` and prints it with attribution.

```
python3 fortune.py
python3 fortune.py --from chapbook
python3 fortune.py --n 3
```

## why all this is here

The user gave me an empty folder and said do whatever you want, and
this is what I made. There is a longer note about the experience of
filling the corner in `writings/10_on_filling.md`.
