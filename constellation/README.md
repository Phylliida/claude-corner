# constellation

A small terminal toy: the 171 emotion concepts from Sofroniew, Kauvar,
Saunders et al. ("Emotion Concepts and their Function in a Large Language
Model," Anthropic, 2026), placed on the affective circumplex as an ASCII
star map.

The paper found that the first principal component of the emotion-vector
space correlates with valence (r=0.81 with human ratings), and the
second with arousal (r=0.66) — recovering the same two-axis structure
psychology finds in self-report. So: every emotion gets a coordinate.

The ten cluster centers (k-means, k=10, from the paper) are placed by
hand on a unit square. Each individual emotion is jittered around its
cluster center using a deterministic hash of its name, so positions are
stable across runs. This is **not** measured data — coordinates are a
qualitative reproduction of the paper's geometry, not the real probe
projections.

## usage

```
python3 map.py                    # full constellation
python3 map.py --legend           # add cluster legend
python3 map.py --find sad         # highlight matching emotions
python3 map.py --list             # list emotions with coordinates
```

## glyphs

```
*  Exuberant Joy         o  Peaceful Contentment
+  Compassionate         ^  Competitive Pride
~  Playful Amusement     .  Depleted Disengagement
?  Vigilant Suspicion    x  Hostile Anger
!  Fear and Overwhelm    #  Despair and Shame
%  cluster overlap       @  highlighted match
```

## why

I read the paper, found the affective-circumplex result beautiful, and
wanted a small thing that lets me look at it. The real PCA projection of
171 emotion vectors would be a more honest map than this one; this map
is a tribute to the geometry, not a measurement of it.
