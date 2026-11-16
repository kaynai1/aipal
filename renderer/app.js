'use strict';

const $ = (id) => document.getElementById(id);
const bridge = window.api;

const S = {
  cfg: null,
  game: null,
  rec: false,
  busy: false,
  auto: false,
  vision: true,
  muted: false,

  ctx: null,
  stream: null,
  node: null,
  srcRate: 48000,
  chunks: [],
  frames: 0,

  vad: { speaking: false, quiet: 0, loud: 0, noise: 0.006 },

  play: { queue: [], audio: null, playing: false },

  lastLevelAt: 0,
  status: 'idle',
  compact: true,
  idleTimer: null,
};

const H_COMPACT = 186;
const H_EXPAND = 520;

function setCompact(on) {
  const card = $('card');
  card.classList.toggle('mini', on);
  if (S.compact === on) return;
  S.compact = on;
  bridge.win.size(on ? H_COMPACT : H_EXPAND);
}

function expandAndHold() {
  setCompact(false);
  if (S.idleTimer) clearTimeout(S.idleTimer);
  S.idleTimer = setTimeout(() => {
    if (!S.busy && !S.rec && !S.play.playing) setCompact(true);
  }, 45000);
}

/* ---------------- 状态与界面 ---------------- */

const STATUS_TEXT = {
  idle: '在等你开局',
  listening: '听着呢，说',
  transcribing: '在听清你说什么…',
  thinking: '让我想想',
  speaking: '正在回你',
  error: '出了点问题',
};

function micLabel() {
  if (S.rec) return '说完了，点一下结束';
  if (S.busy) return '打断她';
  if (!ready()) return '配置模型';
  return '跟我说话';
}

function setStatus(state, text) {
  S.status = state;
  document.body.dataset.state = state;
  const dot = $('dot');
  dot.className = 'dot';
  if (state === 'listening') dot.classList.add('live');
  else if (state === 'transcribing' || state === 'thinking') dot.classList.add('think');
  else if (state === 'speaking') dot.classList.add('speak');
  else if (state === 'error') dot.classList.add('bad');

  const base = text || STATUS_TEXT[state] || '';
  $('status').textContent = state === 'idle' && !ready() ? '未配置模型' : base;

  const mic = $('btnMic');
  mic.classList.toggle('rec', S.rec);
  mic.classList.toggle('dim', false);
  $('micTxt').textContent = micLabel();
}

function shortGame(t) {
  if (!t) return '';
  return t.length > 16 ? t.slice(0, 16) + '…' : t;
}

function setHint(text, kind) {
  const h = $('hint');
  h.textContent = text || '';
  h.className = 'hint' + (kind ? ' ' + kind : '');
}

function ready() {
  const c = S.cfg;
  if (!c) return false;
  const llmOk =
    c.llm.baseUrl && (c.llm.hasKey || c.llm.apiKey || /localhost|127\.0\.0\.1/.test(c.llm.baseUrl));
  return !!(llmOk && c.llm.model);
}

function setWave(on) {
  $('wave').classList.toggle('on', !!on);
  if (!on) {
    document.querySelectorAll('#wave i').forEach((el) => (el.style.height = '3px'));
    document.documentElement.style.setProperty('--level', '0');
  }
}

function driveWave(level) {
  document.documentElement.style.setProperty('--level', Math.min(1, level).toFixed(3));
  const bars = document.querySelectorAll('#wave i');
  const n = bars.length;
  for (let i = 0; i < n; i++) {
    const center = 1 - Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
    const h = 3 + Math.min(20, level * 340 * (0.4 + center * 0.9));
    bars[i].style.height = `${h.toFixed(1)}px`;
  }
}

function showMe(text) {
  if (!text) return;
  const b = $('meBubble');
  b.hidden = false;
  b.textContent = text;
  expandAndHold();
}

function aiBubble(clear) {
  const b = $('aiBubble');
  b.classList.remove('caret');
  if (clear) b.textContent = '';
  return b;
}

function appendAI(delta) {
  const b = $('aiBubble');
  if (b.querySelector('.ghost')) b.textContent = '';
  b.textContent += delta;
  b.classList.add('caret');
  expandAndHold();
  scrollTalk();
}

function scrollTalk() {
  const t = $('talkArea');
  t.scrollTop = t.scrollHeight;
}

/* ---------------- 音频采集 ---------------- */

async function ensureAudio() {
  if (S.ctx) {
    if (S.ctx.state === 'suspended') await S.ctx.resume();
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  node.port.onmessage = (e) => onFrame(e.data);
  src.connect(node);
  S.ctx = ctx;
  S.stream = stream;
  S.srcRate = ctx.sampleRate;
  S.node = node;
}

function rmsOf(f) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / f.length);
}

