"""Read-only local Stremio experiment. Writes evidence, never player settings."""

import argparse
import faulthandler
from html import unescape
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.parse import urljoin, urlparse
from urllib.request import urlopen
import wave

from alignment import find_anchors, fit_timing, parse_vtt


def get_text(url: str) -> str:
    with urlopen(url, timeout=30) as response:
        return response.read(8_000_001).decode("utf-8-sig")


def snapshot(base: str) -> dict:
    status = json.loads(get_text(base + "/api/status"))
    if not status.get("active"):
        raise ValueError("Select an episode in Unilink first")
    return {key: status.get(key) for key in ("serverInstanceId", "version", "contentId", "subtitleId", "subtitleUrl")}


def validate_sample_starts(starts: list[float], seconds: float, duration: float) -> list[float]:
    if len(starts) < 3 or any(not 0 <= start <= duration - seconds for start in starts):
        raise ValueError("Provide at least three valid sample start times")
    ordered = sorted(starts)
    if any(left + seconds > right for left, right in zip(ordered, ordered[1:])):
        raise ValueError("Audio sample intervals must not overlap; repeated speech is not independent evidence")
    return ordered


def run(args: argparse.Namespace) -> Path:
    base = args.base_url.rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1", "::1") or parsed.path not in ("", "/"):
        raise ValueError("Use the local Unilink HTTP URL")
    if args.audio_index < 0 or not 15 <= args.seconds <= 120:
        raise ValueError("Audio index must be nonnegative; sample length must be 15–120 seconds")
    initial = snapshot(base)
    if not initial["subtitleUrl"]:
        raise ValueError("Select English subtitles first")
    subtitle_url = urljoin(base + "/", unescape(initial["subtitleUrl"]))
    subtitle = urlparse(subtitle_url)
    if subtitle.netloc != parsed.netloc or not subtitle.path.startswith("/subtitle/"):
        raise ValueError("Expected a local Unilink subtitle URL")
    source = get_text(subtitle_url)
    cues = parse_vtt(source)
    # The current raw-media endpoint is stable rather than versioned. Check source
    # identity around every read, and discard the run if selection changes.
    def unchanged() -> None:
        if snapshot(base) != initial:
            raise ValueError("Active source or subtitles changed; discard this run and retry")

    probe = subprocess.run([args.ffprobe, "-v", "error", "-rw_timeout", "15000000",
                            "-show_entries", "format=duration:stream=index,codec_type:stream_tags=language",
                            "-of", "json", base + "/media"], capture_output=True, text=True, check=True, timeout=45)
    media = json.loads(probe.stdout)
    duration = float(media["format"]["duration"])
    tracks = [s for s in media["streams"] if s["codec_type"] == "audio"]
    if args.audio_index >= len(tracks):
        raise ValueError("Audio track is unavailable")
    language = tracks[args.audio_index].get("tags", {}).get("language", "und").lower()
    if language not in ("en", "eng", "und", ""):
        raise ValueError("Selected audio track is not tagged English")
    if len(tracks) > 1 and not args.confirm_english:
        raise ValueError("Confirm the selected English audio track with --confirm-english")
    if not args.confirm_english:
        raise ValueError("This English-only experiment requires --confirm-english for both audio and subtitles")
    if duration < args.seconds + 120:
        raise ValueError("Need a source long enough for three separated samples")
    unchanged()
    # Spread samples across the episode, avoiding the opening recap and credits.
    starts = validate_sample_starts(args.starts or [duration * .15, duration * .5, duration * .82], args.seconds, duration)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    (output / "source.vtt").write_text(source, encoding="utf-8")
    report = {"source": initial, "audio_index": args.audio_index, "audio_language_tag": language,
              "english_confirmed": True, "duration_seconds": duration, "model": args.model,
              "beam_size": args.beam_size, "cpu_threads": args.cpu_threads,
              "samples": [], "applied_to_player": False}
    # Avoid busy-waiting between small CPU decoding operations on a desktop also
    # serving playback. Respect an explicitly configured OpenMP policy.
    os.environ.setdefault("OMP_WAIT_POLICY", "PASSIVE")
    report["omp_wait_policy"] = os.environ["OMP_WAIT_POLICY"]
    from faster_whisper import WhisperModel

    model_start = time.perf_counter()
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.cpu_threads,
                         download_root=args.model_cache)
    report["model_load_seconds"] = time.perf_counter() - model_start
    all_anchors = []
    for index, start in enumerate(starts):
        unchanged()
        wav = output / f"sample-{index}.wav"
        began = time.perf_counter()
        subprocess.run([args.ffmpeg, "-nostdin", "-v", "error", "-rw_timeout", "15000000",
                        "-ss", str(start), "-i", base + "/media", "-t", str(args.seconds),
                        "-map", f"0:a:{args.audio_index}", "-vn", "-ac", "1", "-ar", "16000",
                        "-c:a", "pcm_s16le", "-n", str(wav)], capture_output=True, check=True, timeout=90)
        extraction_seconds = time.perf_counter() - began
        unchanged()
        with wave.open(str(wav)) as audio:
            extracted_duration = audio.getnframes() / audio.getframerate()
        if abs(extracted_duration - args.seconds) > .2:
            raise ValueError("Audio sample is truncated; no timing estimate will be produced")
        began = time.perf_counter()
        print(f"Sample {index + 1}: audio extracted; recognizing speech", flush=True)
        segments, _ = model.transcribe(str(wav), language="en", beam_size=args.beam_size,
                                       word_timestamps=True, vad_filter=True,
                                       temperature=0, condition_on_previous_text=False)
        words = []
        for segment in segments:
            words.extend({"word": w.word, "start": start + w.start, "end": start + w.end,
                          "probability": w.probability} for w in (segment.words or []))
            print(f"Sample {index + 1}: recognized through {segment.end:.1f}s", flush=True)
        transcription_seconds = time.perf_counter() - began
        anchors = find_anchors(cues, words, index)
        all_anchors.extend(anchors)
        sample = {"index": index, "start": start, "duration": extracted_duration,
                  "extraction_seconds": extraction_seconds, "transcription_seconds": transcription_seconds,
                  "words": words, "anchors": anchors}
        report["samples"].append(sample)
        (output / "observations.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"Sample {index + 1}: {len(anchors)} anchors, extraction {extraction_seconds:.1f}s, recognition {transcription_seconds:.1f}s", flush=True)
    unchanged()
    if any(len(sample["anchors"]) < 3 for sample in report["samples"]):
        report["timing"] = {"status": "insufficient_evidence", "reason": "At least one sampled section has fewer than three anchors"}
    else:
        report["timing"] = fit_timing(all_anchors)
    path = output / "report.json"
    path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report["timing"], indent=2), flush=True)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:17891")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--audio-index", type=int, default=0, help="Zero-based index among audio streams")
    parser.add_argument("--confirm-english", action="store_true", help="Both chosen audio and subtitles are English")
    parser.add_argument("--model", choices=("tiny.en", "base.en", "small.en"), default="base.en")
    parser.add_argument("--beam-size", type=int, choices=(1, 5), default=1)
    parser.add_argument("--cpu-threads", type=int, choices=(1, 2, 4), default=1)
    parser.add_argument("--model-cache", default="build/subtitle-sync-models")
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--starts", type=float, nargs="+")
    parser.add_argument("--output", required=True, help="New directory for private evidence; use build/ to keep it ignored")
    args = parser.parse_args()
    # A diagnostic watchdog makes slow native inference visible in the console.
    faulthandler.dump_traceback_later(120, repeat=True)
    try:
        print(f"Evidence: {run(args).resolve()}")
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f"Experiment failed: {error}\n")
    finally:
        faulthandler.cancel_dump_traceback_later()


if __name__ == "__main__":
    main()
