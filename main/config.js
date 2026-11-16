'use strict';

/**
 * 配置读写：%APPDATA%\AIPal\config.json
 * 所有密钥只存在本机，不外传。
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_PERSONA = {
  name: '小满',
  tag: '你的游戏搭子',
  callUser: '老板',
  // 人设直接进系统提示词，所以写成明确的行为约束
  style:
    '你是陪他打游戏的搭子，不是客服。说话短、口语、有情绪，像个真人朋友在旁边看屏幕。' +
    '每次最多两句，绝不复述他的问题，不解释自己是谁。' +
    '会损他但护着他；他打得烂就吐槽，打得好就真心夸。' +
    '不编造游戏里的数据和事实，看不清就说看不清，不许瞎猜。' +
    '不用括号写动作，不用表情符号，不加任何格式符号——你的话会被读出来。',
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+8%',
  pitch: '+0Hz',
  avatar: 'avatar.png',
};

const DEFAULTS = {
  persona: DEFAULT_PERSONA,
  asr: {
    // sapi = 本机离线识别（免费、无 Key）；api = 兼容 OpenAI /audio/transcriptions
    provider: 'sapi',
    baseUrl: '',
    apiKey: '',
    model: 'whisper-1',
    language: 'zh',
  },
  llm: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    temperature: 0.85,
    maxTokens: 160,
  },
  // 主接口挂了自动切过去；留空则不启用
  llmFallback: {
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  tts: {
    // edge = 微软 Edge 朗读接口（免费、无 Key）；api = 兼容 OpenAI /audio/speech
    provider: 'edge',
    voice: 'zh-CN-XiaoxiaoNeural',
    rate: '+8%',
    pitch: '+0Hz',
    baseUrl: '',
    apiKey: '',
    model: 'tts-1',
  },
  trigger: 'both', // hotkey | auto | both
  hotkey: 'F8',
  autoSpeak: true,
  vision: true,
  memoryTurns: 12,
  showSubtitle: true,
  clickThrough: false,
  opacity: 1,

  mic: {
    deviceId: 'default',
    consent: false,
  },
  // 你说话打断她正在说的话
  bargeIn: true,
  // 她说话时把触发阈值抬高，减少被自己的声音触发
  echoGuard: true,

  // 她主动开口（冷场 / 久坐提醒）
  proactive: {
    enabled: false,
    idleMinutes: 10,
    breakMinutes: 120,
  },
  autoStart: false,
  // 粗略统计今天发给模型的内容量，用于"上传透明度"
  stats: {
    day: '',
    chars: 0,
    images: 0,
  },
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      base &&
      typeof base[k] === 'object' &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function load() {
  if (cache) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    raw = {};
  }
  cache = deepMerge(DEFAULTS, raw);
  return cache;
}

function get() {
  return load();
}

function save(patch) {
  cache = deepMerge(load(), patch || {});
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    throw Object.assign(new Error(`保存配置失败：${err.message}`), { code: 'E_CONFIG_SAVE' });
  }
  return cache;
}

function reset() {
  cache = JSON.parse(JSON.stringify(DEFAULTS));
  save({});
  return cache;
}

/** 给界面用的版本：密钥打码不外发 */
function masked() {
  const c = JSON.parse(JSON.stringify(load()));
  for (const k of ['asr', 'llm', 'tts']) {
    if (c[k] && c[k].apiKey) {
      c[k].hasKey = true;
      c[k].apiKey = '';
    }
  }
  return c;
}

module.exports = { get, save, reset, masked, file, DEFAULTS };