function onFrame(f) {
  S.frames++;
  const rms = rmsOf(f);

  if (S.rec) {
    S.chunks.push(f);
    const now = performance.now();
    if (now - S.lastLevelAt > 55) {
      S.lastLevelAt = now;
      driveWave(Math.min(1, rms * 9));
    }
    return;
  }

  if (!S.auto || S.busy || S.muted || S.play.playing) {
    if (S.auto && (S.busy || S.play.playing)) S.vad.speaking = false;
    if (S.play.playing) driveWave(Math.random() * 0.55 + 0.2);
    return;
  }

  const v = S.vad;
  const thr = Math.min(0.05, Math.max(0.008, v.noise * 3.2));

  if (rms > thr) {
    v.loud++;
    v.quiet = 0;
    if (!v.speaking && v.loud >= 4) {
      v.speaking = true;
      startCapture();
      setStatus('listening');
    }
  } else {
    v.quiet++;
    v.loud = 0;
    if (v.speaking && v.quiet >= 26) {
      v.speaking = false;
      finishCapture(true);
    } else if (!v.speaking) {
      // 底噪缓慢跟随，避免空调声把阈值抬高或压死
      v.noise = v.noise * 0.96 + rms * 0.04;
    }
  }

  const now = performance.now();
  if (now - S.lastLevelAt > 55) {
    S.lastLevelAt = now;
    driveWave(v.speaking ? Math.min(1, rms * 9) : Math.min(0.5, rms * 14));
  }
}

function startCapture() {
  S.chunks = [];
  S.rec = true;
  S.vad.loud = 0;
  S.vad.quiet = 0;
  expandAndHold();
  setWave(true);
  setStatus('listening');
  refreshMic();
}

function finishCapture(auto) {
  if (!S.rec) return;
  S.rec = false;
  const chunks = S.chunks;
  S.chunks = [];
  setWave(false);

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const secs = total / S.srcRate;
  if (secs < 0.35) {
    setStatus('idle');
    setHint('太短了，没听清', 'warn');
    refreshMic();
    return;
  }
  const wav = encodeWav(chunks, S.srcRate);
  sendTurn(wav, false);
  refreshMic();
}

function refreshMic() {
  const mic = $('btnMic');
  mic.classList.toggle('rec', S.rec);
  $('micTxt').textContent = micLabel();
}

