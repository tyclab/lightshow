"""The live input's tempo estimate: onset autocorrelation weighted by a tempo prior (realtime.py)."""

import numpy as np

from . import dsp
from .config import RhythmConfig


def tempo_prior(bpms, centre, std):
    """
    Log-normal weight over candidate tempi. Perceived tempo clusters around
    120 BPM on a log scale; this is the weighting Klapuri and later librosa use
    to break the octave tie in favour of what a listener would tap.
    """
    bpms = np.asarray(bpms, dtype=float)
    weights = np.zeros_like(bpms)
    valid = bpms > 0
    weights[valid] = np.exp(
        -0.5 * ((np.log2(bpms[valid]) - np.log2(centre)) / std) ** 2)
    return weights


def pulse_score(onset_envelope, lag_frames, window=1, pulses_per_window=12):
    """Return (score, phase_frames) for pulses spaced lag_frames apart.
    Score is precision (mean onset energy at pulses / overall mean) times recall
    (share of total onset energy near a pulse); recall rejects half-tempo matches.
    Rephase in short windows so fractional-frame lag error does not accumulate.
    """
    env = np.asarray(onset_envelope, dtype=float)
    n = env.size
    if n < 8 or lag_frames <= 1:
        return 0.0, 0.0
    overall = float(np.mean(env))
    if overall <= 1e-9:
        return 0.0, 0.0

    step = float(lag_frames)
    span = max(8, int(round(step * pulses_per_window)))
    offsets = np.arange(-window, window + 1)

    scores, first_phase = [], 0.0
    for start in range(0, n, span):
        stop = min(n, start + span)
        segment = env[start:stop]
        if segment.size < step * 4:
            break
        seg_mean = float(np.mean(segment))
        seg_total = float(np.sum(segment))
        if seg_mean <= 1e-9 or seg_total <= 1e-9:
            continue
        count = int((segment.size - 1) // step) + 1
        best = (0.0, 0.0)
        for phase in range(max(1, int(round(step)))):
            centres = np.round(phase + np.arange(count) * step).astype(int)
            centres = centres[(centres >= 0) & (centres < segment.size)]
            if centres.size < 3:
                continue
            precision = float(np.mean(segment[centres])) / seg_mean
            covered = np.unique(np.clip(centres[:, None] + offsets[None, :],
                                        0, segment.size - 1))
            recall = float(np.sum(segment[covered])) / seg_total
            value = precision * recall
            if value > best[0]:
                best = (value, float(phase))
        if best[0] > 0:
            scores.append(best[0])
            if not scores[:-1]:
                first_phase = best[1]

    if not scores:
        return 0.0, 0.0
    return float(np.mean(scores)), first_phase


def estimate_tempo(onset_envelope, sr, hop_length, config: RhythmConfig):
    """Return (bpm, confidence) from onset autocorrelation, prior and pulse-fit ranking.
    Used for live rolling windows; offline analysis uses the beat model.
    The live caller folds octave flips onto its running tempo.
    """
    env = np.asarray(onset_envelope, dtype=float)
    if env.size < 16:
        return config.tempo_prior_bpm, 0.0

    frame_rate = sr / float(hop_length)
    max_lag = int(frame_rate * 60.0 / max(1.0, config.tempo_min * 0.5))
    ac = dsp.autocorrelation(env, max_lag=min(max_lag, env.size - 1))
    lags = np.arange(ac.size)
    with np.errstate(divide='ignore'):
        bpms = np.where(lags > 0, 60.0 * frame_rate / np.maximum(lags, 1), 0.0)

    in_range = (bpms >= config.tempo_min) & (bpms <= config.tempo_max)
    if not np.any(in_range):
        return config.tempo_prior_bpm, 0.0

    score = np.zeros_like(ac)
    score[in_range] = np.maximum(ac[in_range], 0.0) * tempo_prior(
        bpms[in_range], config.tempo_prior_bpm, config.tempo_prior_std)

    reinforced = score.copy()
    for multiple in (2, 3, 4):
        idx = lags * multiple
        valid = idx < ac.size
        reinforced[valid] += 0.5 / multiple * np.maximum(ac[idx[valid]], 0.0) * \
            (score[valid] > 0)

    if not np.any(reinforced > 0):
        return config.tempo_prior_bpm, 0.0

    candidates = np.argsort(reinforced)[::-1][:10]
    candidates = [int(c) for c in candidates if reinforced[c] > 0 and c > 0]
    if not candidates:
        return config.tempo_prior_bpm, 0.0

    ranked = []
    for lag_idx in candidates:
        lag = _refine_peak(reinforced, lag_idx)
        if lag <= 0:
            continue
        bpm = 60.0 * frame_rate / lag
        if not (config.tempo_min <= bpm <= config.tempo_max):
            continue
        fit, _phase = pulse_score(env, lag)
        prior = float(tempo_prior([bpm], config.tempo_prior_bpm,
                                  config.tempo_prior_std)[0])
        ranked.append((fit * prior + 0.25 * float(reinforced[lag_idx]), bpm, fit))

    if not ranked:
        return config.tempo_prior_bpm, 0.0

    ranked.sort(reverse=True)
    top_score, bpm, fit = ranked[0]
    runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
    margin = (top_score - runner_up) / (top_score + 1e-9)
    confidence = dsp.clamp01(0.5 * margin + 0.5 * dsp.clamp01((fit - 1.0) / 1.5))

    return float(bpm), float(confidence)


def _refine_peak(values, index):
    """Sub-sample peak position by fitting a parabola to the three points
    around `index`. Returns the interpolated index."""
    if index <= 0 or index >= len(values) - 1:
        return float(index)
    y0, y1, y2 = float(values[index - 1]), float(values[index]), float(values[index + 1])
    denom = y0 - 2.0 * y1 + y2
    if abs(denom) < 1e-12:
        return float(index)
    offset = 0.5 * (y0 - y2) / denom
    if not np.isfinite(offset) or abs(offset) > 1.0:
        return float(index)
    return float(index) + offset
