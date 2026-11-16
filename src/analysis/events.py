"""The live input's events: the vocabulary the server's live director reads (src/show/live-director.ts)."""

from dataclasses import dataclass


BEAT = 'BEAT'
BAR = 'BAR'
DROP = 'DROP'
BUILDUP = 'BUILDUP'
ENERGY_SPIKE = 'ENERGY_SPIKE'
BASS_HIT = 'BASS_HIT'
VOCAL_SECTION = 'VOCAL_SECTION'
MELODY_CHANGE = 'MELODY_CHANGE'
SILENCE = 'SILENCE'
TRANSITION = 'TRANSITION'
BREAK = 'BREAK'
SECTION = 'SECTION'

TYPES = (BEAT, BAR, DROP, BUILDUP, ENERGY_SPIKE, BASS_HIT, VOCAL_SECTION,
         MELODY_CHANGE, SILENCE, TRANSITION, BREAK, SECTION)

EFFECTS = ('accent', 'pulse', 'flash', 'strobe', 'blinder', 'chase', 'sweep',
           'fade', 'wash', 'hold', 'blackout', 'color-shift', 'scene-change',
           'ramp')


# Every event has the same fields so the server handles unknown types; `effect` is a hint the director may ignore.
@dataclass
class Event:
    t: float
    type: str
    confidence: float = 1.0
    intensity: float = 0.5
    duration: float = 0.0
    effect: str = 'accent'
    data: dict = None

    def to_dict(self):
        out = {
            't': round(float(self.t), 3),
            'type': self.type,
            'confidence': round(float(self.confidence), 3),
            'intensity': round(float(self.intensity), 3),
            'duration': round(float(self.duration), 3),
            'effect': self.effect,
        }
        if self.data:
            out['data'] = self.data
        return out
