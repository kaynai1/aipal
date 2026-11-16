'use strict';

/**
 * 大模型对话（OpenAI 兼容 /chat/completions，支持流式与图片输入）
 * 默认指向硅基流动，可换成任何兼容接口（中转站、Ollama、火山方舟等）。
 */

const config = require('./config');

function options() {
  const c = config.get().llm;
  return {
    base: String(c.baseUrl || '').trim().replace(/\/+$/, ''),
    key: String(c.apiKey || '').trim(),
    model: String(c.model || '').trim(),
    temperature: typeof c.temperature === 'number' ? c.temperature : 0.85,
    maxTokens: Number(c.maxTokens) || 160,
  };
}

const UA = 'AIPal/0.1.0 (+https://localhost)';

function headers(o) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    ...(o.key ? { Authorization: `Bearer ${o.key}` } : {}),
  };
}

/** 把常见状态码翻成人话，并给下一步动作 */
function explain(status, body) {
  const raw = String(body || '').slice(0, 300);
  const tail = raw ? `｜接口原文：${raw}` : '';
  if (status === 401 || status === 403) {
    return `密钥无效或被吊销。检查 Key 是否完整（一般 sk- 开头），或到中转站重新生成一把${tail}`;
  }
  if (status === 402) return `账户额度/积分不足${tail}`;
  if (status === 404) return `模型不存在或未启用。点「拉取可用模型」挑一个真实可用的，别手填${tail}`;
  if (status === 429) return `该模型当前没有可用线路或触发限流，换个模型或过一会再试${tail}`;
  if (status === 400) return `请求被拒，最常见原因是模型名不对或该模型不支持对话${tail}`;
  if (status === 413) return `请求体太大（附带的截图太大）${tail}`;
  if (status >= 500) return `中转站/上游服务出错了（${status}），不是你的配置问题，稍后重试${tail}`;
  return `接口返回 ${status}${tail}`;
}

function ensure() {
  const o = options();
  if (!o.base) throw Object.assign(new Error('还没有填写大模型接口地址（设置 → 大脑）'), { code: 'E_LLM_URL' });
  if (!o.key && !/localhost|127\.0\.0\.1/.test(o.base)) {
    throw Object.assign(new Error('还没有填写大模型 Key（设置 → 大脑）'), { code: 'E_LLM_KEY' });
  }
  if (!o.model) throw Object.assign(new Error('还没有填写模型名（设置 → 大脑）'), { code: 'E_LLM_MODEL' });
  return o;
}

/**
 * 流式对话。onDelta(text) 边生成边回调；返回完整文本。
 * 主接口失败且配置了备用接口时，自动用备用接口重试一次（只在还没吐出任何字时）。
 */
async function chatStream(messages, opts = {}) {
  const o = ensure();
  try {
    return await streamOnce(o, messages, opts);
  } catch (err) {
    const fb = fallbackOptions();
    if (!fb || /没有填写|还没有填写/.test(String(err.message))) throw err;
    if (opts.__triedFallback) throw err;
    if (opts.__spoke) throw err; // 已经吐过字就不重试，避免重复播报
    const note = typeof opts.onFallback === 'function' ? opts.onFallback : null;
    if (note) note(err);
    return await streamOnce(fb, messages, { ...opts, __triedFallback: true });
  }
}

