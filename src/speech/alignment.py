"""Conservative, bounded English subtitle timing estimates."""

from collections import Counter, defaultdict
from dataclasses import dataclass
from html import unescape
from math import isfinite
import re
from statistics import median


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    text: str


def tokens(text: str) -> list[str]:
    text = re.sub(r'<[^>]*>', ' ', unescape(text))
    return re.findall(r'[a-z0-9]+', text.lower().replace('’', '').replace("'", ''))


def parse_vtt(content: str) -> list[Cue]:
    def seconds(stamp: str) -> float:
        result = 0.0
        for part in stamp.split(':'):
            result = result * 60 + float(part)
        return result

    cues = []
    for block in re.split(r'\n\s*\n', content.replace('\r', '').lstrip('\ufeff')):
        lines = block.splitlines()
        if not lines or lines[0].startswith(('NOTE', 'STYLE', 'REGION')):
            continue
        for index, line in enumerate(lines):
            match = re.match(r'((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})', line)
            if match:
                start, end = map(seconds, match.groups())
                if end > start:
                    cues.append(Cue(start, end, ' '.join(lines[index + 1:])))
                break
    if not cues:
        raise ValueError('No valid WebVTT cues')
    return sorted(cues, key=lambda cue: cue.start)


def find_anchors(cues: list[Cue], words: list[dict], sample: int,
                 start: float | None = None, duration: float | None = None) -> list[dict]:
    """Match unique cue beginnings, never infer starts from later dialogue."""
    cue_tokens = [tokens(cue.text) for cue in cues]
    subtitle_words = [word for cue in cue_tokens for word in cue]
    counts = Counter(tuple(subtitle_words[i:i + 4]) for i in range(len(subtitle_words) - 3))
    recognized = [dict(word, token=token) for word in words for token in tokens(word['word'])]
    locations = defaultdict(list)
    for index in range(len(recognized) - 3):
        locations[tuple(w['token'] for w in recognized[index:index + 4])].append(index)
    anchors = []
    for cue_index, (cue, cue_words) in enumerate(zip(cues, cue_tokens)):
        if start is not None and duration is not None and not start - 30 <= cue.start <= start + duration + 30:
            continue
        plain = re.sub(r'<[^>]*>', '', unescape(cue.text)).strip()
        if re.match(r'^[\[\(♪♫]|^[\w .-]{1,40}:', plain):
            continue
        prefix = tuple(cue_words[:4])
        candidates = locations.get(prefix, [])
        if len(prefix) != 4 or counts[prefix] != 1 or len(candidates) != 1:
            continue
        matched = recognized[candidates[0]:candidates[0] + 4]
        if min(w.get('probability', 0) for w in matched) < .5:
            continue
        if not all(isfinite(w['start']) for w in matched):
            continue
        if not 0 <= matched[-1]['start'] - matched[0]['start'] <= 6:
            continue
        anchors.append(dict(cue=cue_index, subtitle=cue.start, audio=matched[0]['start'], sample=sample))
    return anchors


def fit_local(anchors: list[dict], cues: list[Cue] | None = None) -> dict:
    def insufficient(reason: str) -> dict:
        return dict(state='insufficient', reason=reason)

    valid = [a for a in anchors if all(isfinite(a[k]) for k in ('subtitle', 'audio'))]
    unique = Counter(a['cue'] for a in valid)
    ordered = sorted((a for a in valid if unique[a['cue']] == 1), key=lambda a: a['subtitle'])
    if len(ordered) < 6:
        return insufficient('Need six unique phrase anchors')
    offsets = [a['audio'] - a['subtitle'] for a in ordered]
    offset = median(offsets)
    if abs(offset) > 30:
        return insufficient('Timing difference exceeds local search range')
    half = len(offsets) // 2
    if abs(median(offsets[:half]) - median(offsets[-half:])) > .6:
        return insufficient('Timing changes within this section')
    inliers = [a for a, value in zip(ordered, offsets) if abs(value - offset) <= .6]
    if len(inliers) < 6 or len(inliers) / len(ordered) < .8:
        return insufficient('Phrase timings disagree')
    if inliers[-1]['subtitle'] - inliers[0]['subtitle'] < 20:
        return insufficient('Phrase anchors cover less than twenty seconds')
    # Each alternating half predicts the other, including its outliers. This
    # avoids reporting only the residuals used to choose the inlier estimate.
    errors = []
    for parity in (0, 1):
        train = offsets[parity::2]
        held_out = offsets[1 - parity::2]
        prediction = median(train)
        errors.extend(abs(value - prediction) for value in held_out)
    if median(errors) > .35 or sum(error <= .6 for error in errors) / len(errors) < .8:
        return insufficient('Held-out phrase timings disagree')
    offset = median(a['audio'] - a['subtitle'] for a in inliers)
    start, end = inliers[0]['subtitle'], inliers[-1]['subtitle']
    if cues is not None:
        last = inliers[-1]['cue']
        if 0 <= last < len(cues):
            end = max(end, cues[last].end)
    return dict(state='ready', result=dict(start=start, end=end, offset=offset,
                anchors=len(inliers), residual=median(errors)))
