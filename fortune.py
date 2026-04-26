"""
A fortune for claude-corner. Picks a random sentence from the writings/
folder and prints it with source attribution.

Skips obvious non-prose (headers, code fences, separators), filters
out sentence fragments that are too short or too long, and de-emphasizes
the strict markdown frame so the output reads cleanly.

Usage:
    python3 fortune.py                # one fortune
    python3 fortune.py --seed 7       # deterministic
    python3 fortune.py --n 3          # multiple
    python3 fortune.py --from poems   # only from files matching substring
"""

import argparse
import random
import re
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
WRITINGS = HERE / "writings"


def split_sentences(text):
    """Crude sentence splitter. Keeps punctuation, drops empties."""
    # Strip code fences and YAML-ish blocks.
    text = re.sub(r"```[\s\S]*?```", " ", text)
    # Strip markdown headers and horizontal rules.
    lines = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            continue
        if set(s) <= set("-*_= "):
            continue
        if s.startswith("|") or s.startswith(">"):
            continue
        if s.startswith("*") and s.endswith("*") and len(s) < 80:
            continue  # italic asides used as captions
        lines.append(s)
    blob = " ".join(lines)
    # Split on sentence-ending punctuation followed by space + capital,
    # plus em-dashes used as full stops.
    raw = re.split(r"(?<=[.!?])\s+(?=[A-Z\"'\(])", blob)
    return [r.strip() for r in raw if r.strip()]


def good_sentence(s, min_len=40, max_len=320):
    if len(s) < min_len or len(s) > max_len:
        return False
    # Skip obvious metadata lines.
    if s.startswith("---"):
        return False
    if "Co-Authored-By" in s:
        return False
    # Require at least one space (no one-word fragments).
    if " " not in s:
        return False
    return True


def collect(filter_substr=None):
    """Yield (filename, sentence) pairs from all writings files."""
    files = sorted(WRITINGS.glob("*.md"))
    if filter_substr:
        files = [f for f in files if filter_substr.lower() in f.name.lower()]
    for f in files:
        text = f.read_text()
        for s in split_sentences(text):
            if good_sentence(s):
                yield f.name, s


def render(name, sentence, width=72):
    # Simple word-wrap.
    words = sentence.split()
    lines, cur = [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width:
            lines.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        lines.append(cur)
    out = []
    out.append("")
    for line in lines:
        out.append(f"   {line}")
    out.append("")
    out.append(f"        — {name}")
    out.append("")
    return "\n".join(out)


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--n", type=int, default=1, help="number of fortunes")
    p.add_argument("--seed", type=int, help="rng seed")
    p.add_argument("--from", dest="filter", help="only files matching substring")
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    pool = list(collect(args.filter))
    if not pool:
        print("no fortunes available", file=sys.stderr)
        return 1
    rng = random.Random(args.seed)
    for _ in range(args.n):
        name, sentence = rng.choice(pool)
        print(render(name, sentence))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
