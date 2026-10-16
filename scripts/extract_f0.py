# /// script
# dependencies = ["swift-f0[audio]==0.3.0", "numpy"]
# ///
"""Write a song's vocal f0 as compact JSON for the page.

Usage: uv run scripts/extract_f0.py <vocal stem> <out.json>
midi: pitch in hundredths of a MIDI note (0 = unvoiced), conf: confidence 0-100.
"""
import json
import sys

import numpy as np
from swift_f0 import SwiftF0

stem, out = sys.argv[1], sys.argv[2]
r = SwiftF0().detect_file(stem)
voiced = r.confidence >= 0.5
midi = np.where(voiced, np.round((69 + 12 * np.log2(r.pitch_hz / 440)) * 100), 0).astype(int)
conf = np.round(r.confidence * 100).astype(int)
with open(out, "w") as f:
    json.dump({"hop": 256 / 16000, "midi": midi.tolist(), "conf": conf.tolist()}, f, separators=(",", ":"))
v = midi[voiced] / 100
print(f"{len(midi)} frames, {voiced.mean():.0%} voiced, range MIDI {np.percentile(v, 1):.1f}-{np.percentile(v, 99):.1f}")
