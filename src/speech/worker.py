"""One-request, local-only subtitle alignment worker. Stdout is a JSON protocol."""

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

from alignment import find_anchors, fit_local, parse_vtt


class RequestError(Exception):
    pass


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


def run_process(arguments: list[str], timeout: int) -> str:
    result = subprocess.run(arguments, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=timeout,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        raise RequestError('Audio processing failed')
    return result.stdout


def align(request: dict) -> dict:
    request = validate(request)
    if Path(request['subtitlePath']).stat().st_size > 5_000_000:
        raise RequestError('Subtitle file exceeds size limit')
    cues = parse_vtt(Path(request['subtitlePath']).read_text(encoding='utf-8-sig'))
    metadata = json.loads(run_process([
        request['ffprobe'], '-v', 'error', '-protocol_whitelist', 'http,tcp',
        '-show_streams', '-of', 'json', request['mediaUrl']], 30))
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
            '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], 60)
        with wave.open(wav, 'rb') as recording:
            expected = request['duration'] * 16000
            if (recording.getframerate() != 16000 or recording.getnchannels() != 1
                    or recording.getsampwidth() != 2 or recording.getnframes() < expected - 4000):
                raise RequestError('Audio sample was incomplete')
            frames = recording.readframes(recording.getnframes())
            if len(frames) != recording.getnframes() * 2:
                raise RequestError('Audio sample was incomplete')
        os.environ['OMP_WAIT_POLICY'] = 'PASSIVE'
        os.environ['OMP_NUM_THREADS'] = '1'
        # Redirect any dependency diagnostics away from the one-line protocol.
        with contextlib.redirect_stdout(sys.stderr):
            from faster_whisper import WhisperModel
            model = WhisperModel(request['modelPath'], device='cpu', compute_type='int8',
                                 cpu_threads=1, num_workers=1, local_files_only=True)
            segments, _ = model.transcribe(wav, language='en', beam_size=1,
                                           temperature=0, word_timestamps=True,
                                           vad_filter=True, condition_on_previous_text=False)
            words = [dict(word=word.word, start=word.start + request['start'], probability=word.probability)
                     for segment in segments for word in (segment.words or [])]
        anchors = find_anchors(cues, words, 0, request['start'], request['duration'])
        return fit_local(anchors, cues)


def main() -> None:
    try:
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            raise RequestError('Request exceeds size limit')
        result = align(json.loads(raw))
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
