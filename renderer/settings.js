'use strict';

const $ = (id) => document.getElementById(id);
const bridge = window.api;

let cfg = null;
let voices = [];

/* ---------------- 导航 ---------------- */
$('nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sec]');
  if (!b) return;
  document.querySelectorAll('#nav button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.sec').forEach((s) => s.classList.toggle('on', s.dataset.sec === b.dataset.sec));
  if (b.dataset.sec === 'memory') loadMemory();
});

/* ---------------- 载入 ---------------- */
async function load() {
  const init = await bridge.init();
  cfg = init.config;
  $('ver').textContent = `v${init.version || '0.1.0'}`;
  if ($('curVer')) $('curVer').textContent = `v${init.version || '0.1.0'}`;
  if ($('updMeta')) $('updMeta').textContent = init.portable === false ? '当前版本 · 开发模式，不能自动替换' : '当前版本 · 便携版';

  voices = await bridge.voices();
  const sel = $('ttsVoice');
  sel.innerHTML = '';
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.label;
    sel.appendChild(o);
  }

  $('llmBase').value = cfg.llm.baseUrl || '';
  $('llmModel').value = cfg.llm.model || '';
  $('llmTemp').value = cfg.llm.temperature ?? 0.85;
  $('llmMax').value = cfg.llm.maxTokens ?? 160;
  setKeyHint('llmKeyHint', cfg.llm.hasKey);

  $('asrProv').value = cfg.asr.provider || 'sapi';
  $('asrBase').value = cfg.asr.baseUrl || '';
  $('asrModel').value = cfg.asr.model || '';
  setKeyHint('asrKeyHint', cfg.asr.hasKey);

  $('ttsProv').value = cfg.tts.provider || 'edge';
  $('ttsVoice').value = cfg.tts.voice || 'zh-CN-XiaoxiaoNeural';
  $('ttsRate').value = cfg.tts.rate || '+8%';
  $('ttsPitch').value = cfg.tts.pitch || '+0Hz';
  $('ttsBase').value = cfg.tts.baseUrl || '';
  $('ttsModel').value = cfg.tts.model || '';
  setKeyHint('ttsKeyHint', cfg.tts.hasKey);

  $('pName').value = cfg.persona.name || '';
  $('pCall').value = cfg.persona.callUser || '';
  $('pStyle').value = cfg.persona.style || '';

  $('hotkey').value = cfg.hotkey || 'F8';
  $('trigger').value = cfg.trigger || 'both';
  $('vision').checked = cfg.vision !== false;
  $('clickThrough').checked = !!cfg.clickThrough;
  $('memoryTurns').value = cfg.memoryTurns ?? 12;

  toggleBoxes();
}

function setKeyHint(id, hasKey) {
  const el = $(id);
  if (!el) return;
  el.textContent = hasKey ? '已保存过 Key，这里留空就不改' : '填一次就行，存在本机配置文件里';
}

function toggleBoxes() {
  $('asrApiBox').classList.toggle('on', $('asrProv').value === 'api');
  $('ttsApiBox').classList.toggle('on', $('ttsProv').value === 'api');
}

$('asrProv').addEventListener('change', toggleBoxes);
$('ttsProv').addEventListener('change', toggleBoxes);

/* ---------------- 保存 ---------------- */
function collect() {
  const patch = {
    llm: {
      baseUrl: $('llmBase').value.trim(),
      model: $('llmModel').value.trim(),
      temperature: Number($('llmTemp').value) || 0.85,
      maxTokens: Number($('llmMax').value) || 160,
    },
    asr: {
      provider: $('asrProv').value,
      baseUrl: $('asrBase').value.trim(),
      model: $('asrModel').value.trim(),
    },
    tts: {
      provider: $('ttsProv').value,
      voice: $('ttsVoice').value,
      rate: $('ttsRate').value.trim() || '+0%',
      pitch: $('ttsPitch').value.trim() || '+0Hz',
      baseUrl: $('ttsBase').value.trim(),
      model: $('ttsModel').value.trim(),
    },
    persona: {
      name: $('pName').value.trim() || '小满',
      callUser: $('pCall').value.trim() || '老板',
      style: $('pStyle').value.trim(),
    },
    hotkey: $('hotkey').value.trim() || 'F8',
    trigger: $('trigger').value,
    vision: $('vision').checked,
    clickThrough: $('clickThrough').checked,
    memoryTurns: Math.max(2, Math.min(40, Number($('memoryTurns').value) || 12)),
  };
  // 密钥：留空表示不修改
  if ($('llmKey').value.trim()) patch.llm.apiKey = $('llmKey').value.trim();
  if ($('asrKey').value.trim()) patch.asr.apiKey = $('asrKey').value.trim();
  if ($('ttsKey').value.trim()) patch.tts.apiKey = $('ttsKey').value.trim();
  return patch;
}

