'use strict';

/**
 * 实况观战：她在看你打游戏。
 *
 * 每隔 intervalSec 截一帧屏幕 → 和人设/记忆一起发给视觉模型 →
 * 模型判断这帧值不值得说话：值得就念出来，不值得就回「不说」（pipeline 里拦住，不出声）。
 *
 * 护栏：
 *  - 冷却时间：两次真开口之间至少隔一段时间（按话多程度），避免叭叭叭说个不停
 *  - 只在游戏里（可选）：桌面/浏览器不搭话
 *  - 你正在对话/录音/放音时不插嘴
 *  - 模型连续失败 3 次：自动暂停观战，提示一次，别白烧钱
 */

const config = require('./config');
const vision = require('./vision');
const pipeline = require('./pipeline');
const game = require('./game');
const memory = require('./memory');
const dbg = require('./debug');

// 话多程度 → (截图间隔秒, 冷却秒, 严格度)
const MODES = {
  calm: { interval: 45, cooldown: 150 },
  normal: { interval: 25, cooldown: 75 },
  chatty: { interval: 15, cooldown: 35 },
};

const GRACE_MS = 30000; // 启动后先别急着开口

const state = {
  timer: null,
  startedAt: 0,
  lastCommentAt: 0,
  errStreak: 0,
  warned: false,
  running: false, // 上一帧还在分析中
};

function intervalMs() {
  const w = config.get().watch || {};
  const mode = MODES[w.chattiness] || MODES.normal;
  const n = Number(w.intervalSec);
  return 1000 * (Number.isFinite(n) && n >= 10 && n <= 300 ? n : mode.interval);
}

function cooldownMs() {
  const w = config.get().watch || {};
  const mode = MODES[w.chattiness] || MODES.normal;
  return 1000 * mode.cooldown;
}

function llmReady() {
  const c = config.get().llm;
  if (!c.baseUrl || !c.model) return false;
  if (!c.apiKey && !/localhost|127\.0\.0\.1/.test(c.baseUrl)) return false;
  return true;
}

async function tick() {
  const cfg = config.get();
  const w = cfg.watch || {};
  if (!w.enabled) return;
  if (!llmReady()) return; // 没配大脑就安静等
  if (Date.now() - state.startedAt < GRACE_MS) return;

  const g = game.get();
  if (w.onlyGame !== false && !g.game) return; // 只在游戏里搭话
  if (Date.now() - state.lastCommentAt < cooldownMs()) return; // 冷却中不开口也不分析
  if (state.running || pipeline.isBusy()) return;
  if (!cfg.vision) {
    if (!state.warned) {
      state.warned = true;
      try {
        const { BrowserWindow } = require('electron');
        const wins = BrowserWindow.getAllWindows();
        if (wins.length) wins[wins.length - 1].webContents.send('warn', { message: '实况观战需要开“看屏幕”，交互页里勾上' });
      } catch {}
    }
    return;
  }

  state.running = true;
  const startedAt = Date.now();
  try {
    const r = await pipeline.run({
      text: '看一眼他现在的画面，值得说就只回那一句话，不值就只回「不说」。',
      silent: true,
      watch: true,
      watchChatty: w.chattiness || 'normal',
      withVision: true,
      game: g.game,
      fullscreen: g.fullscreen,
      onEvent: (type, data) => {
        if (type === 'audio') {
          // 音频直接送小窗播
          try {
            const { BrowserWindow } = require('electron');
            for (const win of BrowserWindow.getAllWindows()) {
              if (win && !win.isDestroyed() && /index\.html$/.test(win.webContents.getURL() || '')) {
                win.webContents.send('turn:audio', { seq: data.seq, text: data.text, buffer: data.buffer });
              }
            }
          } catch {}
        } else if (type === 'reply' && data && data.text) {
          try {
            const { BrowserWindow } = require('electron');
            for (const win of BrowserWindow.getAllWindows()) {
              if (win && !win.isDestroyed() && /index\.html$/.test(win.webContents.getURL() || '')) {
                win.webContents.send('turn:event', { type, data });
              }
            }
          } catch {}
        }
      },
    });
    state.errStreak = 0;
    if (r && r.text && !r.quiet) {
      state.lastCommentAt = Date.now();
      dbg('watch spoke', r.text.slice(0, 30));
    } else {
      dbg('watch quiet', ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
    }
  } catch (err) {
    state.errStreak++;
    dbg('watch err', err.message);
    if (state.errStreak >= 3) {
      stop();
      try {
        const { BrowserWindow } = require('electron');
        const wins = BrowserWindow.getAllWindows();
        if (wins.length) wins[wins.length - 1].webContents.send('warn', { message: `实况观战先停了：模型连着 3 次没回上话（${err.message.slice(0, 60)}）。去设置看看接口` });
      } catch {}
    }
  } finally {
    state.running = false;
  }
}

function start() {
  stop();
  state.startedAt = Date.now();
  state.errStreak = 0;
  state.warned = false;
  const w = config.get().watch;
  if (!w || !w.enabled) return;
  state.timer = setInterval(() => {
    tick().catch(() => {});
  }, intervalMs());
  dbg('watch started', (intervalMs() / 1000) + 's interval');
}

function stop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function restart() {
  start();
}

module.exports = { start, stop, restart, tick };