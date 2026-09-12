import threading
import unittest
import sys
import tempfile
import time
import subprocess
from unittest.mock import patch, MagicMock
from pathlib import Path
from types import SimpleNamespace

from backends import Cancelled, NativeModel, SpeechModel, tokens_to_words


class BackendTests(unittest.TestCase):
    def test_cuda_deferred_failure_discards_partial_words_and_reuses_cpu(self):
        loads = []
        def transcribe_gpu(*_args, **_kwargs):
            def segments():
                yield SimpleNamespace(words=[SimpleNamespace(word=' discarded', start=1, probability=.9)])
                raise RuntimeError('CUDA failed while decoding')
            return segments(), None
        def load(_path, **options):
            loads.append(options)
            return SimpleNamespace(transcribe=transcribe_gpu if options['device'] == 'cuda' else
                lambda *_args, **_kwargs: ([SimpleNamespace(words=[SimpleNamespace(
                    word=' cpu', start=2, probability=.8)])], None))
        model = SpeechModel('/model', backend='cuda', loader=load)
        expected = [dict(word=' cpu', start=2, probability=.8)]
        self.assertEqual(model.recognize('sample.wav', threading.Event()), expected)
        self.assertEqual(model.recognize('sample.wav', threading.Event()), expected)
        self.assertEqual([(entry['device'], entry['compute_type']) for entry in loads],
                         [('cuda', 'float16'), ('cpu', 'int8')])
        self.assertEqual(model.fallback_reason, 'cuda_failed')

    def test_cancellation_during_cuda_decode_does_not_load_cpu(self):
        cancel = threading.Event()
        loads = []
        def transcribe(*_args, **_kwargs):
            def segments():
                cancel.set()
                raise RuntimeError('interrupted GPU')
                yield
            return segments(), None
        def load(_path, **options):
            loads.append(options['device'])
            return SimpleNamespace(transcribe=transcribe)
        model = SpeechModel('/model', backend='cuda', loader=load)
        with self.assertRaises(Cancelled):
            model.recognize('sample.wav', cancel)
        self.assertEqual(loads, ['cuda'])
        self.assertIsNone(model.fallback_reason)

    def test_cpu_failure_is_not_retried_as_fallback(self):
        loads = []
        def transcribe(*_args, **_kwargs): raise RuntimeError('CPU failed')
        def load(_path, **options):
            loads.append(options['device'])
            return SimpleNamespace(transcribe=transcribe)
        model = SpeechModel('/model', loader=load)
        with self.assertRaisesRegex(RuntimeError, 'CPU failed'):
            model.recognize('sample.wav', threading.Event())
        self.assertEqual(loads, ['cpu'])

    def test_bpe_pieces_become_words_with_one_start_and_conservative_confidence(self):
        tokens = [dict(text=text, start=start, probability=probability) for text, start, probability in [
            (' Rec', 1, .95), ('ogn', 1.1, .8), ('izing', 1.2, .9),
            (' isn', 2, .9), ("'t", 2.1, .7), (' hard', 3, .99), ('.', 3.2, .2)]]
        self.assertEqual(tokens_to_words(tokens), [
            dict(word='Recognizing', start=1, probability=.8),
            dict(word="isn't", start=2, probability=.7),
            dict(word='hard.', start=3, probability=.99)])

    def test_invalid_timestamps_and_confidence_cannot_form_matching_words(self):
        self.assertEqual(tokens_to_words([
            dict(text=' wrong', start=-1, probability=.99),
            dict(text=' invalid', start=2, probability=float('nan'))]), [])

    def test_cuda_load_failure_falls_back_once_and_reuses_cpu(self):
        loads = []
        def load(path, device, compute_type, **kwargs):
            loads.append(device)
            if device == 'cuda':
                raise RuntimeError('CUDA is absent')
            return SimpleNamespace(transcribe=lambda *_args, **_kwargs: ([SimpleNamespace(
                words=[SimpleNamespace(word=' hello', start=.5, probability=.9)])], None))
        model = SpeechModel('/model', backend='cuda', loader=load)
        self.assertEqual(model.recognize('sample.wav', threading.Event())[0]['word'], ' hello')
        model.recognize('sample.wav', threading.Event())
        self.assertEqual(loads, ['cuda', 'cpu'])
        self.assertEqual(model.backend, 'cpu')
        self.assertEqual(model.fallback_reason, 'cuda_unavailable')
        model.close()

    def test_vulkan_failure_falls_back_but_cancellation_never_does(self):
        class Native:
            def __init__(self, *_args): self.closed = False
            def recognize(self, _path, cancel):
                if cancel.is_set(): raise Cancelled()
                raise RuntimeError('GPU failed')
            def close(self): self.closed = True
        loads = []
        def load(*_args, **kwargs):
            loads.append(kwargs['device'])
            return SimpleNamespace(transcribe=lambda *_args, **_kwargs: ([], None))
        model = SpeechModel('/model', backend='vulkan', native_factory=Native, loader=load)
        native = model.model
        cancelled = threading.Event(); cancelled.set()
        with self.assertRaises(Cancelled): model.recognize('sample.wav', cancelled)
        self.assertEqual(loads, [])
        self.assertEqual(model.recognize('sample.wav', threading.Event()), [])
        self.assertTrue(native.closed)
        self.assertEqual(loads, ['cpu'])
        self.assertEqual(model.fallback_reason, 'vulkan_failed')
        model.close()


