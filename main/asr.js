'use strict';

/**
 * 语音识别
 *  - sapi：本机 Windows 离线识别，常驻 PowerShell 进程，免费、无 Key、断网可用
 *  - api ：兼容 OpenAI /audio/transcriptions 的任意接口（需要填 base + key + model）
 *
 * 输入统一是 16kHz / 16bit / 单声道 WAV 的 Buffer。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const HELPER = path.join(__dirname, '..', 'helpers', 'sapi-asr.ps1');

/* ---------------- 本机离线识别（常驻进程） ---------------- */
class SapiRecognizer {
  constructor() {
    this.proc = null;
    this.buf = '';
    this.pending = null;
    this.ready = false;
    this.starting = null;
    this.lastError = '';
  }

  _resolve(line) {
    const p = this.pending;
    this.pending = null;
    if (!p) return;
    clearTimeout(p.timer);
    let json = null;
    try {
      json = JSON.parse(line);
    } catch {
      p.reject(new Error(`识别进程返回了无法解析的内容：${line.slice(0, 120)}`));
      return;
    }
    if (json.ready) {
      this.ready = true;
      p.resolve(json);
      return;
    }
    if (json.fatal) {
      this.lastError = json.error || '识别引擎启动失败';
      p.reject(new Error(this.lastError));
      return;
    }
    if (!json.ok) {
      p.reject(new Error(json.error || '识别失败'));
      return;
    }
    p.resolve({ text: String(json.text || '').trim(), conf: Number(json.conf) || 0 });
  }

  start() {
    if (this.proc && this.ready) return Promise.resolve();
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER];
      let proc;
      try {
        proc = spawn(ps, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        this.starting = null;
        reject(new Error(`无法启动本机识别进程：${err.message}`));
        return;
      }
      this.proc = proc;
      this.buf = '';

      const timer = setTimeout(() => {
        this.starting = null;
        if (this.pending) {
          this.pending.reject(new Error('本机识别进程启动超时（3 秒无响应）'));
          this.pending = null;
        }
        reject(new Error('本机识别进程启动超时'));
      }, 20000);

      this.pending = {
        resolve: (json) => {
          clearTimeout(timer);
          this.starting = null;
          resolve(json);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.starting = null;
          reject(err);
        },
        timer: null,
      };

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        this.buf += chunk;
        let idx;
        while ((idx = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (line) this._resolve(line);
        }
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => {
        this.lastError = String(d).slice(0, 300);
      });

      proc.on('exit', () => {
        this.proc = null;
        this.ready = false;
        if (this.pending) {
          this.pending.reject(new Error('本机识别进程意外退出'));
          this.pending = null;
        }
      });
    });

    return this.starting;
  }

  async recognize(wavBuffer) {
    if (!this.ready) await this.start();
    if (!this.proc) throw new Error('本机识别进程不可用');

    const b64 = wavBuffer.toString('base64');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error('本机识别超时（8 秒），已自动重启识别进程'));
        try {
          this.proc && this.proc.kill();
        } catch {}
      }, 8000);
      this.pending = { resolve, reject, timer };
      try {
        this.proc.stdin.write(b64 + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        reject(new Error(`写入识别进程失败：${err.message}`));
      }
    });
  }

  stop() {
    try {
      this.proc && this.proc.stdin.write('\n');
      this.proc && this.proc.kill();
    } catch {}
    this.proc = null;
    this.ready = false;
  }
}

const sapi = new SapiRecognizer();

/* ---------------- 云端识别（OpenAI 兼容） ---------------- */
async function apiRecognize(wavBuffer, cfg) {
  const o = cfg.asr;
  if (!o.baseUrl) throw new Error('还没有填写语音识别的接口地址');
  if (!o.apiKey) throw new Error('还没有填写语音识别的 Key');
  const base = String(o.baseUrl).replace(/\/+$/, '');
  const url = `${base}/audio/transcriptions`;

  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', o.model || 'whisper-1');
  if (o.language) form.append('language', o.language);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}` },
      body: form,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`语音识别接口返回 ${res.status}：${text.slice(0, 200)}`);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { text: text.trim(), conf: 0 };
    }
    return { text: String(json.text || '').trim(), conf: 0 };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('语音识别超时（30 秒）');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function recognize(wavBuffer) {
  const cfg = config.get();
  if (cfg.asr.provider === 'api') return apiRecognize(wavBuffer, cfg);
  return sapi.recognize(wavBuffer);
}

async function check() {
  const cfg = config.get();
  if (cfg.asr.provider === 'api') {
    if (!cfg.asr.baseUrl || !cfg.asr.apiKey) return { ok: false, message: '请先填写语音识别接口地址与 Key' };
    return { ok: true, message: '已配置云端识别（发语音时才会真正请求）' };
  }
  try {
    await sapi.start();
    return { ok: true, message: '本机离线识别已就绪（免费、断网可用）' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { recognize, check, sapi, apiRecognize };