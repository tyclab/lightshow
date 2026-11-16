"""Small numeric primitives the live input's tempo estimate and streaming analyser share."""

import numpy as np


def autocorrelation(x, max_lag=None):
    """Normalised autocorrelation of a mean-removed signal, lags 0..max_lag."""
    x = np.asarray(x, dtype=float)
    if x.size < 2:
        return np.zeros(1)
    x = x - float(np.mean(x))
    n = x.size
    max_lag = int(max_lag if max_lag is not None else n - 1)
    max_lag = max(1, min(max_lag, n - 1))
    size = 1 << int(np.ceil(np.log2(2 * n)))
    spec = np.fft.rfft(x, size)
    ac = np.fft.irfft(spec * np.conj(spec), size)[: max_lag + 1]
    if ac[0] > 1e-12:
        ac = ac / ac[0]
    return np.real(ac)


def clamp01(v):
    if not np.isfinite(v):
        return 0.0
    return float(min(1.0, max(0.0, v)))
