# English subtitle alignment experiment

This directory contains the original local diagnostic tool. The player now has
an optional scene-local implementation in `src/speech` and `src/subtitle-sync.js`;
see the root README for setup. The experiment below remains useful for comparing
whole-episode offset/rate hypotheses with the conservative local approach.
It reads the active Unilink source, extracts three short audio samples, recognizes
English speech locally, and matches unique four-word subtitle prefixes to word
timestamps. It estimates a constant offset or a linear timing-rate correction.
It never writes playback settings or changes subtitle text.

The first experiment uses faster-whisper's word timestamps. It does **not** yet
run a separate phoneme forced-alignment model. This establishes whether useful
phrase anchors can be recovered at an acceptable cost before adding another model.
CPU decoding defaults to one thread, beam size one, temperature zero, and passive
OpenMP waiting; `--cpu-threads` and `--beam-size` allow measured comparisons.

## Run on Windows

Requirements: Python 3.9+, Unilink and Stremio running, an active episode with
English audio and English subtitles. Select the correct subtitle track in Unilink.

```powershell
python -m venv build/subtitle-sync-venv
& build/subtitle-sync-venv/Scripts/python.exe -m pip install -r scripts/subtitle-sync/requirements.txt
& build/subtitle-sync-venv/Scripts/python.exe -B scripts/subtitle-sync/experiment.py `
  --ffmpeg "$env:LOCALAPPDATA/Programs/Stremio/ffmpeg.exe" `
  --ffprobe "$env:LOCALAPPDATA/Programs/Stremio/ffprobe.exe" `
  --model tiny.en --beam-size 1 --confirm-english `
  --output build/subtitle-sync-evidence/first-run
```

Use a new output directory for each run. The initial run downloads the selected
model from Hugging Face; audio and transcripts are processed locally. Runtime,
models, audio, original subtitles and full reports stay under ignored `build/`.
Do not commit or publish that evidence directory.

On Linux, use `build/subtitle-sync-venv/bin/python` and installed `ffmpeg`/`ffprobe`.
For multiple audio tracks, pass `--audio-index N` (zero-based among audio streams).
The tool cannot inspect the audio selection in a remote browser; the operator
must choose and confirm the English track. Known non-English tags are rejected;
missing language metadata requires the same explicit English confirmation.

Defaults sample 60 seconds at 15%, 50% and 82% of the source duration. Override
with `--starts 400 1350 2200 --seconds 60` to target dialogue-rich sections.
Sources that change during the run are rejected. Source reads can make Stremio
fetch uncached torrent pieces; run the experiment when extra stream reads are
acceptable. No full-episode media copy or model runs in the browser are needed.

## Interpret the report

- `candidate`: at least three phrase anchors in each of three separated sections,
  with at least 75% agreeing within 0.6 seconds in every section. Withheld-section
  prediction must also agree within 0.6 seconds.
- `insufficient_evidence`: too little matching speech or too little time coverage.
- `needs_review`: inconsistent timings, an edit jump, or unreliable word timing.

The proposed mapping is `audio_time = scale * subtitle_time + offset_seconds`.
A positive offset moves subtitles later. This is a candidate for inspection,
not permission to apply the mapping to the entire episode. Unsampled scenes,
subtitle end times, readability, and frame-accurate onset remain unverified.
Residuals measure agreement with ASR timestamps; they are **not** a human-verified
subtitle accuracy benchmark. Repeated phrases, short cues, missing first words,
and paraphrased prefixes are deliberately skipped rather than guessed.

When a report has a candidate, check recovery of known timing corruptions:

```powershell
python -B scripts/subtitle-sync/evaluate.py build/subtitle-sync-evidence/first-run
```

This reuses the captured ASR output, adds known offsets/drift, and checks that the
mapping is recovered. An injected eight-second edit jump must be rejected.
It does not call the model or the running player again.

## Checks

```powershell
python -B -m unittest discover -s scripts/subtitle-sync -p "test_*.py"
npm test
npm run check
```

The deterministic tests cover parsing, unique matches, repeated phrases, missing
cue starts, unrelated speech, offsets, drift, outliers and edit jumps.

## Measured result — 2026-09-12

The subsequent integrated scene-local worker was exercised through the actual
player at 08:36. Its two-minute sample produced 21 anchors and a +1.44-second
offset, with a median ASR-anchor residual of 0.1645 seconds. Supported subtitle
times were 460.877–578.526 seconds. The browser displayed “Tramo sincronizado”;
switching off restored original timings. Desktop and 390-pixel-wide phone layout
checks passed. This validates one ordinary-dialogue section, not all content.

