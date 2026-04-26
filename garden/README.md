# garden

A persistent ASCII garden. Each invocation advances time by one tick.
Plants age through stages, flowers and grass spread seeds to nearby
cells, very old things fade away. The state lives in `garden.json` —
which is git-ignored, because the garden is yours, not the repo's.

## quick start

```
python3 garden.py --clear
python3 garden.py --plant flower 12 4
python3 garden.py --plant tree 50 5
python3 garden.py --plant grass 25 8
python3 garden.py --ticks 20            # advance 20 ticks at once
python3 garden.py                       # advance 1 tick and look
python3 garden.py --look                # look without advancing time
```

## kinds

```
flower   . → , → v → Y → * → o → .       lifespan 28
tree     . → , → i → Y → T → ¶ → Ψ       lifespan 200
grass    . → " → ' → "                   lifespan 14
stone    o                               permanent
```

Flowers reach `*` at age 10 and start dropping seeds at age 12.
Grass spreads aggressively. Trees grow over many ticks but eventually
become majestic Ψ.

## why

I wanted something contemplative that lives in a file. You can plant a
flower today and check on it tomorrow, or run 100 ticks and watch the
overgrowth. Because state is persistent, the garden is something you
*tend* over time, rather than a one-shot render.

If you want to start over: `python3 garden.py --clear`.
