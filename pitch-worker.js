// Streams 16 kHz mic audio through SwiftF0. Each run covers the latest WIN frames; a frame is
// final once LOOK later frames exist (see swift_f0/core.py), and newer frames are sent as
// provisional values that later runs refine.
// onnxruntime-web 1.30.0, vendored so the app runs offline.
const ORT = new URL("vendor/ort/", self.location.href).href;
importScripts(ORT + "ort.wasm.min.js");
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = ORT;

const HOP = 256;
const LEFT = 11;
const LOOK = 10;
const WIN = 48;
const SILENCE_PEAK = 1e-3;

let session = null;
let fmin, fmax;
let buf = new Float32Array(16000 * 2);
let len = 0;
let base = 0; // absolute sample index of buf[0]
let lastTotal = 0;
let lastFinal = -1; // highest frame already sent as final
let busy = false;
let msAvg = 0;

onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") {
    try {
      session = await ort.InferenceSession.create(m.modelUrl, { executionProviders: ["wasm"] });
      fmin = new ort.Tensor("float32", Float32Array.from([m.fmin]), []);
      fmax = new ort.Tensor("float32", Float32Array.from([m.fmax]), []);
      postMessage({ type: "ready" });
    } catch (err) {
      postMessage({ type: "error", message: String(err && err.message || err) });
    }
  } else if (m.type === "audio") {
    append(m.data);
    pump();
  } else if (m.type === "reset") {
    len = 0; base = 0; lastTotal = 0; lastFinal = -1;
  }
};

function append(data) {
  if (len + data.length > buf.length) {
    const drop = Math.floor((len - WIN * HOP * 2) / HOP) * HOP;
    buf.copyWithin(0, drop, len);
    len -= drop;
    base += drop;
  }
  buf.set(data, len);
  len += data.length;
}

async function pump() {
  if (!session || busy) return;
  const total = Math.floor((base + len) / HOP);
  if (total <= lastTotal) return;
  busy = true;
  const startFrame = Math.max(0, total - WIN, Math.ceil(base / HOP));
  const audio = buf.slice(startFrame * HOP - base, total * HOP - base);
  const t0 = performance.now();
  const out = await session.run({
    audio: new ort.Tensor("float32", audio, [1, audio.length]),
    fmin,
    fmax,
  });
  msAvg = msAvg ? msAvg * 0.9 + (performance.now() - t0) * 0.1 : performance.now() - t0;
  const pitch = out.pitch.data;
  const conf = out.confidence.data;
  const n = Math.min(conf.length, total - startFrame);
  const ready = startFrame === 0 ? 0 : startFrame + LEFT;
  const from = Math.max(ready, lastFinal + 1);
  if (from < startFrame + n) {
    const p = new Float32Array(startFrame + n - from);
    const c = new Float32Array(p.length);
    for (let k = from; k < startFrame + n; k++) {
      const i = k - startFrame;
      let peak = 0;
      for (let s = i * HOP; s < (i + 1) * HOP; s++) peak = Math.max(peak, Math.abs(audio[s]));
      p[k - from] = pitch[i];
      c[k - from] = peak < SILENCE_PEAK ? 0 : conf[i];
    }
    postMessage({ type: "frames", from, pitch: p, conf: c, ms: msAvg }, [p.buffer, c.buffer]);
  }
  lastFinal = Math.max(lastFinal, startFrame + n - 1 - LOOK);
  lastTotal = total;
  busy = false;
  pump();
}
