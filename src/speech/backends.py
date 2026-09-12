"""Interchangeable local recognizers; only reliable word starts leave this module."""

import json
import math
import os
from pathlib import Path
import queue
import subprocess
import threading
import time


class Cancelled(Exception):
    pass


class NativeCleanupError(RuntimeError):
    def __init__(self, model):
        super().__init__('Native worker exit is not confirmed')
        self.model = model


def check_cancel(cancel):
    if cancel is not None and cancel.is_set():
        raise Cancelled()


def tokens_to_words(tokens):
    words = []
    current = None
    for token in tokens:
        text, start, probability = token.get('text'), token.get('start'), token.get('probability')
        if not isinstance(text, str) or not text:
            continue
        if text[0].isspace():
            if current is not None:
                words.append(current)
            current = None
        lexical = any(character.isalnum() for character in text)
        valid = (not isinstance(start, bool) and isinstance(start, (int, float)) and math.isfinite(start) and start >= 0
                 and not isinstance(probability, bool) and isinstance(probability, (int, float))
                 and math.isfinite(probability) and 0 <= probability <= 1)
        if not valid:
            current = None
            continue
        if current is None:
            if lexical:
                current = dict(word=text.lstrip(), start=start, probability=probability)
        else:
            current['word'] += text
            if lexical:
                current['probability'] = min(current['probability'], probability)
    if current is not None:
        words.append(current)
    return words


class NativeModel:
    def __init__(self, executable, model):
        self.executable, self.path = executable, model
        self.child = None
        self.reader = None
        self.device = ''
        self._start()

    def _start(self, cancel=None):
        if not self.executable or not self.path or not Path(self.executable).is_file() or not Path(self.path).is_file():
            raise RuntimeError('Vulkan backend is not installed')
        messages = queue.Queue()
        self.messages = messages
        self.child = subprocess.Popen([self.executable, self.path], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      text=True, encoding='utf-8', bufsize=1,
                                      creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        child = self.child
        def read():
            try:
                for line in iter(lambda: child.stdout.readline(524289), ''):
                    if len(line) > 524288 or not line.endswith('\n'):
                        break
                    messages.put(line)
            finally:
                messages.put(None)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        try:
            ready = self._receive(cancel)
            if ready.get('state') != 'ready' or ready.get('backend') != 'vulkan':
                raise RuntimeError('Vulkan initialization failed')
            self.device = str(ready.get('device', ''))
        except Exception:
            self.close()
            raise

    def _receive(self, cancel):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            check_cancel(cancel)
            try:
                line = self.messages.get(timeout=.1)
            except queue.Empty:
                continue
            if line is None:
                raise RuntimeError('Vulkan worker stopped')
            result = json.loads(line)
            if not isinstance(result, dict):
                raise RuntimeError('Invalid Vulkan response')
            return result
        raise TimeoutError('Vulkan recognition timed out')

    def recognize(self, wav, cancel):
        check_cancel(cancel)
        try:
            if self.child is None:
                self._start(cancel)
            self.child.stdin.write(json.dumps(dict(path=wav)) + '\n')
            self.child.stdin.flush()
            result = self._receive(cancel)
            if result.get('state') != 'ready' or not isinstance(result.get('tokens'), list):
                raise RuntimeError('Vulkan recognition failed')
            return tokens_to_words(result['tokens'])
        except Exception:
            # Native DTW does not support cooperative abort everywhere. Kill only
            # this owned child, confirm exit, then allow a fresh model next time.
            self.close()
            raise

    def close(self):
        child = self.child
        if child is None:
            return
        try:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired) as error:
            # The exception retains ownership even when construction failed.
            raise NativeCleanupError(self) from error
        child.stdin.close()
        if self.reader is not None:
            self.reader.join(timeout=1)
        child.stdout.close()
        self.child = None


def load_faster_whisper(path, **options):
    from faster_whisper import WhisperModel
    return WhisperModel(path, **options)


class SpeechModel:
    def __init__(self, path, backend='cpu', native_executable=None, native_model=None,
                 loader=load_faster_whisper, native_factory=NativeModel):
        if backend not in ('cpu', 'cuda', 'vulkan'):
            raise ValueError('Invalid speech backend')
        self.path, self.loader = path, loader
        self.backend = backend
        self.fallback_reason = None
        self.model = None
        try:
            self.model = native_factory(native_executable, native_model) if backend == 'vulkan' else self._load(backend)
        except NativeCleanupError:
            raise
        except Exception:
            if backend == 'cpu':
                raise
            self._fallback(f'{backend}_unavailable')

    def _load(self, backend):
        return self.loader(self.path, device='cuda' if backend == 'cuda' else 'cpu',
                           compute_type='float16' if backend == 'cuda' else 'int8',
                           cpu_threads=1, num_workers=1, local_files_only=True)

    def _fallback(self, reason):
        if self.backend == 'vulkan' and self.model is not None:
            self.model.close()
        self.model = None
        self.backend = 'cpu'
        self.fallback_reason = reason
        self.model = self._load('cpu')

    def recognize(self, wav, cancel):
        check_cancel(cancel)
        try:
            if self.backend == 'vulkan':
                return self.model.recognize(wav, cancel)
            segments, _ = self.model.transcribe(wav, language='en', beam_size=1, temperature=0,
                                                word_timestamps=True, vad_filter=True,
                                                condition_on_previous_text=False)
            words = []
            for segment in segments:
                check_cancel(cancel)
                words.extend(dict(word=word.word, start=word.start, probability=word.probability)
                             for word in (segment.words or []))
            return words
        except (Cancelled, NativeCleanupError):
            raise
        except Exception:
            check_cancel(cancel)
            if self.backend == 'cpu':
                raise
            self._fallback(f'{self.backend}_failed')
            return self.recognize(wav, cancel)

    def close(self):
        if self.backend == 'vulkan' and self.model is not None:
            self.model.close()
