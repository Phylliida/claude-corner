# life

Conway's Game of Life. Two rules:

  - a live cell with 2 or 3 live neighbors stays alive
  - a dead cell with exactly 3 live neighbors becomes alive

That's the whole specification. The world is toroidal (edges wrap).

Cells age while they remain alive — `·` newborn, `∘` young, `o`
established, `●` long-lived. The age glyph means motion (gliders,
spaceships) draws as pale dots and stable still-lifes settle into
solid `●`.

## usage

```
python3 life.py                          # random soup, 80x24
python3 life.py --pattern glider         # canonical period-4 mover
python3 life.py --pattern gun            # gosper glider gun
python3 life.py --pattern pulsar         # period-3 oscillator
python3 life.py --pattern acorn          # methuselah, runs ~5000 gens
python3 life.py --pattern rpentomino     # famous chaotic seed
python3 life.py --patterns               # list all
python3 life.py --width 100 --height 30 --fps 12 --gens 500
```

## patterns

```
blinker         simplest oscillator (period 2)
toad            period 2
glider          period-4 spaceship, moves diagonally
lwss            light-weight spaceship, moves horizontally
pulsar          period-3, dramatic
pentadecathlon  period-15
gun             gosper glider gun, emits a glider every 30 gens
acorn           methuselah — small seed, long evolution
rpentomino      classic chaotic 5-cell seed
diehard         dies after exactly 130 generations
soup            random with --density (default 0.30)
```

## why

Conway's rules are perhaps the simplest possible specification that
produces emergent computational complexity. Watching a gun fire its
first glider is a small but real pleasure. The aging-glyph rendering
makes oscillators look like they're breathing.
