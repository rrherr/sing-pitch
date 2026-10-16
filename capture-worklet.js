// Collects mic audio into 512-sample chunks tagged with the context frame of their first sample.
const CHUNK = 512;
const SILENT = new Float32Array(128);

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CHUNK);
    this.n = 0;
    this.start = 0;
  }

  process(inputs) {
    // Before the stream delivers audio the input is empty; feed silence so chunk times stay contiguous.
    const ch = (inputs[0] && inputs[0][0]) || SILENT;
    if (this.n === 0) this.start = currentFrame;
    this.buf.set(ch, this.n);
    this.n += ch.length;
    if (this.n >= CHUNK) {
      this.port.postMessage({ frame: this.start, data: this.buf }, [this.buf.buffer]);
      this.buf = new Float32Array(CHUNK);
      this.n = 0;
    }
    return true;
  }
}

registerProcessor("capture", Capture);
