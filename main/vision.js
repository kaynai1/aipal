'use strict';

/**
 * 看屏幕：抓一张当前主屏截图，压成 JPEG 给多模态模型。
 * 只在本机内存里处理，不落盘、不额外上传到第三方（只在对话请求里随消息发出）。
 */

const { desktopCapturer, screen } = require('electron');

let lastShot = null;

async function capture({ maxWidth = 1280, quality = 72 } = {}) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const scale = primary.scaleFactor || 1;
  const wantW = Math.round(primary.size.width * scale);
  const wantH = Math.round(primary.size.height * scale);
  const ratio = Math.min(1, maxWidth / Math.max(1, wantW));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(wantW * ratio), height: Math.round(wantH * ratio) },
    fetchWindowIcons: false,
  });
  if (!sources.length) throw new Error('没有拿到屏幕画面');
  // 尽量选主屏
  const main = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = main.thumbnail;
  if (!img || img.isEmpty()) throw new Error('屏幕截图是空的（可能被系统权限拦截）');

  const jpeg = img.toJPEG(quality);
  lastShot = { at: Date.now(), bytes: jpeg.length, size: img.getSize(), displays: displays.length };
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

function info() {
  return lastShot;
}

module.exports = { capture, info };