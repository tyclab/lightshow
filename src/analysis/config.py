"""The live input's tuning constants: the bands it reports, its tempo estimate and its streaming analyser."""

from dataclasses import dataclass
from typing import Dict, Tuple


BANDS: Dict[str, Tuple[float, float]] = {
    'sub':      (20.0, 60.0),      # felt more than heard; 808s, sub drops
    'bass':     (60.0, 250.0),     # kick body, bass guitar, bass synth
    'lowmid':   (250.0, 500.0),    # warmth, low vocals, guitar body
    'mid':      (500.0, 2000.0),   # vocal fundamentals, most melody
    'presence': (2000.0, 5000.0),  # snare crack, vocal intelligibility
    'high':     (5000.0, 12000.0), # hats, cymbals, transient detail
    'air':      (12000.0, 20000.0) # shimmer, reverb tails, "expensive" top
}

BAND_ORDER = list(BANDS.keys())


@dataclass(frozen=True)
class RhythmConfig:
    tempo_min: float = 55.0
    tempo_max: float = 200.0
    tempo_prior_bpm: float = 120.0
    tempo_prior_std: float = 1.0


@dataclass(frozen=True)
class RealtimeConfig:
    sample_rate: int = 22050
    hop_length: int = 512
    # 46 ms at 22.05 kHz, under the ~80 ms where a lighting cue reads as late.
    n_fft: int = 1024
    history_sec: float = 10.0
    onset_k: float = 1.6
    tempo_refresh_sec: float = 2.0
    phase_refresh_sec: float = 0.5
    #: Onset history each re-fit reads, seconds: outvotes a syncopated bar, still follows a drifting tempo.
    phase_window_sec: float = 4.0
    phase_lock_strength: float = 0.5
    frequency_lock_strength: float = 0.012
    #: −80 dBFS: an idle sink's digital silence sits below it, the quietest music the show follows far above.
    quiet_rms: float = 1e-4
    #: Longer than any rest within a track, so music is never thinned out, yet short enough to idle soon after it stops.
    quiet_after_sec: float = 3.0
    #: A section is judged on its last two seconds, a bar at 120 BPM: the rise and fall inside a bar average out.
    section_recent_sec: float = 2.0
    #: How far those seconds must leave the passage before them, as a share of its level: 3.8 dB up, 6.9 dB down.
    section_step: float = 0.55
    #: Where a rise lands is read off its last half second, a beat at 120 BPM: one kick and the gap after it.
    landing_sec: float = 0.5
    #: The loudest level is forgotten after four minutes with nothing near it: a quieter track then sets its own.
    loud_memory_sec: float = 240.0
