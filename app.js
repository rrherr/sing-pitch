"use strict";

const SONG = {
  vocals: "songs/fast-car/vocals.mp3",
  backing: "songs/fast-car/other.mp3",
  f0: "songs/fast-car/f0.json",
};
const HOP = 256 / 16000; // seconds per pitch frame, for both the song track and the mic
const MIC_FMIN = 65;     // C2
const MIC_FMAX = 1050;   // C6
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]);

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const noteName = (m) => { const r = Math.round(m); return NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1); };
const cents = (m) => { const c = Math.round((m - Math.round(m)) * 100); return (c > 0 ? "+" : c < 0 ? "−" : "±") + Math.abs(c) + "¢"; };
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
const fmt = (t, tenths = true) => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ":" + (tenths ? s.toFixed(1).padStart(4, "0") : String(Math.floor(s)).padStart(2, "0"));
};
// Distance in semitones between two pitches, ignoring octave, in -6..6.
const pcDist = (a, b) => ((((a - b) % 12) + 18) % 12) - 6;

// Median smoothing for a pitch track (MIDI, 0 = no sung note), over frames from..to-1 of raw,
// reading only frames below `avail`. Whether a frame is sung is a 3-frame majority vote (a tie
// keeps the frame's own state), so 1-frame dropouts fill and 1-frame blips vanish; a sung frame
// gets the median of the sung frames within width/2 on each side.
function smoothRange(raw, out, from, to, avail, width) {
  const h = width >> 1, vals = [];
  for (let j = Math.max(0, from); j < Math.min(to, avail); j++) {
    if (width <= 1) { out[j] = raw[j]; continue; }
    let votes = 0, seen = 0;
    for (let i = j - 1; i <= j + 1; i++) if (i >= 0 && i < avail) { seen++; if (raw[i] > 0) votes++; }
    const sung = 2 * votes > seen || (2 * votes === seen && raw[j] > 0);
    if (!sung) { out[j] = 0; continue; }
    vals.length = 0;
    for (let i = Math.max(0, j - h); i <= Math.min(avail - 1, j + h); i++) if (raw[i] > 0) vals.push(raw[i]);
    vals.sort((a, b) => a - b);
    out[j] = vals[vals.length >> 1];
  }
}

const S = {
  ctx: null, buffers: {}, gains: {}, sources: [],
  f0: null, f0Raw: null, n: 0, dur: 0, base: { lo: 48, hi: 67 },
  smooth: 5, // median window in frames; 1 = off
  playing: false, startCtx: 0, startPos: 0, pos: 0, loop: null,
  micSong: null, micRaw: null, passStart: 0, lastJ: -1,
  range: { lo: 48, hi: 67 },
};
const mic = {
  on: false, starting: false, ctx: null, stream: null, node: null, worker: null, ready: false,
  t0: null, inLat: 0.01, clockD: null, userOffset: 0, ms: 0,
  free: new Map(), recent: new Map(), latest: { k: -1, m: 0, t: 0 },
};

// ---------- loading ----------

