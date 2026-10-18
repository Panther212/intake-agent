// Collects mic audio (AudioContext runs at 16 kHz) into ~100 ms chunks of 16-bit PCM.
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.length = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      this.chunks.push(new Float32Array(channel));
      this.length += channel.length;
      if (this.length >= 1600) {
        const out = new Int16Array(this.length);
        let o = 0;
        for (const c of this.chunks) {
          for (let i = 0; i < c.length; i++) {
            const s = Math.max(-1, Math.min(1, c[i]));
            out[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
        }
        this.port.postMessage(out.buffer, [out.buffer]);
        this.chunks = [];
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-recorder", PcmRecorder);
