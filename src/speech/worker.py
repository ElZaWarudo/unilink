"""Local subtitle worker; --serve keeps one model loaded between requests."""

import contextlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit
import wave
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

from alignment import find_anchors, fit_local, parse_vtt


class RequestError(Exception):
    pass


class Cancelled(Exception):
    pass


def check_cancel(cancel):
    if cancel is not None and cancel.is_set():
        raise Cancelled()


def load_model(path):
    from faster_whisper import WhisperModel
    return WhisperModel(path, device='cpu', compute_type='int8',
                        cpu_threads=1, num_workers=1, local_files_only=True)


class SpeechEngine:
    def __init__(self, loader=load_model):
        self.loader = loader
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.lock = threading.Lock()
        self.recognition_lock = threading.Lock()
        self.future = None
        self.model_path = None

    def prepare_model(self, path):
        with self.lock:
            if self.model_path is not None and self.model_path != path:
                raise RequestError('Speech model changed; restart the worker')
            if self.future is None or (self.future.done() and self.future.exception()):
                self.model_path = path
                self.future = self.pool.submit(self.loader, path)
            return self.future

    def acquire_recognition(self, cancel):
        while True:
            check_cancel(cancel)
            if self.recognition_lock.acquire(timeout=.1):
                return

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.pool.shutdown(wait=True, cancel_futures=True)


def number(value: object, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RequestError('Invalid time range')
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise RequestError('Invalid time range')
    return float(value)


def validate(request: dict) -> dict:
    if not isinstance(request, dict):
        raise RequestError('Invalid request')
    url = urlsplit(request.get('mediaUrl', ''))
    query = parse_qs(url.query, strict_parsing=True)
    if (url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1')
            or not url.port or url.path != '/media' or url.username or url.password
            or url.fragment or set(query) != {'instance', 'version'}
            or any(len(value) != 1 or not value[0] for value in query.values())):
        raise RequestError('Invalid local media source')
    index = request.get('audioIndex')
    if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index <= 255:
        raise RequestError('Invalid audio track')
    request['start'] = number(request.get('start'), 0, 1_000_000)
    request['duration'] = number(request.get('duration'), 30, 120)
    for name in ('ffmpeg', 'ffprobe', 'subtitlePath'):
        value = request.get(name)
        if not isinstance(value, str) or not Path(value).is_absolute() or not Path(value).is_file():
            raise RequestError('Required local file is unavailable')
    model = request.get('modelPath')
    if not isinstance(model, str) or not Path(model).is_absolute() or not Path(model).is_dir():
        raise RequestError('Local speech model is unavailable')
    if not (Path(model) / 'model.bin').is_file():
        raise RequestError('Local speech model is unavailable')
    return request


def run_process(arguments: list[str], timeout: int, cancel=None) -> str:
    check_cancel(cancel)
    with subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True,
                          creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0) as child:
        deadline = time.monotonic() + timeout
        try:
            while True:
                check_cancel(cancel)
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(arguments, timeout)
                try:
                    output, _ = child.communicate(timeout=.1)
                    if child.returncode:
                        raise RequestError('Audio processing failed')
                    return output
                except subprocess.TimeoutExpired:
                    continue
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()