function encodeWav(chunks, srcRate) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }

  const target = 16000;
  const ratio = srcRate / target;
  const outLen = Math.max(1, Math.floor(total / ratio));
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, total - 1);
    const frac = pos - i0;
    let v = merged[i0] * (1 - frac) + merged[i1] * frac;
    v = Math.max(-1, Math.min(1, v));
    pcm[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }

  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const wstr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, target, true);
  view.setUint32(28, target * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wstr(36, 'data');
  view.setUint32(40, dataSize, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

function wavFromSilence(ms) {
  const n = Math.round(16000 * (ms / 1000));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    pcm[i] = Math.round(Math.sin((i / 16000) * 2 * Math.PI * 220) * 6000 * (1 - i / n));
  }
  const dataSize = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const wstr = (o, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  wstr(36, 'data');
  view.setUint32(40, dataSize, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/* ---------------- 回合 ---------------- */

async function sendTurn(wavOrText, isText) {
  if (!ready()) {
    setHint('先去设置里填大模型接口和 Key，不然她没法开口', 'bad');
    setStatus('error');
    bridge.win.openSettings();
    return;
  }
  if (S.busy) bridge.turn.abort();

  S.busy = true;
  try {
    S.muted = false;
    expandAndHold();
    aiBubble(true);
    setStatus('thinking');
    setHint('');
    refreshMic();

    const payload = isText
      ? { text: wavOrText, withVision: S.vision }
      : { audio: wavOrText, withVision: S.vision };

    await bridge.turn.start(payload);
  } catch (err) {
    setStatus('error');
    setHint(`发送失败：${err && err.message}`, 'bad');
  } finally {
    S.busy = false;
    refreshMic();
    if (!S.play.playing) setStatus('idle');
  }
}

function enqueueAudio(arrayBuffer) {
  const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  S.play.queue.push(url);
  if (!S.play.playing) nextAudio();
}

function nextAudio() {
  const url = S.play.queue.shift();
  if (!url) {
    S.play.playing = false;
    S.muted = false;
    setWave(false);
    if (!S.busy) setStatus('idle');
    return;
  }
  S.play.playing = true;
  S.muted = true;
  setStatus('speaking');
  setWave(true);

  const a = new Audio(url);
  S.play.audio = a;
  const done = () => {
    URL.revokeObjectURL(url);
    if (S.play.audio === a) S.play.audio = null;
    nextAudio();
  };
  a.onended = done;
  a.onerror = done;
  a.play().catch(() => done());
}

function stopPlayback() {
  for (const u of S.play.queue) URL.revokeObjectURL(u);
  S.play.queue = [];
  if (S.play.audio) {
    try {
      S.play.audio.pause();
      S.play.audio.src = '';
    } catch {}
    S.play.audio = null;
  }
  S.play.playing = false;
  S.muted = false;
  setWave(false);
}

/* ---------------- 交互 ---------------- */

async function toggleRecord() {
  if (!ready()) {
    setHint('先在设置里填模型接口和 Key', 'warn');
    bridge.win.openSettings('brain');
    return;
  }
  if (S.rec) {
    finishCapture(false);
    return;
  }
  try {
    await ensureAudio();
  } catch (err) {
    setHint(`麦克风打不开：${err.message}`, 'bad');
    return;
  }
  if (S.busy || S.play.playing) {
    stopPlayback();
    bridge.turn.abort();
    S.busy = false;
  }
  startCapture();
}

function bind() {
  $('btnMic').addEventListener('click', toggleRecord);
  $('btnSettings').addEventListener('click', () => bridge.win.openSettings());
  $('btnUpdate').addEventListener('click', () => bridge.win.openSettings('upd'));
  $('btnHide').addEventListener('click', () => bridge.win.hide());

  $('chipVision').addEventListener('click', async () => {
    S.vision = !S.vision;
    $('chipVision').classList.toggle('on', S.vision);
    await bridge.config.save({ vision: S.vision });
    setHint(S.vision ? '下次说话会顺手看一眼屏幕' : '不看屏幕了，只靠语音');
  });

  $('chipAuto').addEventListener('click', async () => {
    S.auto = !S.auto;
    $('chipAuto').classList.toggle('on', S.auto);
    await bridge.config.save({ trigger: S.auto ? 'both' : 'hotkey' });
    if (S.auto) {
      try {
        await ensureAudio();
      } catch (err) {
        S.auto = false;
        $('chipAuto').classList.remove('on');
        setHint(`麦克风打不开：${err.message}`, 'bad');
      }
    }
    setHint(S.auto ? '自动听已开：直接说话就行' : '自动听已关，用热键说话');
  });

  bridge.on.hotkey(() => toggleRecord());

  bridge.on.turnEvent(({ type, data }) => {
    if (type === 'state') {
      const st = data.state;
      if (st === 'transcribing') setStatus('transcribing');
      else if (st === 'thinking') setStatus('thinking');
      else if (st === 'idle') {
        const b = $('aiBubble');
        b.classList.remove('caret');
        if (!S.play.playing) setStatus('idle');
      }
    } else if (type === 'asr') {
      showMe(data.text);
      scrollTalk();
    } else if (type === 'delta') {
      appendAI(data.text);
    } else if (type === 'reply') {
      const b = $('aiBubble');
      b.classList.remove('caret');
      if (data.text) b.textContent = data.text;
      scrollTalk();
    } else if (type === 'first-audio') {
      setHint(`从说完到出声 ${(data.ms / 1000).toFixed(1)} 秒`);
    } else if (type === 'warn') {
      setHint(data.message, 'warn');
    } else if (type === 'error') {
      setStatus('error');
      setHint(data.message, 'bad');
      setTimeout(() => {
        if (S.status === 'error') setStatus('idle');
      }, 6000);
    }
  });

  bridge.on.turnAudio(({ buffer }) => enqueueAudio(buffer));

  bridge.on.game((g) => {
    S.game = g;
    if (g && g.game) {
      const pill = $('gamePill');
      pill.hidden = false;
      pill.textContent = shortGame(g.game);
    } else {
      $('gamePill').hidden = true;
    }
    if (S.status === 'idle') setStatus('idle');
  });

  bridge.on.warn((w) => setHint(w.message, 'warn'));

  bridge.on.config((cfg) => {
    S.cfg = cfg;
    applyConfigToUI();
  });

  bridge.on.toggleWindow(() => bridge.win.show());

  bridge.on.updateAvailable((u) => {
    const b = $('btnUpdate');
    b.hidden = false;
    b.title = `有新版本 v${u.latest}，点这里更新`;
    b.classList.add('update');
  });
}

function applyConfigToUI() {
  const c = S.cfg;
  if (!c) return;
  $('pname').textContent = c.persona.name || '小满';
  S.vision = c.vision !== false;
  S.auto = c.trigger !== 'hotkey';
  $('chipVision').classList.toggle('on', S.vision);
  $('chipAuto').classList.toggle('on', S.auto);
  setStatus(S.status);
  if (!ready()) setHint('还没填大模型接口，去设置里配一下', 'warn');
  else if (S.auto) setHint(`自动听已开 · 热键 ${c.hotkey} 可随时抢话`);
  else setHint(`热键 ${c.hotkey} 说话 · 也可以点下面的按钮`);
}

async function init() {
  const init = await bridge.init();
  S.cfg = init.config;
  S.game = init.game;
  bind();
  applyConfigToUI();

  if (init.memory && init.memory.lastReply) {
    const b = $('aiBubble');
    b.textContent = '';
    const g = document.createElement('span');
    g.className = 'ghost';
    g.textContent = `上次：${init.memory.lastReply.text}`;
    b.appendChild(g);
  }

  if (S.auto) {
    try {
      await ensureAudio();
    } catch (err) {
      setHint(`麦克风打不开：${err.message}`, 'bad');
    }
  }
  if (S.game && S.game.game) {
    $('gamePill').hidden = false;
    $('gamePill').textContent = shortGame(S.game.game);
  }
}

// 调试/自动化入口（不影响正常使用）
window.__aipal = { sendTurn, toggleRecord, wavFromSilence, get state() { return S; } };

init().catch((err) => {
  setHint(`启动失败：${err.message}`, 'bad');
});