$('btnSave').addEventListener('click', async () => {
  try {
    cfg = await bridge.config.save(collect());
    $('llmKey').value = '';
    $('asrKey').value = '';
    $('ttsKey').value = '';
    setKeyHint('llmKeyHint', cfg.llm.hasKey);
    setKeyHint('asrKeyHint', cfg.asr.hasKey);
    setKeyHint('ttsKeyHint', cfg.tts.hasKey);
    tip('已保存，立刻生效', false);
  } catch (err) {
    tip(`保存失败：${err.message}`, true);
  }
});

$('btnReset').addEventListener('click', async () => {
  if (!confirm('恢复默认会清掉接口地址、Key 和人设，确定？')) return;
  cfg = await bridge.config.reset();
  await load();
  tip('已恢复默认', false);
});

$('btnDir').addEventListener('click', () => bridge.app.openConfigDir());

function tip(text, bad) {
  const el = $('saveTip');
  el.textContent = text;
  el.className = 'saveTip' + (bad ? ' bad' : '');
  clearTimeout(tip.t);
  tip.t = setTimeout(() => {
    el.textContent = '';
  }, 4000);
}

/* ---------------- 自检 ---------------- */
async function runCheck(kind) {
  const map = {
    asr: { badge: 'bAsr', desc: 'dAsr', btn: 'ckAsr', label: '检测识别', fn: bridge.check.asr },
    llm: { badge: 'bLlm', desc: 'dLlm', btn: 'ckLlm', label: '检测对话', fn: bridge.check.llm },
    tts: { badge: 'bTts', desc: 'dTts', btn: 'ckTts', label: '检测发声', fn: bridge.check.tts },
  }[kind];

  const badge = $(map.badge);
  const btn = $(map.btn);
  badge.textContent = '检测中';
  badge.className = 'badge busy';
  btn.disabled = true;
  btn.textContent = '检测中…';

  try {
    const r = await map.fn();
    badge.textContent = r.ok ? '通过' : '没通';
    badge.className = 'badge ' + (r.ok ? 'ok' : 'bad');
    const el = $(map.desc);
    el.textContent = r.message;
    el.style.color = r.ok ? '' : '#ff9b9b';
    if (!r.ok && kind === 'llm') $('modelTip').textContent = '先看上面的报错，再到下面「拉取可用模型」挑一个真实存在的';
  } catch (err) {
    badge.textContent = '没通';
    badge.className = 'badge bad';
    $(map.desc).textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = map.label;
  }
}

$('ckAsr').addEventListener('click', () => runCheck('asr'));
$('ckLlm').addEventListener('click', () => runCheck('llm'));
$('ckTts').addEventListener('click', () => runCheck('tts'));

/* ---------------- 拉取真实模型清单 ---------------- */
$('btnModels').addEventListener('click', async () => {
  const btn = $('btnModels');
  const box = $('modelBox');
  const tipEl = $('modelTip');
  btn.disabled = true;
  btn.textContent = '拉取中…';
  tipEl.style.color = '';
  tipEl.textContent = '正在向接口要模型清单…';
  box.hidden = true;
  box.innerHTML = '';

  try {
    const r = await bridge.check.models();
    box.hidden = false;
    if (!r.ok) {
      tipEl.textContent = r.message;
      tipEl.style.color = '#ff8181';
      const d = document.createElement('div');
      d.className = 'model-empty';
      d.textContent = r.message;
      box.appendChild(d);
      return;
    }
    tipEl.textContent = `拉到 ${r.count} 个可用模型，点一个就填进上面的模型名`;
    const cur = $('llmModel').value.trim();
    for (const id of r.models) {
      const chip = document.createElement('button');
      chip.className = 'model-chip' + (id === cur ? ' on' : '');
      chip.textContent = id;
      chip.title = id;
      chip.addEventListener('click', () => {
        $('llmModel').value = id;
        box.querySelectorAll('.model-chip').forEach((c) => c.classList.toggle('on', c === chip));
        tipEl.textContent = `已选 ${id}，记得点右下角「保存并生效」`;
      });
      box.appendChild(chip);
    }
  } catch (err) {
    tipEl.textContent = `拉取失败：${err.message}`;
    tipEl.style.color = '#ff8181';
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取可用模型';
  }
});

/* ---------------- 记忆 ---------------- */
async function loadMemory() {
  const snap = await bridge.memory.snapshot();
  const list = $('memList');
  list.innerHTML = '';
  if (!snap.notes.length) {
    const d = document.createElement('div');
    d.className = 'mem-empty';
    d.textContent = `还没有记下的笔记。当前有 ${snap.turns} 条对话记录在本地。`;
    list.appendChild(d);
    return;
  }
  for (const n of snap.notes) {
    const d = document.createElement('div');
    d.className = 'mem-item';
    d.textContent = n;
    list.appendChild(d);
  }
}

$('memAdd').addEventListener('click', async () => {
  const v = $('memInput').value.trim();
  if (!v) return;
  await bridge.memory.remember(v);
  $('memInput').value = '';
  loadMemory();
});

