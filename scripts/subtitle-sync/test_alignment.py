"""Deterministic checks; no model, network, or media required."""

import unittest

from alignment import Cue, find_anchors, fit_timing, parse_vtt, tokens
from experiment import validate_sample_starts


class AlignmentTests(unittest.TestCase):
    def test_duplicate_and_overlapping_samples_are_rejected(self):
        for starts in ([100, 100, 300], [100, 130, 300]):
            with self.assertRaises(ValueError):
                validate_sample_starts(starts, 60, 1000)

    def test_independent_samples_are_ordered(self):
        self.assertEqual(validate_sample_starts([500, 100, 300], 60, 1000), [100, 300, 500])

    def test_vtt_markup_and_multiline_text(self):
        cues = parse_vtt("WEBVTT\n\nNOTE ignore me\n\n1\n00:01.000 --> 00:03.000 align:start\n<v Alice>Hello &amp; welcome\nback to class.</v>\n")
        self.assertEqual(cues[0].start, 1)
        self.assertEqual(tokens(cues[0].text), ["hello", "welcome", "back", "to", "class"])

    def test_unique_phrase_anchors_at_cue_start(self):
        cues = [Cue(10, 13, "Where are you going today?")]
        words = [{"word": word, "start": 13.4 + i * .3, "probability": .95}
                 for i, word in enumerate(tokens(cues[0].text))]
        anchors = find_anchors(cues, words, 0)
        self.assertEqual(len(anchors), 1)
        self.assertAlmostEqual(anchors[0]["audio"] - anchors[0]["subtitle"], 3.4)

    def test_repeated_phrase_is_ambiguous(self):
        cues = [Cue(10, 13, "Where are you going today?"), Cue(40, 43, "Where are you going today?")]
        words = [{"word": w, "start": 13 + i, "probability": .95}
                 for i, w in enumerate(tokens(cues[0].text))]
        self.assertEqual(find_anchors(cues, words, 0), [])

    def test_missing_first_word_does_not_create_false_start(self):
        cue = Cue(10, 13, "Tell me where you are going today")
        words = [{"word": w, "start": 13 + i, "probability": .95}
                 for i, w in enumerate(tokens(cue.text)[1:])]
        self.assertEqual(find_anchors([cue], words, 0), [])

    def anchors(self, scale=1, offset=3.4):
        return [{"subtitle": t + i * 5, "audio": scale * (t + i * 5) + offset,
                 "sample": sample, "cue": sample * 10 + i}
                for sample, t in enumerate([100, 1000, 2000]) for i in range(5)]

    def test_constant_delay(self):
        result = fit_timing(self.anchors())
        self.assertEqual(result["status"], "candidate")
        self.assertEqual(result["kind"], "offset")
        self.assertAlmostEqual(result["offset_seconds"], 3.4)

    def test_drift(self):
        result = fit_timing(self.anchors(scale=1.004, offset=-2))
        self.assertEqual(result["kind"], "affine")
        self.assertAlmostEqual(result["scale"], 1.004)
        self.assertAlmostEqual(result["offset_seconds"], -2)

    def test_outlier_does_not_move_the_fit(self):
        anchors = self.anchors()
        anchors[0]["audio"] += 20
        result = fit_timing(anchors)
        self.assertEqual(result["status"], "candidate")
        self.assertAlmostEqual(result["offset_seconds"], 3.4)

    def test_edit_jump_requires_review(self):
        anchors = self.anchors()
        for a in anchors:
            if a["sample"] == 2:
                a["audio"] += 8
        self.assertEqual(fit_timing(anchors)["status"], "needs_review")

    def test_one_section_is_not_whole_episode_evidence(self):
        self.assertEqual(fit_timing(self.anchors()[:5])["status"], "insufficient_evidence")

    def test_unrelated_speech(self):
        words = [{"word": w, "start": i, "probability": .99}
                 for i, w in enumerate("this is entirely different speech".split())]
        self.assertEqual(find_anchors([Cue(10, 15, "Where are you going today?")], words, 0), [])


if __name__ == "__main__":
    unittest.main()