async function load() {
  S.ctx = new AudioContext({ latencyHint: "interactive" });
  for (const k of ["vocals", "backing"]) {
    S.gains[k] = S.ctx.createGain();
    S.gains[k].connect(S.ctx.destination);
  }
  setVolumes();
  try {
    const f0 = await (await fetch(SONG.f0)).json();
    S.n = f0.midi.length;
    S.f0Raw = Float32Array.from(f0.midi, (v) => v / 100);
    S.f0 = new Float32Array(S.n);
    smoothRange(S.f0Raw, S.f0, 0, S.n, S.n, S.smooth);
    S.micSong = new Float32Array(S.n);
    S.micRaw = new Float32Array(S.n);
    const voiced = Array.from(S.f0Raw).filter((v) => v > 0).sort((a, b) => a - b);
    const pct = (p) => voiced[Math.floor(p * (voiced.length - 1))];
    S.base = { lo: Math.floor(pct(0.01)) - 2, hi: Math.ceil(pct(0.99)) + 2 };
    S.range = { ...S.base };
    S.dur = S.n * HOP;
    drawOverviewBase();
    let done = 0;
    $("loading").textContent = "Loading stems… 0 of 2";
    await Promise.all(["vocals", "backing"].map(async (k) => {
      const res = await fetch(SONG[k]);
      if (!res.ok) throw new Error(`${SONG[k]} returned ${res.status}`);
      S.buffers[k] = await S.ctx.decodeAudioData(await res.arrayBuffer());
      $("loading").textContent = `Loading stems… ${++done} of 2`;
    }));
    S.dur = Math.min(S.buffers.vocals.duration, S.buffers.backing.duration);
    drawOverviewBase();
    $("loading").hidden = true;
    $("play").disabled = $("restart").disabled = false;
  } catch (err) {
    $("loading").textContent = "Couldn't load the song: " + err.message;
  }
}

// ---------- transport ----------

// Song position heard at song-context time ts.
function songTimeAt(ts) {
  if (!S.playing) return S.pos;
  let p = S.startPos + (ts - S.startCtx);
  if (S.loop && S.startPos < S.loop.b && p >= S.loop.b) p = S.loop.a + ((p - S.loop.a) % (S.loop.b - S.loop.a));
  return Math.min(p, S.dur);
}
const outLat = () => (S.ctx.outputLatency || S.ctx.baseLatency || 0);
const displayPos = () => songTimeAt(S.ctx.currentTime - outLat());

function stopSources() {
  for (const s of S.sources) { try { s.stop(); } catch {} s.disconnect(); }
  S.sources = [];
}

async function startAt(pos) {
  await S.ctx.resume();
  stopSources();
  if (pos >= S.dur - 0.05) pos = 0;
  if (S.loop && (pos < S.loop.a || pos >= S.loop.b)) pos = S.loop.a;
  const t = S.ctx.currentTime + 0.03;
  for (const k of ["vocals", "backing"]) {
    const src = S.ctx.createBufferSource();
    src.buffer = S.buffers[k];
    if (S.loop) { src.loop = true; src.loopStart = S.loop.a; src.loopEnd = S.loop.b; }
    src.connect(S.gains[k]);
    src.start(t, pos);
    S.sources.push(src);
  }
  S.startCtx = t;
  S.startPos = pos;
  S.playing = true;
  S.lastJ = -1;
  updatePlayIcon();
}

function pause() {
  if (!S.playing) return;
  S.pos = displayPos();
  S.playing = false;
  stopSources();
  updatePlayIcon();
}

function togglePlay() { if (S.playing) pause(); else startAt(S.pos); }

function seek(t) {
  t = Math.max(0, Math.min(S.dur - 0.05, t));
  newPass(Math.round(t / HOP));
  S.pos = t;
  if (S.playing) startAt(t);
}

// A new take starts at frame j: clear your line from there to the end of the song or loop.
function newPass(j) {
  const end = S.loop ? Math.round(S.loop.b / HOP) : S.n;
  if (j < end) { S.micSong.fill(0, Math.max(0, j), end); S.micRaw.fill(0, Math.max(0, j), end); }
  S.passStart = Math.max(0, j);
  S.lastJ = -1;
}

function setLoop(a, b) {
  S.loop = { a, b };
  $("loopText").innerHTML = `Loop <b>${fmt(a)} – ${fmt(b)}</b>`;
  $("loopBox").classList.add("on");
  $("clearLoop").hidden = false;
  const p = S.playing ? displayPos() : S.pos;
  const inside = p >= a && p < b;
  if (!inside) seek(a);
  else if (S.playing) startAt(p);
}

function clearLoop() {
  const p = S.playing ? displayPos() : S.pos;
  S.loop = null;
  $("loopText").textContent = "Drag across the lane or overview to loop a phrase";
  $("loopBox").classList.remove("on");
  $("clearLoop").hidden = true;
  if (S.playing) startAt(p);
}

