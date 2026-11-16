'use strict';

/**
 * 语音合成
 *  - edge：微软 Edge 朗读接口，免费、无需 Key，中文多音色，断网不可用（有缓存兜底）
 *  - api ：兼容 OpenAI /audio/speech 的任意接口
 *
 * 设计要点：
 *  1. 连接复用。edge 首次握手要 2~3 秒，每次重连会让"回答"慢半拍，所以实例常驻。
 *  2. 分句流式。长回答按标点切句，逐句合成推送，第一句先出声。
 */

const config = require('./config');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

class EdgeSpeaker {
  constructor() {
    this.instances = new Map(); // voice -> { tts, readyAt }
  }

  async _get(voice) {
    const hit = this.instances.get(voice);
    if (hit && hit.ok) return hit.tts;
    const tts = new MsEdgeTTS({ connectionTimeoutMs: 15000, synthesisTimeoutMs: 30000 });
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    this.instances.set(voice, { tts, ok: true });
    return tts;
  }

  async speak(text, opts = {}) {
    const cfg = config.get();
    const voice = opts.voice || cfg.tts.voice || 'zh-CN-XiaoxiaoNeural';
    const prosody = {
      rate: opts.rate || cfg.tts.rate || '+0%',
      pitch: opts.pitch || cfg.tts.pitch || '+0Hz',
      volume: '+0%',
    };
    const safe = escapeXml(String(text).trim());
    if (!safe) return Buffer.alloc(0);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const tts = await this._get(voice);
        const buf = await this._collect(tts, safe, prosody);
        if (buf.length > 100) return buf;
        throw new Error('合成结果为空');
      } catch (err) {
        // 连接可能失效：丢弃实例，重试一次
        this.instances.delete(voice);
        if (attempt === 1) throw new Error(`语音合成失败：${err.message}`);
      }
    }
    return Buffer.alloc(0);
  }

  _collect(tts, text, prosody) {
    return new Promise((resolve, reject) => {
      let stream;
      try {
        stream = tts.toStream(text, prosody).audioStream;
      } catch (err) {
        reject(err);
        return;
      }
      const chunks = [];
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(Buffer.concat(chunks));
      };
      const timer = setTimeout(() => done(new Error('合成超时（20 秒）')), 20000);
      stream.on('data', (d) => {
        if (Buffer.isBuffer(d)) chunks.push(d);
        else if (d && d.data) chunks.push(Buffer.from(d.data));
      });
      stream.on('error', (e) => done(e));
      stream.on('close', () => done(null));
      stream.on('end', () => done(null));
    });
  }

  warmup() {
    const voice = config.get().tts.voice || 'zh-CN-XiaoxiaoNeural';
    return this._get(voice)
      .then(() => this._collect(this.instances.get(voice).tts, '嗯', { rate: '+0%', pitch: '+0Hz', volume: '+0%' }))
      .catch(() => {});
  }

  reset() {
    for (const v of this.instances.values()) {
      try {
        v.tts.close();
      } catch {}
    }
    this.instances.clear();
  }
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const edge = new EdgeSpeaker();

/* ---------------- 兼容 OpenAI 的自定义 TTS ---------------- */
async function apiSpeak(text) {
  const cfg = config.get();
  const o = cfg.tts;
  if (!o.baseUrl) throw new Error('还没有填写语音合成接口地址');
  if (!o.apiKey) throw new Error('还没有填写语音合成的 Key');
  const base = String(o.baseUrl).replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify({
        model: o.model || 'tts-1',
        input: text,
        voice: o.voice || 'alloy',
        response_format: 'mp3',
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`语音合成接口返回 ${res.status}：${t.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('语音合成超时（30 秒）');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function speak(text) {
  const cfg = config.get();
  if (cfg.tts.provider === 'api') return apiSpeak(text);
  return edge.speak(text);
}

/** 把一段话切成适合逐句合成的片段 */
function splitSentences(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];
  const parts = clean.match(/[^。！？!?…；;\n]+[。！？!?…；;\n]?/g) || [clean];
  const out = [];
  for (const raw of parts) {
    let s = raw.trim();
    if (!s) continue;
    while (s.length > 45) {
      let cut = -1;
      for (let i = Math.min(44, s.length - 1); i > 8; i--) {
        if ('，,、'.includes(s[i])) {
          cut = i;
          break;
        }
      }
      if (cut < 0) cut = 42;
      out.push(s.slice(0, cut + 1));
      s = s.slice(cut + 1);
    }
    if (s) out.push(s);
  }
  return out;
}

async function check() {
  const cfg = config.get();
  if (cfg.tts.provider === 'api') {
    if (!cfg.tts.baseUrl || !cfg.tts.apiKey) return { ok: false, message: '请先填写语音合成接口地址与 Key' };
    return { ok: true, message: '已配置云端语音合成（播报时才真正请求）' };
  }
  try {
    const buf = await edge.speak('在的');
    if (buf.length > 100) return { ok: true, message: `Edge 免费语音已就绪（音色 ${cfg.tts.voice}）` };
    return { ok: false, message: '语音合成返回为空，检查网络或换一个音色' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { speak, splitSentences, check, edge };