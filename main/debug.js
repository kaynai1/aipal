'use strict';

/**
 * 极简调试日志：只在本机 userData 下写一行，排查链路卡点用。
 * 设置 AIPAL_DEBUG=0 可关闭。
 */

const fs = require('fs');
const path = require('path');

let filePath = null;

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

function debug(...args) {
  // 默认关；排障时设环境变量 AIPAL_DEBUG=1 再启动
  if (process.env.AIPAL_DEBUG !== '1') return;
  try {
    const line =
      new Date().toISOString().slice(11, 23) +
      ' ' +
      args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ') +
      '\n';
    fs.mkdirSync(path.dirname(target()), { recursive: true });
    fs.appendFileSync(target(), line);
  } catch {}
}

module.exports = debug;