function updatePlayIcon() {
  $("playIcon").innerHTML = S.playing ? '<path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/>' : '<path d="M4 2.5v11l9-5.5z"/>';
  $("play").setAttribute("aria-label", S.playing ? "Pause" : "Play");
}

function setVolumes() {
  const v = $("vocalVol").value, b = $("backVol").value;
  $("vocalOut").textContent = v + "%";
  $("backOut").textContent = b + "%";
  if (S.gains.vocals) {
    S.gains.vocals.gain.setTargetAtTime((v / 100) ** 2, S.ctx.currentTime, 0.02);
    S.gains.backing.gain.setTargetAtTime((b / 100) ** 2, S.ctx.currentTime, 0.02);
  }
}

// ---------- microphone ----------

// Streaming low-pass + linear-interpolation resampler to 16 kHz, for browsers that won't run a 16 kHz context.
function makeResampler(sr) {
  const step = sr / 16000, T = 24, fc = 7600 / sr, h = new Float32Array(2 * T + 1);
  let sum = 0;
  for (let k = -T; k <= T; k++) {
    const x = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    h[k + T] = x * (0.5 + 0.5 * Math.cos(Math.PI * k / (T + 1)));
    sum += h[k + T];
  }
  for (let i = 0; i < h.length; i++) h[i] /= sum;
  let buf = new Float32Array(0), base = 0, next = T;
  const filt = (i) => { let acc = 0; const o = i - T - base; for (let k = 0; k < h.length; k++) acc += h[k] * buf[o + k]; return acc; };
  return (data) => {
    const nb = new Float32Array(buf.length + data.length);
    nb.set(buf); nb.set(data, buf.length); buf = nb;
    const end = base + buf.length, out = [];
    while (Math.floor(next) + 1 + T < end) {
      const i = Math.floor(next), f = next - i;
      out.push(filt(i) * (1 - f) + filt(i + 1) * f);
      next += step;
    }
    const keep = Math.floor(next) - T - base;
    if (keep > 0) { buf = buf.slice(keep); base += keep; }
    return Float32Array.from(out);
  };
}

function micStatus(text, err = false) {
  $("micStatus").textContent = text;
  $("micStatus").classList.toggle("err", err);
}

async function startMic() {
  if (mic.on || mic.starting) return;
  mic.starting = true;
  $("micBtn").disabled = true;
  micStatus("Loading pitch model…");
  try {
    if (!mic.worker) {
      mic.worker = new Worker("pitch-worker.js");
      mic.worker.onmessage = onWorker;
      await new Promise((resolve, reject) => {
        mic.onReady = resolve; mic.onError = reject;
        mic.worker.postMessage({ type: "init", modelUrl: new URL("model.onnx", location.href).href, fmin: MIC_FMIN, fmax: MIC_FMAX });
      });
    }
    micStatus("Waiting for microphone permission…");
    mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: $("ec").checked, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
    });
    let ctx, src;
    try {
      ctx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
      src = ctx.createMediaStreamSource(mic.stream);
    } catch {
      // Firefox refuses to connect a stream to a context at a different rate.
      if (ctx) ctx.close();
      ctx = new AudioContext({ latencyHint: "interactive" });
      src = ctx.createMediaStreamSource(mic.stream);
    }
    await ctx.audioWorklet.addModule("capture-worklet.js");
    const node = new AudioWorkletNode(ctx, "capture", { numberOfOutputs: 1, outputChannelCount: [1] });
    src.connect(node);
    node.connect(ctx.destination); // outputs silence; keeps the node pulled
    const resample = ctx.sampleRate === 16000 ? null : makeResampler(ctx.sampleRate);
    mic.t0 = null;
    node.port.onmessage = (e) => {
      if (mic.t0 === null) mic.t0 = e.data.frame / ctx.sampleRate;
      const data = resample ? resample(e.data.data) : e.data.data;
      if (data.length) mic.worker.postMessage({ type: "audio", data }, [data.buffer]);
    };
    await ctx.resume();
    const settings = mic.stream.getAudioTracks()[0].getSettings();
    mic.inLat = (settings.latency || 0.01) + (ctx.baseLatency || 0);
    mic.worker.postMessage({ type: "reset" });
    Object.assign(mic, { ctx, node, on: true, clockD: null });
    mic.free.clear();
    mic.recent.clear();
    mic.latest = { k: -1, m: 0, t: 0 };
    $("micLabel").textContent = "Stop mic";
    $("ec").disabled = true;
    micStatus(`Listening${ctx.sampleRate === 16000 ? "" : ` (resampling from ${ctx.sampleRate / 1000} kHz)`}`);
    updateOffsetLabel();
  } catch (err) {
    micStatus(err.name === "NotAllowedError" ? "Microphone permission was denied. Allow it in the browser's site settings, then try again." : "Mic didn't start: " + (err.message || err), true);
    stopMic(true);
  } finally {
    mic.starting = false;
    $("micBtn").disabled = false;
  }
}

