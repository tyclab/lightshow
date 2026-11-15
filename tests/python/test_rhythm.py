"""The live input's tempo estimate (src/analysis/rhythm.py): how a candidate period is scored."""

import unittest

from support import needs_numpy


@needs_numpy
class PulseScoring(unittest.TestCase):
    """The step that resolves what autocorrelation cannot."""

    def envelope(self, period, length=800, offbeat=0.0):
        import numpy as np
        signal = np.zeros(length)
        signal[::period] = 1.0
        if offbeat:
            signal[period // 2::period] = offbeat
        return signal

    def test_the_true_period_beats_half_the_period(self):
        """Half tempo lands on every other beat, so its precision is identical.
        Only recall separates them — and it must."""
        from analysis import rhythm
        env = self.envelope(20)
        true_fit, _ = rhythm.pulse_score(env, 20.0)
        half_fit, _ = rhythm.pulse_score(env, 40.0)
        self.assertGreater(true_fit, half_fit)

    def test_the_true_period_beats_a_three_to_two_relative(self):
        from analysis import rhythm
        env = self.envelope(20, offbeat=0.3)
        true_fit, _ = rhythm.pulse_score(env, 20.0)
        relative_fit, _ = rhythm.pulse_score(env, 30.0)
        self.assertGreater(true_fit, relative_fit)

    def test_a_flat_envelope_scores_nothing_in_particular(self):
        import numpy as np
        from analysis import rhythm
        fit, _ = rhythm.pulse_score(np.ones(400), 20.0)
        self.assertLess(fit, 0.5)


if __name__ == '__main__':
    unittest.main()
