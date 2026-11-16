'use strict';

/**
 * 极简调试日志：只在本机 userData 下写，排查链路卡点用。
 * 超过 5MB 自动轮转成 debug.1.log，只保留一份旧文件，不会无限长。
 * 环境变量 AIPAL_DEBUG=1 才写；AIPAL_DEBUG=0 或未设置时静默丢弃。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;
let filePath = null;
let lastSize = 0;

function target() {
  if (filePath) return filePath;
  try {
    const { app } = require('electron');
    filePath = path.join(app.getPath('userData'), 'debug.log');
  } catch {
    filePath = path.join(process.cwd(), '.temp', 'debug.log');
  }
  return filePath;
}

function rotateIfNeeded(p) {
  try {
    const st = fs.statSync(p);
    lastSize = st.size;
    if (st.size > MAX_BYTES) {
      const old = path.join(path.dirname(p), 'debug.1.log');
      try {
        fs.unlinkSync(old);
      } catch {}
      fs.renameSync(p, old);
      lastSize = 0;
    }
  } catch {}
}

/** 无论开关如何，都可以写一条关键错误 */
function always(...args) {
  try {
    const p = target();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    rotateIfNeeded(p);
    const line =
      new Date().toISOString().slice(0, 23).replace('T', ' ') +
      ' ' +
      args
        .map((a) => {
          if (typeof a === 'string') return a;
          if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(' ') +
      '\n';
    fs.appendFileSync(p, line);
  } catch {}
}

function debug(...args) {
  if (process.env.AIPAL_DEBUG !== '1') return;
  always(...args);
}

debug.always = always;
debug.path = target;
debug.rotate = () => rotateIfNeeded(target());

module.exports = debug;