function stopMic(keepStatus = false) {
  if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop());
  if (mic.node) mic.node.port.onmessage = null;
  if (mic.ctx) mic.ctx.close();
  Object.assign(mic, { on: false, stream: null, node: null, ctx: null });
  $("micLabel").textContent = "Start mic";
  $("ec").disabled = false;
  $("youNote").textContent = "–";
  $("youHz").textContent = "mic off";
  if (!keepStatus) micStatus("");
}

function onWorker(e) {
  const m = e.data;
  if (m.type === "ready") { mic.ready = true; mic.onReady && mic.onReady(); return; }
  if (m.type === "error") { mic.onError && mic.onError(new Error(m.message)); return; }
  if (m.type !== "frames" || !mic.on || mic.t0 === null || mic.clockD === null) return;
  mic.ms = m.ms;
  for (let i = 0; i < m.pitch.length; i++) {
    const k = m.from + i;
    const midi = m.conf[i] >= 0.5 && m.pitch[i] > 0 ? 69 + 12 * Math.log2(m.pitch[i] / 440) : 0;
    const tm = mic.t0 + k * HOP; // mic-context time of this frame
    if (k >= mic.latest.k) mic.latest = { k, m: midi, t: tm };
    mic.recent.set(k, midi);
    mic.recent.delete(k - 16);
    route(k, tm, midi);
  }
}

const compensation = () => outLat() + mic.inLat + mic.userOffset / 1000;

// Place a mic frame: on the song timeline if the song was playing when you sang it, else on the free-sing trail.
function route(k, tm, midi) {
  const ts = tm + mic.clockD - compensation(); // song-context time of the audio you were hearing
  if (S.playing) {
    if (ts < S.startCtx) return;
    const j = Math.round(songTimeAt(ts) / HOP);
    if (j < 0 || j >= S.n) return;
    // Refinements arrive up to ~11 frames late; a bigger jump back means the loop wrapped.
    if (S.lastJ >= 0 && j < S.lastJ - 25) newPass(j);
    S.micRaw[j] = midi;
    if (S.lastJ >= 0 && j === S.lastJ + 2) S.micRaw[j - 1] = midi;
    if (j > S.lastJ) S.lastJ = j;
    // Frames within half a window of j change too; ones near the newest frame settle as more arrive.
    const h = (S.smooth >> 1) + 1;
    smoothRange(S.micRaw, S.micSong, Math.max(S.passStart, j - h), j + h + 1, S.lastJ + 1, S.smooth);
  } else {
    mic.free.set(k, { t: tm, m: midi });
    if (mic.free.size > 1200) for (const key of mic.free.keys()) { if (key < k - 1000) mic.free.delete(key); else break; }
  }
}

