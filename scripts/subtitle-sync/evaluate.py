"""Recover known timing corruptions using a completed experiment's real ASR words."""

import argparse
from dataclasses import replace
import json
from pathlib import Path
import sys

from alignment import find_anchors, fit_timing, parse_vtt


def evaluate(directory: Path) -> dict:
    report = json.loads((directory / "report.json").read_text(encoding="utf-8"))
    cues = parse_vtt((directory / "source.vtt").read_text(encoding="utf-8"))
    baseline = report["timing"]
    if baseline["status"] != "candidate":
        return {"status": "inconclusive", "reason": "The unmodified subtitles did not yield a reliable baseline"}
    scenarios = []
    for name, scale, offset in [("five_seconds_late", 1, 5), ("four_seconds_early", 1, -4),
                                 ("progressive_drift", 1.004, 2)]:
        modified = [replace(cue, start=scale * cue.start + offset, end=scale * cue.end + offset) for cue in cues]
        anchors = [anchor for sample in report["samples"]
                   for anchor in find_anchors(modified, sample["words"], sample["index"])]
        result = fit_timing(anchors)
        expected_scale = baseline["scale"] / scale
        expected_offset = baseline["offset_seconds"] - expected_scale * offset
        # Compare recovered mappings over the measured range, rather than their
        # intercept alone (slope/intercept errors can cancel near the samples).
        maximum_error = None
        if "scale" in result:
            maximum_error = max(abs((result["scale"] - expected_scale) * t + result["offset_seconds"] - expected_offset)
                                for t in result["measured_subtitle_range"])
        scenarios.append({"name": name, "status": result["status"],
                          "max_recovery_error_seconds": maximum_error,
                          "passed": result["status"] == "candidate" and maximum_error <= .1})
    boundary = report["samples"][-1]["start"] - 30
    modified = [replace(cue, start=cue.start + (8 if cue.start >= boundary else 0),
                        end=cue.end + (8 if cue.start >= boundary else 0)) for cue in cues]
    anchors = [anchor for sample in report["samples"]
               for anchor in find_anchors(modified, sample["words"], sample["index"])]
    result = fit_timing(anchors)
    scenarios.append({"name": "eight_second_edit_jump", "status": result["status"],
                      "passed": result["status"] == "needs_review"})
    return {"status": "passed" if all(s["passed"] for s in scenarios) else "failed",
            "scope": "Recovery relative to ASR baseline; not a human-verified timing accuracy benchmark",
            "scenarios": scenarios}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    result = evaluate(args.directory)
    (args.directory / "recovery.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    sys.exit({"passed": 0, "failed": 1, "inconclusive": 2}[result["status"]])
