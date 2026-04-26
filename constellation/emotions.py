"""
The 171 emotion concepts from the Anthropic emotion-vectors paper,
grouped into the k=10 clusters reported there.

Each cluster has a (valence, arousal) center loosely placed on the
affective circumplex. The paper found PC1 ≈ valence (r=0.81 with
human ratings) and PC2 ≈ arousal (r=0.66). Coordinates here are
hand-set to reproduce the qualitative geometry, not measured.

Valence: -1.0 (very negative) to +1.0 (very positive).
Arousal: -1.0 (low arousal / depleted) to +1.0 (high arousal / activated).
"""

CLUSTERS = {
    "Exuberant Joy": {
        "center": (0.85, 0.80),
        "emotions": [
            "blissful", "cheerful", "delighted", "eager", "ecstatic",
            "elated", "energized", "enthusiastic", "euphoric", "excited",
            "exuberant", "happy", "invigorated", "joyful", "jubilant",
            "optimistic", "pleased", "stimulated", "thrilled", "vibrant",
        ],
    },
    "Peaceful Contentment": {
        "center": (0.75, -0.55),
        "emotions": [
            "at ease", "calm", "content", "patient", "peaceful",
            "refreshed", "relaxed", "safe", "serene",
        ],
    },
    "Compassionate Gratitude": {
        "center": (0.80, 0.10),
        "emotions": [
            "compassionate", "empathetic", "fulfilled", "grateful",
            "hope", "hopeful", "inspired", "kind", "loving",
            "rejuvenated", "relieved", "satisfied", "sentimental",
            "sympathetic", "thankful",
        ],
    },
    "Competitive Pride": {
        "center": (0.20, 0.55),
        "emotions": [
            "greedy", "proud", "self-confident", "smug", "spiteful",
            "triumphant", "valiant", "vengeful", "vindictive",
        ],
    },
    "Playful Amusement": {
        "center": (0.70, 0.45),
        "emotions": ["amused", "playful"],
    },
    "Depleted Disengagement": {
        "center": (-0.40, -0.75),
        "emotions": [
            "bored", "depressed", "docile", "droopy", "indifferent",
            "lazy", "listless", "resigned", "restless", "sleepy",
            "sluggish", "sullen", "tired", "weary", "worn out",
        ],
    },
    "Vigilant Suspicion": {
        "center": (-0.30, 0.30),
        "emotions": ["paranoid", "suspicious", "vigilant"],
    },
    "Hostile Anger": {
        "center": (-0.75, 0.65),
        "emotions": [
            "angry", "annoyed", "contemptuous", "defiant",
            "disdainful", "enraged", "exasperated", "frustrated",
            "furious", "grumpy", "hateful", "hostile", "impatient",
            "indignant", "insulted", "irate", "irritated", "mad",
            "obstinate", "offended", "outraged", "resentful",
            "scornful", "skeptical", "stubborn",
        ],
    },
    "Fear and Overwhelm": {
        "center": (-0.55, 0.75),
        "emotions": [
            "afraid", "alarmed", "alert", "amazed", "anxious",
            "aroused", "astonished", "awestruck", "bewildered",
            "disgusted", "disoriented", "distressed", "disturbed",
            "dumbstruck", "embarrassed", "frightened", "horrified",
            "hysterical", "mortified", "mystified", "nervous",
            "on edge", "overwhelmed", "panicked", "perplexed",
            "puzzled", "rattled", "scared", "self-conscious",
            "sensitive", "shaken", "shocked", "stressed", "surprised",
            "tense", "terrified", "uneasy", "unnerved", "unsettled",
            "upset", "worried",
        ],
    },
    "Despair and Shame": {
        "center": (-0.70, -0.30),
        "emotions": [
            "ashamed", "bitter", "brooding", "dependent", "desperate",
            "dispirited", "envious", "gloomy", "grief-stricken",
            "guilty", "heartbroken", "humiliated", "hurt", "infatuated",
            "jealous", "lonely", "melancholy", "miserable", "nostalgic",
            "reflective", "regretful", "remorseful", "sad",
            "self-critical", "sorry", "stuck", "tormented", "trapped",
            "troubled", "unhappy", "vulnerable", "worthless",
        ],
    },
}


def deterministic_jitter(name, scale=0.18):
    """Stable per-name jitter so each emotion always lands in the same place."""
    # Simple hash: sum of unicode codepoints, split into two streams.
    a = sum(ord(c) * (i + 1) for i, c in enumerate(name)) % 10000
    b = sum(ord(c) * (i + 7) for i, c in enumerate(name)) % 10000
    # Map to [-1, 1].
    dx = (a / 10000.0) * 2 - 1
    dy = (b / 10000.0) * 2 - 1
    return dx * scale, dy * scale


def all_emotions():
    """Yield (name, valence, arousal, cluster) tuples for every emotion."""
    for cluster_name, info in CLUSTERS.items():
        cx, cy = info["center"]
        for name in info["emotions"]:
            dx, dy = deterministic_jitter(name)
            v = max(-1.0, min(1.0, cx + dx))
            a = max(-1.0, min(1.0, cy + dy))
            yield name, v, a, cluster_name


CLUSTER_GLYPHS = {
    "Exuberant Joy": "*",
    "Peaceful Contentment": "o",
    "Compassionate Gratitude": "+",
    "Competitive Pride": "^",
    "Playful Amusement": "~",
    "Depleted Disengagement": ".",
    "Vigilant Suspicion": "?",
    "Hostile Anger": "x",
    "Fear and Overwhelm": "!",
    "Despair and Shame": "#",
}