function updateOffsetLabel() {
  const auto = S.ctx ? Math.round((outLat() + mic.inLat) * 1000) : 0;
  const u = mic.userOffset;
  $("offsetOut").textContent = `${auto} ms${u ? (u > 0 ? " + " : " − ") + Math.abs(u) : " auto"}`;
}

// The free-sing trail, smoothed the same way (keys are consecutive mic frames).
function smoothedFree() {
  const pts = [...mic.free.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ k, t: v.t, m: v.m }));
  const raw = Float32Array.from(pts, (p) => p.m), out = new Float32Array(raw.length);
  smoothRange(raw, out, 0, raw.length, raw.length, S.smooth);
  pts.forEach((p, i) => (p.m = out[i]));
  return pts;
}

// Your current note for the readout: median of the newest sung frames, with no lookahead.
function currentMic() {
  if (!(mic.latest.m > 0)) return 0;
  const h = S.smooth >> 1, vals = [];
  for (let k = mic.latest.k - h; k <= mic.latest.k; k++) { const m = mic.recent.get(k); if (m > 0) vals.push(m); }
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

function setSmoothing(w) {
  S.smooth = w;
  try { localStorage.setItem("smooth", String(w)); } catch {}
  for (const b of document.querySelectorAll("#smoothing button")) b.setAttribute("aria-pressed", String(+b.dataset.w === w));
  if (!S.f0Raw) return;
  smoothRange(S.f0Raw, S.f0, 0, S.n, S.n, w);
  if (S.lastJ >= 0) smoothRange(S.micRaw, S.micSong, S.passStart, S.lastJ + 1, S.lastJ + 1, w);
  drawOverviewBase();
}

// ---------- scoring ----------

function score(from, to) {
  let voiced = 0, hit = 0;
  for (let j = Math.max(0, from); j < Math.min(to, S.n); j++) {
    if (!(S.f0[j] > 0)) continue;
    voiced++;
    const m = S.micSong[j];
    if (m > 0 && Math.abs(pcDist(m, S.f0[j])) <= 0.5) hit++;
  }
  return voiced >= 15 ? Math.round((100 * hit) / voiced) + "%" : "–";
}

// ---------- drawing ----------

const lane = $("lane"), over = $("overview");
const lctx = lane.getContext("2d"), octx = over.getContext("2d");
let overBase = null, colors = {}, drag = null, laneGeom = null;

// The loop being dragged out, else the current loop, else null.
const loopSpan = () => (drag?.moved ? { a: Math.min(drag.a, drag.b), b: Math.max(drag.a, drag.b) } : S.loop);

function readColors() {
  for (const k of ["panel", "line", "fg", "muted", "target", "mic", "unscored", "hit", "miss", "key-dark", "grid", "grid-c"]) colors[k] = css("--" + k);
}

function fit(canvas, c) {
  const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: r.width, h: r.height };
}

function drawOverviewBase() {
  if (!S.f0) return;
  const { w, h } = fit(over, octx);
  overBase = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  overBase.width = over.width; overBase.height = over.height;
  const b = overBase.getContext("2d");
  b.setTransform(dpr, 0, 0, dpr, 0, 0);
  b.fillStyle = colors.target;
  b.globalAlpha = 0.75;
  const { lo, hi } = S.base, dur = S.n * HOP;
  for (let j = 0; j < S.n; j += 2) {
    if (!(S.f0[j] > 0)) continue;
    const x = (j * HOP / dur) * w, y = h - 6 - ((S.f0[j] - lo) / (hi - lo)) * (h - 12);
    b.fillRect(x, y - 0.75, 1.2, 1.5);
  }
}

