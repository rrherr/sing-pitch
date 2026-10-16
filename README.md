# sing-pitch

Sing along with a song's separated stems and see your pitch against the recorded vocal.

- **Song track**: the vocal stem's f0, computed offline with SwiftF0 (`scripts/extract_f0.py`).
- **Live track**: your mic, run through the same SwiftF0 ONNX model in the browser (onnxruntime-web, WASM, single thread) in a Web Worker. Audio comes in through an AudioWorklet at 16 kHz.

The page is static and self-contained: relative paths only, no build step, no network access. It runs from any static server, offline. Third-party files live in `vendor/` (onnxruntime-web 1.30.0, MIT; Familjen Grotesk and IBM Plex Mono, OFL) and `model.onnx` is SwiftF0's model (MIT, `model-LICENSE.txt`).

## Run

```bash
python3 -m http.server 8769 --bind 127.0.0.1 --directory sing-pitch
```

Open http://localhost:8769. The mic needs a secure context, and localhost counts.

## Adding a song

```bash
bgk stems -v 1 -i 0 -o . "<Artist - Title>.mp3"
uv run sing-pitch/scripts/extract_f0.py "<Artist - Title>/<Artist - Title>_vocals.mp3" sing-pitch/songs/<id>/f0.json
```

Then copy the two stems to `songs/<id>/vocals.mp3` and `songs/<id>/other.mp3` (copies, not symlinks, so the folder stays self-contained), and point `SONG` at the top of `app.js` at the new folder.

The stems in `songs/` are copyrighted recordings. Don't host them publicly.

## How the live line lines up

- A mic frame's time on the song timeline is its capture time, minus input and output latency (the **Mic timing** slider adds to that), mapped across the two audio clocks.
- SwiftF0 needs 10 frames (160 ms) of lookahead before a frame is final. The worker draws each new frame immediately as a provisional value and overwrites it as later context arrives.
