import threading
import unittest
import json
import subprocess
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import worker


class ServiceTests(unittest.TestCase):
    def test_failed_native_cleanup_retains_ownership_before_retry_and_shutdown(self):
        from unittest.mock import Mock
        native = Mock()
        failure = worker.NativeCleanupError(native)
        native.close.side_effect = [failure, None, failure, None]
        calls = []
        def load(*_args, **_kwargs):
            calls.append(True)
            raise failure
        with worker.SpeechEngine(loader=load) as engine:
            first = engine.prepare_model('/model')
            with self.assertRaises(worker.NativeCleanupError): first.result(timeout=5)
            with self.assertRaises(worker.NativeCleanupError): engine.prepare_model('/model')
            self.assertIs(engine.future, first)
            self.assertEqual(len(calls), 1)
            second = engine.prepare_model('/model')
            with self.assertRaises(worker.NativeCleanupError): second.result(timeout=5)
            self.assertEqual(len(calls), 2)
        self.assertEqual(native.close.call_count, 4)

    def test_backend_identity_requires_restart_and_closes_loaded_model(self):
        calls, closed = [], []
        class Model:
            def close(self): closed.append(True)
        def load(path, **options):
            calls.append((path, options))
            return Model()
        with worker.SpeechEngine(loader=load) as engine:
            first = engine.prepare_model('/model', backend='vulkan', native_model='/native')
            model = first.result(timeout=5)
            self.assertIs(engine.prepare_model('/model', native_model='/native', backend='vulkan').result(), model)
            for options in [dict(backend='cpu', native_model='/native'),
                            dict(backend='vulkan', native_model='/other')]:
                with self.assertRaisesRegex(worker.RequestError, 'restart'):
                    engine.prepare_model('/model', **options)
            self.assertEqual(len(calls), 1)
            self.assertEqual(closed, [])
        self.assertEqual(closed, [True])

    def test_model_is_loaded_once_and_reused(self):
        calls = []
        model = object()
        with worker.SpeechEngine(loader=lambda path: calls.append(path) or model) as engine:
            first = engine.prepare_model('/model')
            self.assertIs(first.result(timeout=2), model)
            self.assertIs(engine.prepare_model('/model').result(timeout=2), model)
            self.assertEqual(calls, ['/model'])

    def test_model_loading_can_overlap_audio_preparation(self):
        started, release = threading.Event(), threading.Event()
        def load(_path):
            started.set()
            self.assertTrue(release.wait(2))
            return object()
        with worker.SpeechEngine(loader=load) as engine:
            future = engine.prepare_model('/model')
            self.assertTrue(started.wait(1))
            self.assertFalse(future.done())
            release.set()
            self.assertIsNotNone(future.result(timeout=2))

    def test_recognition_is_serial_but_waiting_request_can_cancel(self):
        with worker.SpeechEngine(loader=lambda _: object()) as engine:
            cancelled = threading.Event()
            engine.recognition_lock.acquire()
            with ThreadPoolExecutor(max_workers=1) as jobs:
                task = jobs.submit(engine.acquire_recognition, cancelled)
                cancelled.set()
                with self.assertRaises(worker.Cancelled):
                    task.result(timeout=2)
            engine.recognition_lock.release()

    def test_failed_model_load_can_retry(self):
        attempts = []
        def load(_path):
            attempts.append(1)
            if len(attempts) == 1:
                raise ValueError('failed load')
            return 'model'
        with worker.SpeechEngine(loader=load) as engine:
            with self.assertRaises(ValueError):
                engine.prepare_model('/model').result(timeout=2)
            self.assertEqual(engine.prepare_model('/model').result(timeout=2), 'model')

    def test_service_protocol_handles_multiple_requests_and_eof(self):
        messages = ''.join(json.dumps(dict(type='align', id=str(i), input={})) + '\n' for i in range(2))
        result = subprocess.run([sys.executable, str(Path(worker.__file__)), '--serve'],
                                input=messages, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0)
        replies = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual({reply['id'] for reply in replies}, {'0', '1'})
        self.assertTrue(all(reply['type'] == 'result' and reply['state'] in ('error', 'cancelled') for reply in replies))


if __name__ == '__main__':
    unittest.main()