function drawOverview(pos) {
  const { w, h } = fit(over, octx);
  octx.clearRect(0, 0, w, h);
  const dur = S.n * HOP;
  const X = (t) => (t / dur) * w;
  const sel = loopSpan();
  if (sel) {
    const { a, b } = sel;
    octx.fillStyle = colors["grid-c"];
    octx.fillRect(X(a), 0, X(b) - X(a), h);
  }
  if (overBase && overBase.width && overBase.height) octx.drawImage(overBase, 0, 0, w, h);
  const { lo, hi } = S.base;
  for (let j = 0; j < S.n; j += 2) {
    const m = S.micSong[j];
    if (!(m > 0)) continue;
    const t = S.f0[j];
    octx.fillStyle = t > 0 ? (Math.abs(pcDist(m, t)) <= 0.5 ? colors.hit : colors.miss) : colors.unscored;
    const y = Math.max(2, Math.min(h - 2, h - 6 - ((m - lo) / (hi - lo)) * (h - 12)));
    octx.fillRect(X(j * HOP), y - 1, 1.5, 2);
  }
  octx.fillStyle = colors.fg;
  octx.fillRect(X(pos) - 1, 0, 2, h);
}

function drawLane(pos, free) {
  const { w, h } = fit(lane, lctx);
  lctx.fillStyle = colors.panel;
  lctx.fillRect(0, 0, w, h);

  // Pitch range: the song's range, widened to keep your recent singing in view.
  let tlo = S.base.lo, thi = S.base.hi;
  const recent = [];
  if (free) { for (const v of mic.free.values()) if (v.m > 0 && v.t > mic.latest.t - 6) recent.push(v.m); }
  else { for (let j = Math.max(0, Math.round(pos / HOP) - 400); j <= Math.min(S.n - 1, S.lastJ); j++) if (S.micSong[j] > 0) recent.push(S.micSong[j]); }
  if (recent.length) { tlo = Math.min(tlo, Math.floor(Math.min(...recent)) - 1); thi = Math.max(thi, Math.ceil(Math.max(...recent)) + 1); }
  S.range.lo += (tlo - S.range.lo) * 0.08;
  S.range.hi += (thi - S.range.hi) * 0.08;
  const { lo, hi } = S.range;
  const gutter = 46, padY = 8;
  const Y = (m) => h - padY - ((m - lo) / (hi - lo)) * (h - 2 * padY);
  const row = (h - 2 * padY) / (hi - lo);

  // Note grid
  lctx.font = `500 ${row < 13 ? 9 : 11}px ${css("--font-data")}`;
  lctx.textBaseline = "middle";
  for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
    const pc = ((m % 12) + 12) % 12, y = Y(m);
    if (BLACK.has(pc)) { lctx.fillStyle = colors["key-dark"]; lctx.fillRect(gutter, y - row / 2, w - gutter, row); }
    lctx.fillStyle = pc === 0 ? colors["grid-c"] : colors.grid;
    lctx.fillRect(gutter, Math.round(y - row / 2) + 0.5, w - gutter, pc === 0 ? 1 : 0.5);
    if (!BLACK.has(pc) && (row >= 9 || pc === 0)) {
      lctx.fillStyle = pc === 0 ? colors.fg : colors.muted;
      lctx.fillText(noteName(m), 8, y);
    }
  }

  const span = Math.max(6, Math.min(12, w / 90)); // seconds across the lane
  const nowFrac = free ? 0.78 : 0.3;
  const pps = (w - gutter) / span;
  const nowX = gutter + nowFrac * (w - gutter);
  laneGeom = { nowX, pps, free };
  lctx.save();
  lctx.beginPath(); lctx.rect(gutter, 0, w - gutter, h); lctx.clip();
  lctx.lineCap = "round"; lctx.lineJoin = "round";

  if (free) {
    const pts = smoothedFree();
    const nowT = mic.latest.t;
    lctx.strokeStyle = colors.mic; lctx.lineWidth = 4;
    let prev = null;
    for (const p of pts) {
      if (p.m > 0 && prev && prev.m > 0 && p.t - prev.t < 0.05 && Math.abs(p.m - prev.m) < 1.5) {
        lctx.beginPath();
        lctx.moveTo(nowX + (prev.t - nowT) * pps, Y(prev.m));
        lctx.lineTo(nowX + (p.t - nowT) * pps, Y(p.m));
        lctx.stroke();
      }
      prev = p;
    }
  } else {
    const X = (t) => nowX + (t - pos) * pps;
    const j0 = Math.max(0, Math.floor((pos - nowFrac * span) / HOP) - 1);
    const j1 = Math.min(S.n - 1, Math.ceil((pos + (1 - nowFrac) * span) / HOP) + 1);

    const sel = loopSpan();
    if (sel) {
      lctx.fillStyle = colors.grid;
      lctx.fillRect(X(sel.a), 0, X(sel.b) - X(sel.a), h);
      lctx.fillStyle = colors["grid-c"];
      for (const t of [sel.a, sel.b]) lctx.fillRect(X(t) - 1, 0, 2, h);
    }

    // Recorded vocal
    lctx.strokeStyle = colors.target;
    lctx.lineWidth = 3.5;
    lctx.beginPath();
    let open = false;
    for (let j = j0; j <= j1; j++) {
      const m = S.f0[j], pm = j > j0 ? S.f0[j - 1] : 0;
      if (!(m > 0)) { open = false; continue; }
      if (open && pm > 0 && Math.abs(m - pm) < 1) lctx.lineTo(X(j * HOP), Y(m));
      else { lctx.moveTo(X(j * HOP), Y(m)); open = true; }
    }
    lctx.stroke();

    // Your line, drawn in runs of one kind: on pitch, off pitch, or unscored.
    const kind = (j) => { const t = S.f0[j]; return t > 0 ? (Math.abs(pcDist(S.micSong[j], t)) <= 0.5 ? "hit" : "miss") : "unscored"; };
    const last = Math.min(j1, S.lastJ);
    let run = null;
    const flush = () => {
      if (!run) return;
      lctx.strokeStyle = colors[run.kind];
      lctx.lineWidth = 4;
      lctx.stroke();
      run = null;
    };
    for (let j = Math.max(j0 + 1, S.passStart + 1); j <= last; j++) {
      const m = S.micSong[j], pm = S.micSong[j - 1];
      if (!(m > 0 && pm > 0) || Math.abs(m - pm) > 1.5) { flush(); continue; }
      const k = kind(j);
      if (!run || run.kind !== k) {
        flush();
        run = { kind: k };
        lctx.beginPath();
        lctx.moveTo(X((j - 1) * HOP), Y(pm));
      }
      lctx.lineTo(X(j * HOP), Y(m));
    }
    flush();
  }

  // Now line
  lctx.fillStyle = colors.fg;
  lctx.globalAlpha = 0.5;
  lctx.fillRect(nowX - 0.5, 0, 1, h);
  lctx.globalAlpha = 1;
  const cm = mic.on ? currentMic() : 0;
  if (cm > 0) {
    lctx.beginPath();
    lctx.arc(nowX, Y(cm), 5, 0, Math.PI * 2);
    lctx.fillStyle = colors.mic;
    lctx.fill();
  }
  lctx.restore();
}