$('memClear').addEventListener('click', async () => {
  if (!confirm('清空后她就完全不记得之前聊过什么、你说过什么了，确定？')) return;
  await bridge.memory.forget();
  loadMemory();
  tip('记忆已清空', false);
});

/* ---------------- 版本与更新 ---------------- */
let updState = { latest: null, asset: null, pageUrl: null, zipPath: null };

function setBadge(el, text, kind) {
  const b = $(el);
  if (!b) return;
  b.textContent = text;
  b.className = 'badge' + (kind ? ' ' + kind : '');
}

$('btnCheckUpdate').addEventListener('click', async () => {
  const btn = $('btnCheckUpdate');
  btn.disabled = true;
  btn.textContent = '检查中…';
  setBadge('updBadge', '检查中', 'busy');
  $('updNotes').hidden = true;
  $('btnDownload').hidden = true;

  try {
    const r = await bridge.update.check();
    if (!r.ok) {
      setBadge('updBadge', '没查到', 'bad');
      $('updNotes').hidden = false;
      $('updNotes').textContent = r.message;
      updState.pageUrl = r.pageUrl;
      return;
    }
    updState.latest = r.latest;
    updState.asset = r.asset;
    updState.pageUrl = r.pageUrl;
    $('updMeta').textContent = `当前 v${r.current} · 最新 v${r.latest}${r.via === 'atom' ? '（原子源）' : ''}`;

    if (!r.hasUpdate) {
      setBadge('updBadge', '已是最新', 'ok');
      return;
    }

    setBadge('updBadge', '有新版本', 'busy');
    if (r.notes) {
      $('updNotes').hidden = false;
      $('updNotes').textContent = r.notes;
    }
    if (r.asset) {
      $('btnDownload').hidden = false;
      $('btnDownload').textContent = `下载 v${r.latest}${r.asset.size ? `（${Math.round(r.asset.size / 1048576)} MB）` : ''}`;
    } else {
      tip('这个发布没有可直接下载的包，用「打开下载页」手动取', true);
    }
  } catch (err) {
    setBadge('updBadge', '出错', 'bad');
    tip(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '检查更新';
  }
});

$('btnDownload').addEventListener('click', async () => {
  if (!updState.asset) return;
  const btn = $('btnDownload');
  btn.disabled = true;
  btn.textContent = '下载中…';
  $('updProgressWrap').hidden = false;
  $('updProgText').hidden = false;
  $('updBar').style.width = '0%';
  $('updProgText').textContent = '准备下载';

  try {
    const r = await bridge.update.download(updState.asset);
    if (!r.ok) {
      setBadge('updBadge', '下载失败', 'bad');
      $('updProgText').textContent = r.message;
      btn.disabled = false;
      btn.textContent = '重试下载';
      return;
    }
    updState.zipPath = r.file;
    $('updBar').style.width = '100%';
    $('updProgText').textContent = `下载完成 ${(r.size / 1048576).toFixed(1)} MB，正在替换并重启`;
    setBadge('updBadge', '安装中', 'busy');
    await new Promise((res) => setTimeout(res, 600));
    const a = await bridge.update.apply(r.file);
    if (!a.ok) {
      setBadge('updBadge', '需要手动', 'bad');
      $('updProgText').textContent = `${a.message}（可以点「打开下载页」手动取）`;
    }
  } catch (err) {
    setBadge('updBadge', '下载失败', 'bad');
    $('updProgText').textContent = err.message;
    btn.disabled = false;
    btn.textContent = '重试下载';
  }
});

$('btnCopyLink').addEventListener('click', () => {
  const u = (updState.asset && updState.asset.url) || updState.pageUrl || 'https://github.com/kaynai1/aipal/releases/latest';
  bridge.app.copy(u);
  tip('下载链接已复制，可以丢给浏览器或下载工具', false);
});

$('btnReleasePage').addEventListener('click', () => {
  const u = updState.pageUrl || 'https://github.com/kaynai1/aipal/releases/latest';
  bridge.app.openUrl(u);
});

bridge.on.updateProgress((p) => {
  if (p.percent === null) return;
  $('updBar').style.width = `${p.percent}%`;
  $('updProgText').textContent = `${p.percent}% · ${(p.received / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB`;
});

/* ---------------- 页面跳转 ---------------- */
function goSection(name) {
  const b = document.querySelector(`#nav button[data-sec="${name}"]`);
  if (!b) return;
  b.click();
}

if (location.hash && location.hash.length > 1) {
  const want = location.hash.replace(/^#/, '');
  setTimeout(() => goSection(want), 0);
}
bridge.on.goto((name) => goSection(name));

/* ---------------- 实时同步 ---------------- */
bridge.on.config((c) => {
  cfg = c;
});

/* ---------------- 自绘标题栏 ---------------- */
$('tbMin').addEventListener('click', () => bridge.win.minimize());
$('tbMax').addEventListener('click', () => bridge.win.toggleMax());
$('tbClose').addEventListener('click', () => bridge.win.close());

load().catch((err) => {
  tip(`载入失败：${err.message}`, true);
});