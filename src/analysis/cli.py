"""Command line and worker entry points.

stdout carries only machine-readable output in every mode; a stray print corrupts the protocol.
"""

import json
import os
import sys

from .config import DEFAULT
from . import model_adapters, models, pipeline, tagger


def _log(message):
    print(f'[analyze] {message}', file=sys.stderr, flush=True)



def _claim_stdout():
    """Reserve a duplicate stdout descriptor for NDJSON replies; redirect FD 1 to stderr.
    This keeps native writes and competing model threads' redirect_stdout calls out
    of the reply stream. The returned stream owns the duplicate descriptor.
    """
    sys.stdout.flush()
    channel = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8', newline='\n')
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    return channel


def _encode_reply(response):
    """
    One reply line, always valid JSON.

    `json.dumps` writes NaN and Infinity as bare tokens by default, which no
    JSON parser accepts: the Node side would sit on the request until its
    timeout. Anything non-finite that got past the document's own clean-up is
    turned into null here, and if even that fails the reply becomes an error
    rather than an unreadable line.
    """
    from .pipeline import json_safe
    try:
        return json.dumps(json_safe(response), allow_nan=False)
    except (TypeError, ValueError) as exc:
        return json.dumps({'id': response.get('id'),
                           'error': f'result could not be encoded: {exc}'})


def watch_parent():
    """
    Exit when the parent process goes away.

    stdin EOF is the normal shutdown path; this is the safety net for the case
    where the server is SIGKILLed or the terminal is closed, which would
    otherwise leave a worker holding a PyTorch model resident forever.
    """
    import threading
    import time

    parent = os.getppid()

    def watcher():
        if os.name == 'nt':
            import ctypes
            kernel32 = ctypes.windll.kernel32
            SYNCHRONIZE = 0x00100000
            WAIT_TIMEOUT = 258
            handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent)
            if not handle:
                os._exit(0)
            try:
                while kernel32.WaitForSingleObject(handle, 2000) == WAIT_TIMEOUT:
                    pass
            finally:
                kernel32.CloseHandle(handle)
        else:
            while True:
                try:
                    os.kill(parent, 0)
                except (ProcessLookupError, PermissionError):
                    break
                time.sleep(2)
        os._exit(0)

    threading.Thread(target=watcher, daemon=True).start()


def worker_loop(out=None):
    """
    Persistent NDJSON worker, answering on `out` (stdout, claimed by main).

    Request:  {"id": <any>, "source": "<path>", "targetDurationSec": <num|null>}
    Response: {"id": <same>, "result": {...}} or {"id": <same>, "error": "..."}

    One request at a time, in order. The analysis already saturates the CPU
    across BLAS and the thread pools inside it, so serving two at once would
    make both slower and neither would finish first.
    """
    out = out or sys.stdout
    watch_parent()
    _warm_up()
    print('[analyzer] worker ready', file=sys.stderr, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get('id')
            source = request.get('source')
            target = request.get('targetDurationSec')
            if not source:
                response = {'id': request_id, 'error': 'missing source'}
            elif not os.path.isfile(source):
                response = {'id': request_id, 'error': f'File not found: {source}'}
            else:
                response = {'id': request_id,
                            'result': pipeline.analyze(source, target)}
        except Exception as exc:
            import traceback
            traceback.print_exc(file=sys.stderr)
            response = {'id': request_id, 'error': str(exc)}
        if models.gpu_fault():
            # A faulted GPU FFT stays broken for the process; ask for a fresh worker.
            response['recycle'] = True
        out.write(_encode_reply(response) + '\n')
        out.flush()


def _warm_up():
    """
    Pay the import and model-load costs before the first request arrives.

    librosa and numba in particular JIT on first use; without this the first
    track of the night is several seconds slower than every one after it, and
    that is exactly the track someone is standing there waiting for.

    Then the models, the beat model first: the docs always said the worker
    loaded them at start, and it never did — the first track loaded them
    itself, on the clock. The optional ones follow, from disk only.
    """
    try:
        import numpy as np
        import librosa
        silence = np.zeros(4096, dtype=np.float32)
        librosa.stft(silence, n_fft=1024, hop_length=256)
        librosa.onset.onset_strength(y=silence, sr=22050)
    except Exception as exc:
        _log(f'warm-up skipped: {exc}')
    try:
        loaded = models.warm_up()
        _log(f'models ready: {", ".join(loaded) or "none"} on {models.device()}'
             f'{", in RAM between passes" if models.offloading() else ""}')
    except Exception as exc:
        _log(f'model warm-up skipped: {exc}')
    if DEFAULT.enable_semantics:
        try:
            model_adapters.preload()
        except Exception as exc:
            _log(f'MuQ preload skipped: {exc}')
    if DEFAULT.enable_tagger:
        try:
            tagger.preload()
        except Exception as exc:
            _log(f'tagger preload skipped: {exc}')



def analyse_once(path, target_duration=None, report_path=None):
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    document = pipeline.analyze(path, target_duration)
    if report_path:
        write_report(document, path, report_path)
    return document


def write_report(document, audio_path, report_path):
    from . import report as report_mod
    peaks = None
    try:
        import librosa
        samples, _ = librosa.load(audio_path, sr=8000, mono=True)
        peaks = report_mod.waveform_peaks(samples)
    except Exception as exc:
        _log(f'waveform unavailable for the report: {exc}')
    html = report_mod.analysis_to_html(
        document, title=os.path.basename(audio_path), waveform=peaks)
    with open(report_path, 'w', encoding='utf-8') as handle:
        handle.write(html)
    _log(f'report written to {report_path}')



USAGE = """usage:
  analyze.py <file> [--target-duration SEC] [--report OUT.html] [--out OUT.json]
  analyze.py --worker"""


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)

    if '--worker' in argv:
        worker_loop(_claim_stdout())
        return 0

    target_duration, report_path, out_path = None, None, None
    positional = []
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == '--target-duration' and index + 1 < len(argv):
            try:
                target_duration = float(argv[index + 1])
            except ValueError:
                json.dump({'error': f'Invalid --target-duration: {argv[index + 1]}'},
                          sys.stdout)
                return 1
            index += 2
            continue
        if argument == '--report' and index + 1 < len(argv):
            report_path = argv[index + 1]
            index += 2
            continue
        if argument == '--out' and index + 1 < len(argv):
            out_path = argv[index + 1]
            index += 2
            continue
        positional.append(argument)
        index += 1

    if not positional:
        json.dump({'error': USAGE}, sys.stdout)
        return 1

    out = _claim_stdout()
    try:
        document = analyse_once(positional[0], target_duration, report_path)
    except Exception as exc:
        json.dump({'error': str(exc)}, out)
        out.flush()
        return 1

    if out_path:
        with open(out_path, 'w', encoding='utf-8') as handle:
            json.dump(document, handle)
        _log(f'analysis written to {out_path}')
    else:
        json.dump(document, out)
    out.flush()
    return 0
