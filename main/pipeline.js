'use strict';

/**
 * 一次对话回合的编排：
 *   说话音频 → 识别 → 拼人设与记忆（可选带截图）→ 流式回答 → 逐句合成语音
 * 目标：说完话到听见第一声，越快越好。
 */

const asr = require('./asr');
const tts = require('./tts');
const llm = require('./llm');
const persona = require('./persona');
const memory = require('./memory');
const vision = require('./vision');
const config = require('./config');
const dbg = require('./debug');

const END_RE = /[。！？!?…；;\n]/;

/** 把流式文本按句子切出来，串行合成，保证顺序 */
class SpeechQueue {
  constructor({ onAudio, onError, isAborted }) {
    this.onAudio = onAudio;
    this.onError = onError;
    this.isAborted = isAborted;
    this.items = [];
    this.running = false;
    this.closed = false;
    this.seq = 0;
    this.waiters = [];
  }

  push(sentence) {
    const s = String(sentence || '').trim();
    if (!s) return;
    // 太短的口水句并入下一句，避免碎成一两个字
    if (s.length < 4 && this.items.length) {
      this.items[this.items.length - 1] += s;
      this._kick();
      return;
    }
    this.items.push(s);
    this._kick();
  }

  close() {
    this.closed = true;
    if (!this.running && !this.items.length) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  _done() {
    if (!this.closed || this.running || this.items.length) return;
    const ws = this.waiters.splice(0);
    ws.forEach((w) => w());
  }

  async _kick() {
    if (this.running) return;
    this.running = true;
    while (this.items.length) {
      if (this.isAborted()) {
        this.items.length = 0;
        break;
      }
      const text = this.items.shift();
      try {
        dbg && dbg('tts start', text.slice(0, 20));
        const buf = await tts.speak(text);
        dbg && dbg('tts done', text.slice(0, 20), buf && buf.length);
        if (this.isAborted()) break;
        if (buf && buf.length) this.onAudio({ seq: this.seq++, text, buffer: buf });
      } catch (err) {
        this.onError(err);
      }
    }
    this.running = false;
    this._done();
  }
}

let activeId = 0;
let aborted = false;

function abort() {
  aborted = true;
  activeId++;
}

/**
 * @param {object} input
 *   wavBuffer  Buffer|null 说话音频
 *   text       string|null 直接给文本（快捷键打字/测试）
 *   withVision boolean 是否随这次对话附上屏幕截图
 *   onEvent    (type, payload) => void
 * @returns {Promise<{text:string, transcript:string}>}
 */
async function run(input = {}) {
  const { onEvent = () => {} } = input;
  const myId = ++activeId;
  aborted = false;
  const isAborted = () => aborted || myId !== activeId;

  const cfg = config.get();
  const game = input.game || '';
  const fullscreen = !!input.fullscreen;
  dbg('run start', { text: String(input.text || '').slice(0, 30), withVision: !!input.withVision });

  // 1. 识别
  let transcript = '';
  if (input.wavBuffer && input.wavBuffer.length) {
    onEvent('state', { state: 'transcribing' });
    const t0 = Date.now();
    const r = await asr.recognize(input.wavBuffer);
    transcript = r.text;
    onEvent('asr', { text: r.text, conf: r.conf, ms: Date.now() - t0 });
    if (!transcript) {
      onEvent('state', { state: 'idle' });
      return { text: '', transcript: '' };
    }
  } else {
    transcript = String(input.text || '').trim();
  }
  if (!transcript) {
    onEvent('state', { state: 'idle' });
    return { text: '', transcript: '' };
  }

  memory.addTurn('user', transcript, game ? { game } : {});

  // 2. 组装消息（可选附图）
  onEvent('state', { state: 'thinking' });
  let dataUrl = null;
  if (input.withVision && cfg.vision) {
    try {
      dataUrl = await vision.capture();
    } catch (err) {
      onEvent('warn', { message: `这次没能看到画面：${err.message}` });
    }
  }

  const messages = persona.buildMessages(cfg, { game, fullscreen, hasImage: !!dataUrl });
  dbg('messages built', messages.length);
  if (dataUrl) {
    messages.push(llm.buildVisionMessage(transcript, dataUrl));
  } else {
    messages.push({ role: 'user', content: transcript });
  }

  // 3. 流式回答 + 逐句合成
  let spoken = 0;
  const queue = new SpeechQueue({
    onAudio: (a) => {
      if (spoken++ === 0) onEvent('first-audio', { ms: Date.now() - t });
      onEvent('audio', { seq: a.seq, text: a.text, buffer: a.buffer });
    },
    onError: (err) => onEvent('warn', { message: `这句没念出来：${err.message}` }),
    isAborted,
  });

  let pending = '';
  const t = Date.now();
  let full = '';
  try {
    full = await llm.chatStream(messages, {
      temperature: 0.85,
      onDelta: (delta) => {
        if (isAborted()) return;
        onEvent('delta', { text: delta });
        pending += delta;
        let m;
        while ((m = END_RE.exec(pending))) {
          const cut = m.index + 1;
          queue.push(pending.slice(0, cut));
          pending = pending.slice(cut);
        }
      },
    });
  } catch (err) {
    aborted = true;
    onEvent('state', { state: 'idle' });
    throw err;
  }

  full = (full || '').trim();
  dbg('llm done', full.length);
  if (pending.trim()) queue.push(pending.trim());
  await queue.close();
  dbg('queue closed');

  if (full) memory.addTurn('assistant', full, game ? { game } : {});
  onEvent('reply', { text: full });
  onEvent('state', { state: 'idle' });
  onEvent('timing', { totalMs: Date.now() - t });
  return { text: full, transcript };
}

module.exports = { run, abort };