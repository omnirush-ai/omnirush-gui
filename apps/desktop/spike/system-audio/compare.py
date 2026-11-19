#!/usr/bin/env python3
"""Does the recorded "Them" WAV carry the played fixture? Stdlib only.
Usage: compare.py <played.wav> <recorded.wav>
Prints the best-lag Pearson correlation of 50 ms RMS envelopes (1.0 = same shape)."""
import array, math, sys, wave


def envelope(path, win_s=0.05):
    with wave.open(path) as w:
        rate, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        assert width == 2, "16-bit WAV expected"
        pcm = array.array("h", w.readframes(w.getnframes()))
    mono = [sum(pcm[i:i + ch]) / ch for i in range(0, len(pcm), ch)]
    step = int(rate * win_s)
    return [math.sqrt(sum(v * v for v in mono[i:i + step]) / step) for i in range(0, len(mono) - step, step)]


def pearson(a, b):
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    ma, mb = sum(a) / n, sum(b) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    va, vb = sum((x - ma) ** 2 for x in a), sum((y - mb) ** 2 for y in b)
    return cov / math.sqrt(va * vb) if va and vb else 0.0


played, recorded = envelope(sys.argv[1]), envelope(sys.argv[2])
best = max(((pearson(played, recorded[lag:]), lag) for lag in range(0, max(1, len(recorded) - len(played) // 2))), default=(0.0, 0))
db = lambda xs: 20 * math.log10(max(max(xs), 1e-9) / 32768)
print(f"correlation={best[0]:.3f} lag_s={best[1] * 0.05:.2f} played_peak_dbfs={db(played):.1f} recorded_peak_dbfs={db(recorded):.1f}")
assert pearson([1, 2, 3, 4], [2, 4, 6, 8]) > 0.999  # self-check
