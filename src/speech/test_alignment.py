import unittest
import json
from pathlib import Path
import subprocess
import sys

from worker import RequestError, validate

from alignment import Cue, find_anchors, fit_local, parse_vtt


def anchors(offsets):
    return [dict(cue=i, subtitle=100 + i * 5, audio=100 + i * 5 + offset, sample=0)
            for i, offset in enumerate(offsets)]


class AlignmentTests(unittest.TestCase):
    def test_constant_offsets_and_bounded_range(self):
        for offset in (1.5, -2.5):
            cues = [Cue(100 + i * 5, 103 + i * 5, 'text') for i in range(8)]
            result = fit_local(anchors([offset] * 8), cues)
            self.assertEqual(result['state'], 'ready')
            self.assertEqual(result['result']['offset'], offset)
            self.assertEqual(result['result']['start'], 100)
            self.assertEqual(result['result']['end'], 138)

    def test_small_local_drift(self):
        self.assertEqual(fit_local(anchors([1 + i * .04 for i in range(8)]))['state'], 'ready')

    def test_insufficient(self):
        for data in ([], anchors([1] * 5), anchors([31] * 8)):
            self.assertEqual(fit_local(data)['state'], 'insufficient')
        data = anchors([1] * 8)
        for item in data:
            item['subtitle'] /= 10
            item['audio'] = item['subtitle'] + 1
        self.assertEqual(fit_local(data)['state'], 'insufficient')

    def test_minority_outliers(self):
        result = fit_local(anchors([1, 1, 1, 8, 1, 1, 1, 1]))
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(result['result']['anchors'], 7)

    def test_step_and_multimodal_rejected(self):
        for offsets in ([1] * 4 + [2] * 4, [1, 2] * 4, [1] * 5 + [3] * 3):
            self.assertEqual(fit_local(anchors(offsets))['state'], 'insufficient')

    def test_missing_start_unrelated_repeated(self):
        cue = Cue(10, 14, 'Where are you going today')
        def words(text):
            return [dict(word=w, start=11 + i * .2, probability=.95) for i, w in enumerate(text.split())]
        self.assertEqual(find_anchors([cue], words('are you going today'), 0), [])
        self.assertEqual(find_anchors([cue], words('some wholly unrelated spoken sentence'), 0), [])
        self.assertEqual(find_anchors([cue, Cue(20, 24, cue.text)], words(cue.text), 0), [])
        self.assertEqual(len(find_anchors([cue], words(cue.text), 0)), 1)

    def test_uncertain_prefix_and_distant_match(self):
        for text in ('[sighs] Where are you going', 'JOHN: Where are you going', '♪ Where are you going'):
            words = [dict(word=w, start=11+i*.2, probability=.95) for i,w in enumerate('Where are you going'.split())]
            self.assertEqual(find_anchors([Cue(10, 14, text)], words, 0), [])
        self.assertEqual(find_anchors([Cue(100, 104, 'Where are you going')], words, 0, start=0, duration=30), [])

    def test_vtt(self):
        self.assertEqual(parse_vtt('WEBVTT\n\n00:01.000 --> 00:03.000\nHello there\n')[0].end, 3)

    def test_worker_rejects_remote_unversioned_and_other_paths(self):
        for url in ('https://example.com/media?instance=x&version=1',
                    'http://127.0.0.1:11470/media',
                    'http://127.0.0.1:11470/other?instance=x&version=1',
                    'http://user:password@127.0.0.1:11470/media?instance=x&version=1'):
            with self.assertRaises(RequestError):
                validate(dict(mediaUrl=url))

    def test_worker_errors_are_single_json_without_input(self):
        for raw in ('{"privateSecret": "never print me"}', 'x' * 32769):
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('worker.py'))],
                                    input=raw, text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(len(result.stdout.splitlines()), 1)
            self.assertEqual(json.loads(result.stdout)['state'], 'error')
            self.assertNotIn('never print me', result.stdout)


if __name__ == '__main__':
    unittest.main()