// ---------- frame loop ----------

let lastReadout = 0, lastScore = 0, lastOverview = 0;

function frame(now) {
  requestAnimationFrame(frame);
  if (!S.f0) return;
  if (S.playing && displayPos() >= S.dur - 0.02 && !S.loop) { pause(); S.pos = 0; }
  if (mic.on && mic.ctx) {
    const d = S.ctx.currentTime - mic.ctx.currentTime;
    mic.clockD = mic.clockD === null ? d : mic.clockD + (d - mic.clockD) * 0.05;
  }
  const pos = displayPos();
  const free = mic.on && !S.playing;
  drawLane(pos, free);
  $("modeTag").textContent = free ? "Free sing · song paused" : "";
  if (now - lastOverview > 90) { drawOverview(pos); lastOverview = now; }

  if (now - lastReadout > 80) {
    lastReadout = now;
    $("time").innerHTML = `${fmt(pos)} <span>/ ${fmt(S.dur, false)}</span>`;
    const t = S.f0[Math.round(pos / HOP)];
    $("songNote").textContent = !free && t > 0 ? noteName(t) : "–";
    $("songHz").textContent = !free && t > 0 ? `${hz(t).toFixed(0)} Hz` : " ";
    if (mic.on) {
      const m = currentMic();
      $("youNote").textContent = m > 0 ? noteName(m) + " " + cents(m) : "–";
      $("youHz").textContent = m > 0 ? `${hz(m).toFixed(0)} Hz` : "listening";
      if (mic.ms) micStatus(`Listening · model ${mic.ms.toFixed(1)} ms per step`);
    }
  }
  if (now - lastScore > 250) {
    lastScore = now;
    const on = mic.on && S.lastJ > 0;
    $("scoreNow").textContent = on ? score(Math.max(S.passStart, S.lastJ - 250), S.lastJ + 1) : "–";
    $("scoreTake").textContent = on ? score(S.passStart, S.lastJ + 1) : "–";
  }
}

