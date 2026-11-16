// 麦克风 PCM 采集：攒满 20ms 一帧发回主线程
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = Math.max(128, Math.round(sampleRate * 0.02));
    this.buf = new Float32Array(this.frames);
    this.i = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let k = 0; k < ch.length; k++) {
      this.buf[this.i++] = ch[k];
      if (this.i >= this.frames) {
        this.port.postMessage(this.buf.slice(0));
        this.i = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMProcessor);