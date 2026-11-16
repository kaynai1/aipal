'use strict';

/**
 * 记忆：本地 JSON，不上传。
 *  - turns   ：最近的对话，喂给模型做上下文
 *  - profile ：他主动让你记住的事（称呼、习惯、常玩的游戏）
 *  - plays   ：每个游戏累计聊了多久，用来让"这人到底平时玩什么"有据可依
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let data = null;

function file() {
  return path.join(app.getPath('userData'), 'memory.json');
}

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    data = {};
  }
  data.turns = Array.isArray(data.turns) ? data.turns : [];
  data.profile = data.profile && typeof data.profile === 'object' ? data.profile : { notes: [] };
  data.profile.notes = Array.isArray(data.profile.notes) ? data.profile.notes : [];
  data.plays = data.plays && typeof data.plays === 'object' ? data.plays : {};
  return data;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(load(), null, 2), 'utf8');
  } catch {}
}

function addTurn(role, content, extra = {}) {
  const d = load();
  const text = String(content || '').trim();
  if (!text) return;
  d.turns.push({ role, content: text, at: Date.now(), ...extra });
  // 只留最近 200 条，避免无限膨胀
  if (d.turns.length > 200) d.turns = d.turns.slice(-200);
  persist();
}

function recent(n = 12) {
  const d = load();
  return d.turns.slice(-Math.max(0, n));
}

function remember(note) {
  const d = load();
  const text = String(note || '').trim();
  if (!text) return;
  if (!d.profile.notes.includes(text)) d.profile.notes.push(text);
  if (d.profile.notes.length > 60) d.profile.notes = d.profile.notes.slice(-60);
  persist();
}

function forgetAll() {
  data = { turns: [], profile: { notes: [] }, plays: {} };
  persist();
}

/** 删掉一条笔记；index 从 0 开始。返回剩下的笔记 */
function removeNote(index) {
  const d = load();
  const i = Number(index);
  if (Number.isInteger(i) && i >= 0 && i < d.profile.notes.length) {
    d.profile.notes.splice(i, 1);
    persist();
  }
  return d.profile.notes.slice();
}

/** 把当前游戏累计时长读出来（分钟） */
function playMinutes() {
  const d = load();
  const total = Object.values(d.plays).reduce((a, b) => a + (b || 0), 0);
  return Math.round(total / 60000);
}

function addPlay(game, ms) {
  if (!game) return;
  const d = load();
  d.plays[game] = (d.plays[game] || 0) + Math.max(0, ms || 0);
  persist();
}

function topGames(n = 5) {
  const d = load();
  return Object.entries(d.plays)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([game, ms]) => ({ game, minutes: Math.round(ms / 60000) }));
}

function snapshot() {
  const d = load();
  const last = [...d.turns].reverse().find((t) => t.role === 'assistant');
  return {
    notes: d.profile.notes.slice(),
    turns: d.turns.length,
    lastReply: last ? { text: last.content, at: last.at } : null,
    topGames: topGames(5),
  };
}

module.exports = { addTurn, recent, remember, forgetAll, removeNote, addPlay, topGames, playMinutes, snapshot };