function fallbackOptions() {
  const c = config.get().llmFallback || {};
  const base = String(c.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(c.model || '').trim();
  if (!base || !model) return null;
  return {
    base,
    key: String(c.apiKey || '').trim(),
    model,
    temperature: 0.85,
    maxTokens: 160,
  };
}

async function streamOnce(o, messages, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 60000);

  let res;
  try {
    res = await fetch(`${o.base}/chat/completions`, {
      method: 'POST',
      headers: headers(o),
      body: JSON.stringify({
        model: o.model,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : o.temperature,
        max_tokens: opts.maxTokens || o.maxTokens,
        stream: true,
        messages,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('大模型响应超时');
    throw new Error(`连不上大模型接口：${err.message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    clearTimeout(timer);
    throw Object.assign(new Error(explain(res.status, body)), {
      code: 'E_LLM_HTTP',
      status: res.status,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  let full = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json = null;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta =
          (json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content) || '';
        if (delta) {
          full += delta;
          opts.__spoke = true;
          if (opts.onDelta) opts.onDelta(delta);
        }
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      reader.cancel();
    } catch {}
  }

  return full.trim();
}

function buildVisionMessage(text, dataUrl) {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
    ],
  };
}

async function check() {
  const o = options();
  if (!o.base) return { ok: false, message: '请先填写接口地址' };
  if (!o.key && !/localhost|127\.0\.0\.1/.test(o.base)) return { ok: false, message: '请先填写 Key' };
  if (!o.model) return { ok: false, message: '请先填写模型名，或点「拉取可用模型」选一个' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(`${o.base}/chat/completions`, {
      method: 'POST',
      headers: headers(o),
      body: JSON.stringify({
        model: o.model,
        messages: [{ role: 'user', content: '回复两个字：在的' }],
        max_tokens: 32,
        stream: false,
      }),
      signal: ctrl.signal,
    });
    const body = await res.text();

    if (!res.ok) {
      return { ok: false, status: res.status, message: explain(res.status, body) };
    }

    let j = null;
    try {
      j = JSON.parse(body);
    } catch {
      return { ok: false, message: `接口返回的不是 JSON，可能地址少了 /v1 或该地址不是 OpenAI 兼容接口｜原文：${body.slice(0, 200)}` };
    }
    const t =
      (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) ||
      (j.choices && j.choices[0] && j.choices[0].text) ||
      '';
    if (!String(t).trim()) {
      return {
        ok: false,
        message: `接口连通但没返回内容，可能是模型名不存在或被禁用｜原文：${body.slice(0, 200)}`,
      };
    }
    return { ok: true, message: `连通正常，${o.model} 回复：${String(t).trim().slice(0, 20)}` };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, message: '连接超时（30 秒）。检查网络，或这个中转站是不是需要代理' };
    const m = String(err.message || err);
    if (/ENOTFOUND|getaddrinfo/.test(m)) return { ok: false, message: `域名解析失败：${o.base} 打不开，检查地址拼写或 DNS` };
    if (/ECONNREFUSED/.test(m)) return { ok: false, message: `连接被拒：${o.base} 没有在监听，检查端口/地址` };
    if (/certificate|SSL|TLS/i.test(m)) return { ok: false, message: `HTTPS 证书有问题：${m}` };
    return { ok: false, message: `请求失败：${m}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉取该接口真实的模型清单（GET /models）。
 * 手填模型名最容易踩坑，这里直接给后端要一份。
 */
async function listModels() {
  const o = options();
  if (!o.base) return { ok: false, message: '请先填写接口地址' };
  if (!o.key && !/localhost|127\.0\.0\.1/.test(o.base)) return { ok: false, message: '请先填写 Key，拉模型清单需要鉴权' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${o.base}/models`, {
      method: 'GET',
      headers: headers(o),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, status: res.status, message: explain(res.status, body) };

    let j = null;
    try {
      j = JSON.parse(body);
    } catch {
      return { ok: false, message: `模型清单不是 JSON，检查地址是否只填到 /v1｜原文：${body.slice(0, 160)}` };
    }
    const raw =
      (Array.isArray(j.data) && j.data) ||
      (Array.isArray(j.models) && j.models) ||
      (Array.isArray(j) && j) ||
      [];
    const models = raw
      .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name || m.model)))
      .map((s) => String(s || '').trim())
      .filter(Boolean);

    const uniq = Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
    if (!uniq.length) {
      return { ok: false, message: '接口返回的清单是空的，可能这个服务不提供 /models，手动填模型名吧' };
    }
    return { ok: true, models: uniq, count: uniq.length, current: o.model };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, message: '拉取模型清单超时（20 秒）' };
    return { ok: false, message: `拉取失败：${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chatStream, buildVisionMessage, check, listModels, options };