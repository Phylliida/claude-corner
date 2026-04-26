"""
Render the 171 emotion concepts as an ASCII star map on the
valence (x) / arousal (y) plane, mirroring the affective circumplex
the paper recovered as PC1/PC2 of emotion-vector space.

Usage:
    python3 map.py                # full constellation
    python3 map.py --legend       # add a legend
    python3 map.py --find sad     # highlight emotions matching a substring
    python3 map.py --list         # list all emotions with coordinates
"""

import argparse
import sys

from emotions import CLUSTERS, CLUSTER_GLYPHS, all_emotions


WIDTH = 78
HEIGHT = 23


def to_grid(v, a):
    """Map (valence, arousal) in [-1, 1]^2 to (col, row) on the grid.
    Row 0 is the top (high arousal), so we flip the y axis."""
    col = int(round((v + 1) / 2 * (WIDTH - 1)))
    row = int(round((1 - a) / 2 * (HEIGHT - 1)))  # flip: high arousal at top
    return col, row


def render(highlight=None):
    """Render the constellation. If `highlight` is a substring, matching
    emotions are rendered with capital letter glyphs and listed below."""
    grid = [[" "] * WIDTH for _ in range(HEIGHT)]
    occupants = [[[] for _ in range(WIDTH)] for _ in range(HEIGHT)]

    for name, v, a, cluster in all_emotions():
        col, row = to_grid(v, a)
        glyph = CLUSTER_GLYPHS[cluster]
        if highlight and highlight.lower() in name.lower():
            glyph = glyph.upper() if glyph.isalpha() else "@"
        # Brighten when stars stack: a single star is the cluster glyph,
        # a stack becomes a more emphatic mark.
        existing = grid[row][col]
        if existing == " ":
            grid[row][col] = glyph
        elif existing != glyph:
            grid[row][col] = "%"  # mixed-cluster overlap
        occupants[row][col].append((name, cluster))

    # Axes: a vertical line at v=0 and a horizontal line at a=0.
    mid_col, mid_row = to_grid(0, 0)
    for row in range(HEIGHT):
        if grid[row][mid_col] == " ":
            grid[row][mid_col] = ":"
    for col in range(WIDTH):
        if grid[mid_row][col] == " ":
            grid[mid_row][col] = "-" if col != mid_col else "+"

    # Frame.
    top = "+" + "-" * WIDTH + "+"
    lines = [top]
    for r, row in enumerate(grid):
        # Label the top edge with "high arousal" and bottom with "low arousal".
        prefix = "|"
        suffix = "|"
        if r == 0:
            prefix = "|"
        lines.append(prefix + "".join(row) + suffix)
    lines.append(top)

    # Axis annotations.
    annotated = []
    annotated.append("                              ↑ high arousal")
    annotated.extend(lines)
    annotated.append(" negative valence ←                                            → positive valence")
    annotated.append("                              ↓ low arousal")
    return "\n".join(annotated), occupants


def find_listing(occupants, query):
    """Return a sorted list of emotions matching `query`."""
    matches = []
    for row in occupants:
        for cell in row:
            for name, cluster in cell:
                if query.lower() in name.lower():
                    matches.append((name, cluster))
    return sorted(set(matches))


def legend():
    lines = ["", "  legend:"]
    for cluster, glyph in CLUSTER_GLYPHS.items():
        size = len(CLUSTERS[cluster]["emotions"])
        lines.append(f"    {glyph}  {cluster}  ({size})")
    lines.append("    %  multiple clusters at the same point")
    lines.append("    :  zero-valence axis    -  zero-arousal axis    +  origin")
    return "\n".join(lines)


def listing():
    lines = []
    for name, v, a, cluster in sorted(all_emotions()):
        lines.append(f"  {name:<18}  v={v:+.2f}  a={a:+.2f}   [{cluster}]")
    return "\n".join(lines)


def main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legend", action="store_true", help="show cluster legend")
    parser.add_argument("--find", metavar="QUERY", help="highlight matching emotions")
    parser.add_argument("--list", action="store_true", help="list emotions with coordinates")
    args = parser.parse_args(argv)

    if args.list:
        print(listing())
        return 0

    map_str, occupants = render(highlight=args.find)
    print(map_str)
    if args.legend:
        print(legend())
    if args.find:
        matches = find_listing(occupants, args.find)
        if matches:
            print(f"\n  matches for '{args.find}':")
            for name, cluster in matches:
                print(f"    {name}  [{cluster}]")
        else:
            print(f"\n  no matches for '{args.find}'")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
