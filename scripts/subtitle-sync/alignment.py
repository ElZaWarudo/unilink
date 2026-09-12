"""Conservative phrase anchors and timing estimates for an English-only experiment."""

from collections import Counter, defaultdict
from dataclasses import dataclass
from html import unescape
from itertools import combinations
from statistics import median
import re


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str


def tokens(text: str) -> list[str]:
    text = re.sub(r"<[^>]*>|\[[^\]]*\]", " ", text)
    return re.findall(r"[a-z0-9]+", unescape(text).lower().replace("’", "").replace("'", ""))


def parse_vtt(content: str) -> list[Cue]:
    def seconds(stamp: str) -> float:
        result = 0.0
        for part in stamp.split(":"):
            result = result * 60 + float(part)
        return result

    cues = []
    for block in re.split(r"\n\s*\n", content.replace("\r", "").lstrip("\ufeff")):
        lines = block.splitlines()
        if not lines or lines[0].startswith(("NOTE", "STYLE", "REGION")):
            continue
        for index, line in enumerate(lines):
            match = re.match(r"((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})", line)
            if match:
                start, end = map(seconds, match.groups())
                if end > start:
                    cues.append(Cue(start, end, " ".join(lines[index + 1:])))
                break
    if not cues:
        raise ValueError("No valid WebVTT cues found")
    return sorted(cues, key=lambda cue: cue.start)


def find_anchors(cues: list[Cue], words: list[dict], sample: int) -> list[dict]:
    """Match unique four-word cue prefixes; never infer cue starts from later words.

    Exact prefixes deliberately trade coverage for trustworthy timing. Paraphrases
    and missing initial words are skipped. Remaining cue text need not be identical.
    """
    cue_tokens = [tokens(cue.text) for cue in cues]
    subtitle_words = [word for cue in cue_tokens for word in cue]
    counts = Counter(tuple(subtitle_words[i:i + 4]) for i in range(len(subtitle_words) - 3))
    recognized = [dict(word, token=token) for word in words for token in tokens(word["word"])]
    locations = defaultdict(list)
    for index in range(len(recognized) - 3):
        locations[tuple(w["token"] for w in recognized[index:index + 4])].append(index)

    anchors = []
    for cue_index, (cue, cue_words) in enumerate(zip(cues, cue_tokens)):
        prefix = tuple(cue_words[:4])
        candidates = locations.get(prefix, [])
        if len(prefix) != 4 or counts[prefix] != 1 or len(candidates) != 1:
            continue
        matched = recognized[candidates[0]:candidates[0] + 4]
        if min(word.get("probability", 0) for word in matched) < .5:
            continue
        if matched[-1]["start"] - matched[0]["start"] > 6:
            continue
        anchors.append({"cue": cue_index, "subtitle": cue.start,
                        "audio": matched[0]["start"], "sample": sample})
    return anchors


def fit_timing(anchors: list[dict], tolerance: float = .6) -> dict:
    """Fit sample medians and require agreement in every sampled section.

    The result is a candidate for evaluation, never permission to auto-apply it.
    Reported residuals measure ASR/subtitle agreement, not human-verified accuracy.
    """
    groups = defaultdict(list)
    for anchor in anchors:
        groups[anchor["sample"]].append(anchor)
    if len(groups) < 3 or any(len(group) < 3 for group in groups.values()):
        return {"status": "insufficient_evidence", "reason": "Need three sections with at least three unique phrase anchors each"}
    points = [(median(a["subtitle"] for a in group), median(a["audio"] - a["subtitle"] for a in group))
              for group in groups.values()]
    span = max(x for x, _ in points) - min(x for x, _ in points)
    if span < 120:
        return {"status": "insufficient_evidence", "reason": "Samples cover less than two minutes"}

    def line(points: list[tuple[float, float]]) -> tuple[float, float]:
        slopes = [(dy2 - dy1) / (x2 - x1) for (x1, dy1), (x2, dy2) in combinations(points, 2) if abs(x2 - x1) >= 60]
        slope = median(slopes) if slopes else 0.0
        return slope, median(dy - slope * x for x, dy in points)

    offset = median(dy for _, dy in points)
    slope, affine_offset = line(points)
    offset_error = max(abs(dy - offset) for _, dy in points)
    affine_error = max(abs(dy - slope * x - affine_offset) for x, dy in points)
    use_affine = abs(slope * span) >= .75 and affine_error + .15 < offset_error
    if use_affine:
        offset = affine_offset
    else:
        slope = 0.0
    residuals = [abs(a["audio"] - ((1 + slope) * a["subtitle"] + offset)) for a in anchors]
    section_agreement = {str(sample): sum(abs(a["audio"] - ((1 + slope) * a["subtitle"] + offset)) <= tolerance for a in group) / len(group)
                         for sample, group in groups.items()}
    # Predict each withheld section from the other sections, rather than reporting
    # only how closely the model fits the observations used to construct it.
    held_out = []
    for i, (x, dy) in enumerate(points):
        remaining = points[:i] + points[i + 1:]
        hold_slope, hold_offset = line(remaining) if use_affine else (0.0, median(y for _, y in remaining))
        held_out.append(abs(dy - hold_slope * x - hold_offset))
    accepted = abs(slope) <= .05 and min(section_agreement.values()) >= .75 and max(held_out) <= tolerance
    return {"status": "candidate" if accepted else "needs_review",
            "kind": "affine" if use_affine else "offset", "scale": 1 + slope,
            "offset_seconds": offset, "anchor_count": len(anchors),
            "median_residual_seconds": median(residuals),
            "max_held_out_section_error_seconds": max(held_out),
            "section_agreement": section_agreement,
            "measured_subtitle_range": [min(a["subtitle"] for a in anchors), max(a["subtitle"] for a in anchors)],
            "reason": "Agreement across sampled sections" if accepted else "Sections disagree; possible edit jump, bad matches, or unreliable word timing"}
