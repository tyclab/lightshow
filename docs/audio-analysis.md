# Live input analysis

How the live input hears the music as it plays, what it reports to the server,
and which numbers you can turn. Setup is in the README's
[Live input](../README.md#live-input).

```
sound card: what this computer plays (loopback) or an input
    │  256-sample hops at 22.05 kHz
    ▼
┌───────────────────────────────────────────┐
│  src/live_input.py → src/analysis/live.py │
│  (Python subprocess, NDJSON on stdout)    │
│                                           │
│  realtime.py  StreamingAnalyzer           │
│    onsets → tempo (rhythm.py) → beat grid │
│    energy → spikes, build-ups, drops,     │
│             section changes, silence      │
│    levels of the bands in config.py       │
└───────────────────────────────────────────┘
    │  a state line every hop, event lines as they happen
    ▼
src/live-input.ts → the pattern clock (src/server/conductor.ts)
                  → the live director (src/show/live-director.ts)
                  → reactive effects (src/server/audio-features.ts)
```

## The modules

| File | What it holds |
|---|---|
| `src/live_input.py` | The launcher the server starts: puts `src/` on the path and runs `analysis.live.main` |
| `src/analysis/live.py` | The service: capture through `soundcard` (`sounddevice` is the line-in fallback) or a file, one analyser hop at a time, NDJSON out, `bands` and `pcm` lines in |
| `src/analysis/realtime.py` | `StreamingAnalyzer`: onsets, tempo, the beat grid, levels and the events |
| `src/analysis/rhythm.py` | The tempo estimate: onset autocorrelation weighted by a tempo prior |
| `src/analysis/dsp.py` | The autocorrelation and clamping the two share |
| `src/analysis/events.py` | The event vocabulary |
| `src/analysis/config.py` | The bands and every tuning constant |

The service needs numpy and soundcard (`requirements.txt`); librosa and
soundfile only read a file, which is what the tests do. Nothing here loads a
model or downloads anything.

## Running it

```bash
python src/live_input.py --list
python src/live_input.py --source loopback [--device NAME] [--bands 0-160,750-2000]
python src/live_input.py --source input --device NAME
python src/live_input.py --file track.wav [--realtime]
```

Every hop it writes one JSON object per line: `ready` once, then `state` lines
(the stream time, the beat position, tempo, levels and, with `--bands`, the
spectrum bands the party effects read) and `event` lines, plus `error` and, for a
file, `end`. The server changes the bands without a restart by writing a
`bands` line to its stdin. The protocol is spelled out at the top of
`src/analysis/live.py`; the sample stream for the `samples` topic is described in
the README's [Live input](../README.md#live-input).

## Live mode (`realtime.py`)

Live there is no future to look at: every event is called from what has been
heard so far.

**No models.** A beat-tracking model over a rolling window costs more latency
than a show can spend. So the tempo comes from the signal chain —
autocorrelation over the last ten seconds of onset history, weighted by the
tempo prior (`rhythm.py`) — which is a much easier problem than deciding a
record's tempo from scratch: the window is short enough that the track is not
changing over it, and the one failure it still makes is the octave, which the
folding below covers.

* **Adaptive thresholds** — median plus a multiple of the median absolute
  deviation over a rolling ten-second window. MAD rather than standard
  deviation because the window contains the very peaks being detected, so a
  standard deviation is inflated by them and the detector goes deaf exactly
  when the music gets busy.
* **A predicted grid** rather than a tracker: an oscillator runs at the
  current tempo, and twice a second its phase is re-fitted to the last four
  seconds of onsets — the phase at which a grid of that tempo collects the most
  onset strength — and moved half-way there, with a much smaller correction to
  the period so the loop does not re-earn the same drift every bar. A window of
  several beats outvotes a syncopated hit or a missing kick. The loop used to be
  nudged by every onset near a predicted beat instead, and every hat and snare
  pushed the grid a little later; at a fine hop it ran away from the music
  (12–22 beats dropped in 20 seconds of four-on-the-floor), and even at the
  default hop the 90th-percentile error was 66–295 ms. It is now 24–48 ms.
* **Octave folding** — when the kick drops out for a breakdown the estimator
  legitimately reports half tempo, and averaging 174 with 87 gives 130, a tempo
  the track has never played. A reading that folds to within 10 % of the running
  tempo is folded; one that does not is a real tempo change and is followed.
* **Drops are called on the rise**, with lower confidence and an `unconfirmed`
  flag, because waiting for the sustain to confirm one is useless live.
* **Sections** are the last two seconds against the unbroken passage before
  them. A change of `section_step` either way is a `TRANSITION` (`to: 'high'` or
  `'low'`). A rise that lands within a step of the loudest level remembered is a
  `DROP`, and so is sound that comes back that loud after a silence; the first
  rise after a start or a pause sets that level.

Latency is one hop (23 ms at the defaults) plus the caller's own buffering.
Throughput is roughly fifty times real time on one core.

The live input service (`src/live_input.py`, `analysis/live.py`) runs it on a
256-sample hop, 12 ms, capturing from a sound card itself: its grid sits within
10 ms of the beat on the synthetic tracks once the half-window lag of the onset
function is taken off, with a 90th percentile of 17–33 ms. After 3 s under
−80 dBFS it reports four states a second, marked `quiet`, until it hears sound.

## Events

Every event carries `t` (stream seconds), `confidence`, `intensity`,
`duration`, `effect` (a hint the server may ignore) and `data` with `live: true`.
The live input reports these:

| Type | When |
|---|---|
| `BEAT` | every beat of the grid, with `inBar` 0–3 |
| `BAR` | every fourth beat, with its `index` |
| `BASS_HIT` | an onset whose sub and bass sit over 1.6 times their mean of the last second |
| `ENERGY_SPIKE` | the level more than three deviations over its median, at most one per 1.2 s |
| `BUILDUP` | the level trending up over the recent history, at most one per 6 s |
| `DROP` | a rise that lands at the loudest level remembered (above), `unconfirmed: true`, at most one per 8 s |
| `TRANSITION` | a section change (above), at most one per 10 s |
| `SILENCE` | the level under 5 % of its recent 90th percentile for 0.4 s |

`events.py` also names `VOCAL_SECTION`, `MELODY_CHANGE`, `BREAK` and `SECTION`;
the live input reports none of them.

The pattern clock follows the beat position in the state lines. The live
director counts `BAR` and answers `TRANSITION`, `BUILDUP`, `DROP`,
`ENERGY_SPIKE` and `SILENCE`; what it does with each is in the README's
[Live input](../README.md#live-input) and at the top of
`src/show/live-director.ts`.

## Tuning

Every constant lives in `src/analysis/config.py`, with its unit and its reason.
The live service builds its `RealtimeConfig` in `live.live_config()` (22.05 kHz,
a 256-sample hop, a 1024-point FFT). The ones most worth reaching for:

| Parameter | Default | Turn it when |
|---|---|---|
| `RealtimeConfig.onset_k` | 1.6 | onsets are missed (lower) or hats and noise count as onsets (raise) |
| `RealtimeConfig.history_sec` | 10.0 | the thresholds and the tempo window should remember more or less |
| `RealtimeConfig.phase_window_sec` | 4.0 | the grid should outvote longer syncopation (raise) or follow a drifting tempo faster (lower) |
| `RealtimeConfig.phase_lock_strength` | 0.5 | the grid jitters (lower) or lags a phase change (raise) |
| `RealtimeConfig.frequency_lock_strength` | 0.012 | a syncopated passage drags the tempo (lower) |
| `RealtimeConfig.section_step` | 0.55 | section changes and drops are missed (lower) or invented (raise) |
| `RealtimeConfig.quiet_rms` / `quiet_after_sec` | 1e-4 / 3.0 | an idle source is not recognised as silent |
| `RhythmConfig.tempo_prior_bpm` | 120.0 | a genre with a consistently different tactus (drum & bass, dub) |

The streaming analyser asks the tempo estimate for 60–190 BPM instead of
`RhythmConfig`'s 55–200 defaults.

`BANDS` holds the seven bands the state lines report: `sub` 20–60 Hz, `bass`
60–250 Hz, `lowmid` 250–500 Hz, `mid` 500 Hz–2 kHz, `presence` 2–5 kHz, `high`
5–12 kHz and `air` 12–20 kHz. At 22.05 kHz `air` has no bins and reads null.

Show-side pacing is in `src/show/live-director.ts`: `ROTATE_BARS` (a new look
after sixteen bars), `HAND_HOLD_MS` (how long a look picked by hand holds),
`ACCENT_COOLDOWN_MS`, `PEAK_DECAY_PER_SEC` and `CHARACTER_SMOOTHING`. Which look
and which burst it picks is `pickPattern` and `burstFor` in `src/show/look.ts`.

## Testing

`tests/python/synth.py` builds tracks whose kick times, metre and arrangement
are known by construction — real music cannot be checked into a repository and
has no ground truth to assert against. The signals are crude on purpose: a test
that only passes on a convincing synthetic mix is a test of the mix.

```bash
python -m unittest discover -s tests/python -v   # the live input
npm test                                         # the server and the live director
```

`test_live.py` runs the service the server starts, through a file and through a
stand-in sound card; `test_realtime.py` drives the analyser; `test_rhythm.py`
and `test_dsp.py` cover the tempo estimate and its primitives. Tests that need
numpy, librosa or soundfile skip without them.
