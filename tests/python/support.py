"""Shared scaffolding for the live input's tests."""

import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'src'))
sys.path.insert(0, str(Path(__file__).resolve().parent))


def _importable(name):
    import importlib.util
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


HAS_NUMPY = _importable('numpy')
HAS_LIBROSA = _importable('librosa')
HAS_SOUNDFILE = _importable('soundfile')
HAS_AUDIO = HAS_NUMPY and HAS_LIBROSA and HAS_SOUNDFILE

needs_numpy = unittest.skipUnless(HAS_NUMPY, 'numpy is not installed')
needs_audio = unittest.skipUnless(
    HAS_AUDIO, 'librosa/soundfile are not installed')