def align(request: dict, engine=None, cancel=None, progress=lambda _stage: None) -> dict:
    if engine is None:
        with SpeechEngine() as owned:
            return align(request, owned, cancel, progress)
    begun = time.monotonic()
    check_cancel(cancel)
    request = validate(request)
    if Path(request['subtitlePath']).stat().st_size > 5_000_000:
        raise RequestError('Subtitle file exceeds size limit')
    cues = parse_vtt(Path(request['subtitlePath']).read_text(encoding='utf-8-sig'))
    future = engine.prepare_model(request['modelPath'])
    warm = future.done() and future.exception() is None
    progress('extracting')
    metadata = json.loads(run_process([
        request['ffprobe'], '-v', 'error', '-protocol_whitelist', 'http,tcp',
        '-show_streams', '-of', 'json', request['mediaUrl']], 30, cancel))
    audio = [stream for stream in metadata.get('streams', []) if stream.get('codec_type') == 'audio']
    if request['audioIndex'] >= len(audio):
        raise RequestError('Selected audio track is unavailable')
    language = str(audio[request['audioIndex']].get('tags', {}).get('language', '')).lower().strip()
    if language not in ('', 'und', 'en', 'eng'):
        return dict(state='insufficient', reason='Selected audio track is not English')
    # Keep extraction under the parent's job directory so hard cancellation
    # still lets the parent remove audio when Python's finally cannot run.
    with tempfile.TemporaryDirectory(prefix='unilink-speech-',
                                     dir=Path(request['subtitlePath']).parent) as temporary:
        wav = str(Path(temporary) / 'sample.wav')
        run_process([
            request['ffmpeg'], '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'http,tcp',
            '-ss', str(request['start']), '-i', request['mediaUrl'],
            '-t', str(request['duration']), '-map', f"0:a:{request['audioIndex']}",
            '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], 60, cancel)
        with wave.open(wav, 'rb') as recording:
            expected = request['duration'] * 16000
            if (recording.getframerate() != 16000 or recording.getnchannels() != 1
                    or recording.getsampwidth() != 2 or recording.getnframes() < expected - 4000):
                raise RequestError('Audio sample was incomplete')
            frames = recording.readframes(recording.getnframes())
            if len(frames) != recording.getnframes() * 2:
                raise RequestError('Audio sample was incomplete')
        prepared = time.monotonic()
        progress('loading_model' if not future.done() else 'queued')
        while True:
            check_cancel(cancel)
            try:
                model = future.result(timeout=.1)
                break
            except FutureTimeout:
                if future.done():
                    raise
                continue
        progress('queued')
        engine.acquire_recognition(cancel)
        recognition_started = time.monotonic()
        try:
            check_cancel(cancel)
            progress('recognizing')
            segments, _ = model.transcribe(wav, language='en', beam_size=1,
                                           temperature=0, word_timestamps=True,
                                           vad_filter=True, condition_on_previous_text=False)
            words = []
            for segment in segments:
                check_cancel(cancel)
                words.extend(dict(word=word.word, start=word.start + request['start'], probability=word.probability)
                             for word in (segment.words or []))
        finally:
            engine.recognition_lock.release()
        check_cancel(cancel)
        progress('matching')
        anchors = find_anchors(cues, words, 0, request['start'], request['duration'])
        result = fit_local(anchors, cues)
        result['metrics'] = dict(modelWarm=warm, prepareMs=round((prepared-begun)*1000),
                                waitMs=round((recognition_started-prepared)*1000),
                                recognitionMs=round((time.monotonic()-recognition_started)*1000))
        return result


def outcome(request, engine=None, cancel=None, progress=lambda _stage: None):
    try:
        return align(request, engine, cancel, progress)
    except Cancelled:
        return dict(state='cancelled')
    except RequestError as error:
        return dict(state='error', reason=str(error))
    except subprocess.TimeoutExpired:
        return dict(state='error', reason='Audio processing timed out')
    except ImportError:
        return dict(state='error', reason='Local speech dependencies are unavailable')
    except Exception:
        return dict(state='error', reason='Local speech alignment failed')


def serve(stream, output):
    lock = threading.Lock()
    jobs = {}
    def send(value):
        with lock:
            output.write(json.dumps(value, allow_nan=False) + '\n')
            output.flush()
    with SpeechEngine() as engine, ThreadPoolExecutor(max_workers=2) as pool:
        def work(identifier, request, cancel):
            result = outcome(request, engine, cancel,
                             lambda stage: send(dict(id=identifier, type='progress', stage=stage)))
            with lock:
                jobs.pop(identifier, None)
            send(dict(result, id=identifier, type='result'))
        try:
            while True:
                raw = stream.readline(32769)
                if not raw:
                    break
                if len(raw) > 32768 or not raw.endswith(b'\n'):
                    break
                try:
                    message = json.loads(raw)
                    identifier = message['id']
                    if not isinstance(identifier, str) or not 1 <= len(identifier) <= 100:
                        break
                    if message.get('type') == 'cancel':
                        with lock:
                            if identifier in jobs:
                                jobs[identifier].set()
                    elif message.get('type') == 'align':
                        with lock:
                            full = len(jobs) >= 2 or identifier in jobs
                            if not full:
                                cancel = threading.Event()
                                jobs[identifier] = cancel
                        if full:
                            send(dict(id=identifier, type='result', state='busy'))
                        else:
                            pool.submit(work, identifier, message['input'], cancel)
                    else:
                        break
                except (ValueError, KeyError, TypeError):
                    break
        finally:
            with lock:
                for cancel in jobs.values():
                    cancel.set()


def main() -> None:
    os.environ['OMP_WAIT_POLICY'] = 'PASSIVE'
    os.environ['OMP_NUM_THREADS'] = '1'
    protocol = sys.stdout
    if '--serve' in sys.argv:
        # Process-wide redirection: thread-local redirects race with each other.
        with contextlib.redirect_stdout(sys.stderr):
            # Initialize native dependency DLLs on the main thread before audio
            # subprocesses/readers start. Model construction still overlaps I/O.
            try:
                import faster_whisper
            except ImportError:
                pass  # Individual requests report the unavailable dependency.
            serve(sys.stdin.buffer, protocol)
        return
    try:
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            raise RequestError('Request exceeds size limit')
        with contextlib.redirect_stdout(sys.stderr):
            result = outcome(json.loads(raw))
    except RequestError as error:
        result = dict(state='error', reason=str(error))
    except subprocess.TimeoutExpired:
        result = dict(state='error', reason='Audio processing timed out')
    except ImportError:
        result = dict(state='error', reason='Local speech dependencies are unavailable')
    except Exception:
        result = dict(state='error', reason='Local speech alignment failed')
    print(json.dumps(result, allow_nan=False), flush=True)


if __name__ == '__main__':
    main()