class NativeProtocolTests(unittest.TestCase):
    def test_failed_startup_cleanup_preserves_child_and_blocks_cpu_fallback(self):
        child = MagicMock()
        child.stdout.readline.return_value = ''
        child.poll.return_value = None
        child.wait.side_effect = [subprocess.TimeoutExpired('native', 5), None]
        loader = MagicMock()
        with patch('backends.subprocess.Popen', return_value=child):
            with self.assertRaises(Exception) as caught:
                SpeechModel('/model', backend='vulkan', native_executable=sys.executable,
                            native_model=sys.executable, loader=loader)
        loader.assert_not_called()
        self.assertIs(caught.exception.model.child, child)
        caught.exception.model.close()
        self.assertIsNone(caught.exception.model.child)

    def test_cancel_during_reload_does_not_wait_for_native_readiness(self):
        with tempfile.TemporaryDirectory() as temporary:
            script = Path(temporary) / 'reload.py'
            script.write_text('''import json, sys, time
from pathlib import Path
marker = Path(__file__).with_suffix('.count')
count = int(marker.read_text()) if marker.exists() else 0
marker.write_text(str(count + 1))
if count == 1: time.sleep(5)
print(json.dumps(dict(state='ready', backend='vulkan')), flush=True)
for line in sys.stdin:
    print(json.dumps(dict(state='ready', tokens=[])), flush=True)
''', encoding='utf-8')
            model = NativeModel(sys.executable, str(script))
            model.close()
            cancel = threading.Event()
            timer = threading.Timer(.3, cancel.set)
            started = time.monotonic()
            timer.start()
            try:
                with self.assertRaises(Cancelled): model.recognize('sample', cancel)
                self.assertLess(time.monotonic() - started, 2)
                self.assertIsNone(model.child)
                self.assertEqual(model.recognize('next', threading.Event()), [])
            finally:
                timer.cancel()
                timer.join()
                model.close()

    def test_private_worker_is_warm_then_killed_on_cancel_and_restarted(self):
        with tempfile.TemporaryDirectory() as temporary:
            script = Path(temporary) / 'fake_native.py'
            script.write_text('''import json, sys, time
print(json.dumps(dict(state='ready', backend='vulkan', device='test GPU')), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    if request['path'] == 'hang':
        time.sleep(30)
    print(json.dumps(dict(state='ready', tokens=[dict(text=' hello', start=.5, probability=.9)])), flush=True)
''', encoding='utf-8')
            model = NativeModel(sys.executable, str(script))
            try:
                first = model.child
                expected = [dict(word='hello', start=.5, probability=.9)]
                self.assertEqual(model.recognize('first', threading.Event()), expected)
                self.assertEqual(model.recognize('second', threading.Event()), expected)
                self.assertIs(model.child, first)
                cancel = threading.Event()
                timer = threading.Timer(.2, cancel.set)
                timer.start()
                try:
                    with self.assertRaises(Cancelled): model.recognize('hang', cancel)
                finally:
                    timer.cancel()
                    timer.join()
                self.assertIsNotNone(first.poll())
                self.assertTrue(first.stdin.closed)
                self.assertTrue(first.stdout.closed)
                self.assertIsNone(model.child)
                self.assertEqual(model.recognize('third', threading.Event()), expected)
                self.assertIsNot(model.child, first)
                final = model.child
            finally:
                model.close()
            self.assertIsNotNone(final.poll())
            self.assertFalse(model.reader.is_alive())

    def test_private_worker_eof_and_invalid_response_close_owned_child(self):
        for response in ('', '[]', '{broken', '{"state":"error"}'):
            with self.subTest(response=response), tempfile.TemporaryDirectory() as temporary:
                script = Path(temporary) / 'fake_native.py'
                script.write_text("import sys\nprint('{\"state\":\"ready\",\"backend\":\"vulkan\"}', flush=True)\nsys.stdin.readline()\n"
                                  + (f'print({response!r}, flush=True)\n' if response else ''), encoding='utf-8')
                model = NativeModel(sys.executable, str(script))
                child = model.child
                try:
                    with self.assertRaises((RuntimeError, ValueError)):
                        model.recognize('sample', threading.Event())
                    self.assertIsNotNone(child.poll())
                    self.assertIsNone(model.child)
                    self.assertFalse(model.reader.is_alive())
                finally:
                    model.close()


if __name__ == '__main__':
    unittest.main()
