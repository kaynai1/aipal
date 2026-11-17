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
let running = false;

/** 观战模式：模型可以回「不说」表示这帧不评论 */
function isSilentReply(t) {
  const s = String(t || '').replace(/[\s。．·，,、!！?？…~～（）()「」『』""'']/g, '');
  if (!s) return true;
  return ['不说', '沉默', '无', '没有', '没什么', '没什么好说的', '这帧不说'].includes(s);
}

function abort() {
  aborted = true;
  activeId++;
}

function isBusy() {
  return running;
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
  running = true;
  const isAborted = () => aborted || myId !== activeId;
  try {
    return await runTurn(input, myId, isAborted, onEvent);
  } finally {
    if (myId === activeId) running = false;
  }
}

async function runTurn(input, myId, isAborted, onEvent) {

  const cfg = config.get();
  const game = input.game || '';
  const fullscreen = !!input.fullscreen;
  const silent = !!input.silent; // 主动开口：不是用户说的话，不上屏、不记为用户发言
  dbg('run start', { text: String(input.text || '').slice(0, 30), withVision: !!input.withVision, silent });

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

  if (!silent) memory.addTurn('user', transcript, game ? { game } : {});

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

  const messages = persona.buildMessages(cfg, {
    game,
    fullscreen,
    hasImage: !!dataUrl,
    proactive: silent,
    watch: !!input.watch,
    watchChatty: input.watchChatty || '',
    playMinutes: memory.playMinutes(),
  });
  dbg('messages built', messages.length);
  if (dataUrl) {
    messages.push(llm.buildVisionMessage(transcript, dataUrl));
  } else {
    messages.push({ role: 'user', content: transcript });
  }

  // 观战模式：先把整段回答收完再决定说不说（模型可以回「不说」）
  const bufferAll = !!input.watch;

  // 3. 流式回答 + 逐句合成
  let spoken = 0;
  const makeQueue = () =>
    new SpeechQueue({
      onAudio: (a) => {
        if (spoken++ === 0) onEvent('first-audio', { ms: Date.now() - t });
        onEvent('audio', { seq: a.seq, text: a.text, buffer: a.buffer });
      },
      onError: (err) => onEvent('warn', { message: `这句没念出来：${err.message}` }),
      isAborted,
    });
  const queue = bufferAll ? null : makeQueue();

  let pending = '';
  const t = Date.now();
  let full = '';
  try {
    full = await llm.chatStream(messages, {
      temperature: 0.85,
      onFallback: () => onEvent('warn', { message: '主接口没通，正在用备用接口重试' }),
      onDelta: (delta) => {
        if (isAborted()) return;
        if (bufferAll) return; // 观战：先收完再判断，不边收边念
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

  if (bufferAll) {
    // 观战沉默判定：模型回了「不说」就什么都不干
    if (isSilentReply(full)) {
      dbg('watch silent');
      onEvent('state', { state: 'idle' });
      return { text: '', transcript: '', quiet: true };
    }
    const q = makeQueue();
    for (const s of tts.splitSentences(full)) q.push(s);
    await q.close();
  } else {
    if (pending.trim()) queue.push(pending.trim());
    await queue.close();
  }
  dbg('queue closed');

  if (full) memory.addTurn('assistant', full, game ? { game } : {});

  // 粗略计一下今天往外发了多少（字数 + 张图），给“上传透明度”用
  try {
    const st = config.get().stats || {};
    const today = new Date().toISOString().slice(0, 10);
    const next = st.day === today
      ? { day: today, chars: (st.chars || 0) + full.length + transcript.length, images: (st.images || 0) + (dataUrl ? 1 : 0) }
      : { day: today, chars: full.length + transcript.length, images: dataUrl ? 1 : 0 };
    config.save({ stats: next });
  } catch {}

  onEvent('reply', { text: full });
  onEvent('state', { state: 'idle' });
  onEvent('timing', { totalMs: Date.now() - t });
  return { text: full, transcript };
}

module.exports = { run, abort, isBusy };