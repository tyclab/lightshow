"""The live input's numeric primitives (src/analysis/dsp.py)."""

import unittest

from support import needs_numpy


@needs_numpy
class Autocorrelation(unittest.TestCase):
    def test_a_periodic_signal_peaks_at_its_own_period(self):
        import numpy as np
        from analysis import dsp

        period = 37
        signal = np.zeros(1000)
        signal[::period] = 1.0
        correlation = dsp.autocorrelation(signal, max_lag=200)
        peak = int(np.argmax(correlation[10:])) + 10
        self.assertEqual(peak, period)
        self.assertAlmostEqual(correlation[0], 1.0, places=6)


if __name__ == '__main__':
    unittest.main()