// ---------- events ----------

$("play").onclick = togglePlay;
$("restart").onclick = () => seek(S.loop ? S.loop.a : 0);
$("clearLoop").onclick = clearLoop;
$("vocalVol").oninput = $("backVol").oninput = setVolumes;
$("micBtn").onclick = () => (mic.on ? stopMic() : startMic());
for (const b of document.querySelectorAll("#smoothing button")) b.onclick = () => setSmoothing(+b.dataset.w);
$("offset").oninput = (e) => { mic.userOffset = +e.target.value; updateOffsetLabel(); };

// Click to seek, drag to loop. timeAt maps a pointer x (px from the canvas's left edge) to song time, or null.
function seekAndLoop(canvas, timeAt) {
  canvas.addEventListener("pointerdown", (e) => {
    if (!S.buffers.vocals || e.button !== 0) return;
    const t = timeAt(e.clientX - canvas.getBoundingClientRect().left);
    if (t === null) return;
    drag = { canvas, x: e.clientX, a: t, b: t, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag?.canvas !== canvas) return;
    const t = timeAt(e.clientX - canvas.getBoundingClientRect().left);
    if (t !== null) drag.b = t;
    if (Math.abs(e.clientX - drag.x) > 6) drag.moved = true;
  });
  const end = () => {
    if (drag?.canvas !== canvas) return;
    const { a, b, moved } = drag;
    drag = null;
    if (moved && Math.abs(b - a) >= 0.5) setLoop(Math.min(a, b), Math.max(a, b));
    else if (!moved) seek(a);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", () => { if (drag?.canvas === canvas) drag = null; });
}
const clampT = (t) => Math.max(0, Math.min(S.dur, t));
seekAndLoop(over, (x) => clampT((x / over.getBoundingClientRect().width) * S.dur));
// The lane scrolls, so its time under the pointer is read against the current playhead. Free-sing mode has no song time.
seekAndLoop(lane, (x) => {
  if (!laneGeom || laneGeom.free) return null;
  return clampT((S.playing ? displayPos() : S.pos) + (x - laneGeom.nowX) / laneGeom.pps);
});

document.addEventListener("keydown", (e) => {
  if (!S.buffers.vocals || e.target.matches("input[type=checkbox], button")) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.target.matches("input")) return;
  else if (e.key === "ArrowLeft") seek((S.playing ? displayPos() : S.pos) - 5);
  else if (e.key === "ArrowRight") seek((S.playing ? displayPos() : S.pos) + 5);
});

const theme = matchMedia("(prefers-color-scheme: dark)");
theme.addEventListener("change", () => { readColors(); drawOverviewBase(); });
new ResizeObserver(() => drawOverviewBase()).observe(over);

readColors();
updateOffsetLabel();
try { const w = +localStorage.getItem("smooth"); if ([1, 3, 5, 7].includes(w)) S.smooth = w; } catch {}
setSmoothing(S.smooth);
load();
requestAnimationFrame(frame);