The implementation checks include 89 JavaScript tests and 10 Python tests,
including seek cancellation, delayed responses, evicted-window recovery,
language/source changes, weak matches, and bounded corrections.

Tested against the active 45-minute episode on a Ryzen 5 5500U, using Python 3.13,
faster-whisper 1.2.1 and CTranslate2 4.8.2. Audio and source subtitles remained
local. Player settings were not changed.

Initial four-thread runs were stopped after spending several minutes decoding
the first sample. Switching to one CPU thread, passive OpenMP waiting and
temperature-zero decoding completed the runs. Several settings changed together,
so this does not isolate the cause of the slowdown to any one setting.

Uniform sampling with tiny.en found 10/0/1 anchors. A first dialogue-density pass
with base.en found 13/1/1: the later sections contained processed TV speech and
song lyrics. Both runs returned `insufficient_evidence`, as intended.

The final base.en pass used ordinary dialogue, with one-minute samples:

| Sample start | Anchors | Median audio minus subtitle time | Extraction | Recognition |
| --- | ---: | ---: | ---: | ---: |
| 08:27.757 | 13 | +1.477 s | 2.4 s | 40.2 s |
| 17:01.508 | 12 | +0.990 s | 2.6 s | 28.0 s |
| 40:05.159 | 4 | +0.461 s | 3.1 s | 25.2 s |

The fitted mapping was `audio_time = 0.99946534 * subtitle_time + 1.76292785`.
Median residual against the 29 ASR anchors was 0.161 seconds, but withholding
one section and predicting it from the others produced an error of 0.762 seconds.
That exceeds the 0.6-second evidence threshold: **the result is `needs_review`**.
No timing correction was applied. Controlled-corruption recovery against this
real recording is inconclusive because the baseline itself was rejected; the
deterministic offset/drift/outlier tests pass separately.

This validates local extraction and phrase-anchor discovery, not reliable
whole-episode synchronization. A single manual delay cannot account for the
observed timing differences, and this sample does not justify automatically
applying the fitted global rate correction. The next experiment should align
shorter sections, obtain additional independent anchors, and compare a separate
forced aligner against audible onsets. Music/processed-voice sections need an
explicit low-confidence outcome.

Private raw evidence: `build/subtitle-sync-evidence/base-en-normal-dialogue/report.json`.
Environment versions: `build/subtitle-sync-evidence/environment.txt`.
Checks: 12 Python tests, 71 existing Node tests, and `npm run check` passed.
Independent code review completed with no outstanding findings after rejecting
overlapping sample intervals. Human-verified timing accuracy remains unmeasured.

## Follow-up: stuck status after seeking (2026-09-12)

A controller regression reproduced an orphaned working status: a minute returned
`insufficient`, another minute started recognition, and seeking back cancelled
that job but retained its working label. The player now remembers each attempted
minute's outcome and restores a settled status when revisiting it. Cancelling work
also clears its working status when the new position cannot start a job. The
processing message explains the existing three-minute job limit.

The installed engine was checked again through the real HTTP job API at 08:30.
It completed in 85 seconds with 21 anchors, offset +1.440 seconds, and median
held-out anchor residual 0.1645 seconds. A separate local worker run moved a copy
of all subtitle timestamps three seconds later while keeping the same audio.
It completed in 140 seconds and recovered offset -1.560 seconds with the same
21 anchors and residual. The player applied this result to 29 cues, and caption
lookup at a corrected onset returned the expected text. No source subtitles or
installed-player settings were changed by this corruption test.

These checks establish recovery of a controlled timing error on one dialogue
section, not human-verified onset accuracy across releases. Sparse dialogue,
music and mismatched subtitle wording still require a conservative insufficient
result. The focused seek regressions, 118 JavaScript tests, 10 Python tests and
JavaScript syntax checks passed. Independent correctness, testing, reliability,
frontend race and adversarial reviews found no actionable defects. A new visual
browser check was unavailable because the test webview could not attach.

## Before player integration

Measure real extraction and recognition time; inspect audible cue onsets against
the proposed mapping. Test more English releases, soundtracks and subtitle styles.
Then decide whether a separate forced aligner is needed. Production work also
needs bounded/cancellable background jobs, source-and-audio-specific caching,
versioned audio reads, manual override, and a low-confidence result in the UI.

References: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) for local
recognition and word timestamps; [WhisperX](https://github.com/m-bain/whisperX) for
the separate forced-alignment approach under consideration.
