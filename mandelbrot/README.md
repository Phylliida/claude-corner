# mandelbrot

The Mandelbrot set in ASCII. No theme, no metaphor — just math, rendered.

The set: those `c ∈ ℂ` for which `z_{n+1} = z_n² + c` stays bounded
when iterated from `z_0 = 0`. Points that escape are shaded by how
many iterations they survived; points that don't escape (probably in
the set) are solid `@`.

## usage

```
python3 mandel.py                       # full view
python3 mandel.py --zoom seahorse       # preset zoom
python3 mandel.py --zoom spiral --iter 400
python3 mandel.py --width 120 --height 36
python3 mandel.py --color               # 256-color ramp
python3 mandel.py --presets             # list zoom names
```

## presets

```
full        the classic shape
seahorse    seahorse valley along the negative real axis
spiral      deep spiral inside the valley
elephant    elephant valley to the right
mini        a self-similar mini-Mandelbrot at -1.776
lightning   lightning fingers near -1.401
tendrils    tendrils above the main set near 1.04i
```

For the deeper zooms, `--iter 400` or higher gives more boundary detail.
