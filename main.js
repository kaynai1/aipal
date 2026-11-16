'use strict';

/**
 * AIPal · AI 游戏搭子
 * 悬浮窗 + 全局热键 + 语音对话 + 看屏幕 + 本地记忆
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  globalShortcut,
  screen,
  nativeImage,
  shell,
  clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');

const config = require('./main/config');
const asr = require('./main/asr');
const tts = require('./main/tts');
const llm = require('./main/llm');
const vision = require('./main/vision');
const pipeline = require('./main/pipeline');
const memory = require('./main/memory');
const game = require('./main/game');
const updater = require('./main/updater');

const isDev = process.argv.includes('--dev');

let win = null;
let settingsWin = null;
let tray = null;
let hotkeyOk = false;

const WIN_W = 320;
const WIN_H = 186;

function iconPath() {
  for (const p of [path.join(__dirname, 'icon.png'), path.join(__dirname, 'renderer', 'avatar.png')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function createWindow() {
  const disp = screen.getPrimaryDisplay();
  const area = disp.workArea;
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: area.x + area.width - WIN_W - 20,
    y: area.y + area.height - WIN_H - 20,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('closed', () => {
    win = null;
  });
}

function createSettings(section) {
  // 打开设置时把小窗收起：它是一律置顶的，不收起来会挡住设置页的按钮
  if (win && !win.isDestroyed()) win.hide();

  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (section) settingsWin.webContents.send('goto', section);
    return;
  }
  const disp = screen.getPrimaryDisplay();
  const area = disp.workArea;
  const w = Math.min(920, Math.round(area.width * 0.8));
  const h = Math.min(800, Math.round(area.height * 0.86));
  settingsWin = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 760,
    minHeight: 520,
    x: area.x + Math.round((area.width - w) / 2),
    y: area.y + Math.round((area.height - h) / 2),
    title: 'AIPal 设置',
    frame: false,
    roundedCorners: true,
    backgroundColor: '#0c0c0e',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.once('ready-to-show', () => {
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.show();
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), section ? { hash: section } : undefined);
  settingsWin.on('closed', () => {
    settingsWin = null;
    // 设置关掉后把小窗放回去
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.showInactive();
    }
  });
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  hotkeyOk = false;
  const key = String(config.get().hotkey || 'F8').trim();
  if (!key) return;
  try {
    hotkeyOk = globalShortcut.register(key, () => send('hotkey', { key }));
  } catch {
    hotkeyOk = false;
  }
  if (!hotkeyOk) send('warn', { message: `热键 ${key} 被别的程序占用了，换一个吧（设置 → 交互）` });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
}

function buildTray() {
  const ip = iconPath();
  const img = ip ? nativeImage.createFromPath(ip).resize({ width: 20, height: 20 }) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('AIPal · AI 游戏搭子');
  const menu = Menu.buildFromTemplate([
    {
      label: '显示搭子窗口',
      click: () => {
        if (!win) createWindow();
        else {
          win.showInactive();
          win.setAlwaysOnTop(true, 'screen-saver');
        }
      },
    },
    { label: '说一句（同热键）', click: () => send('hotkey', { key: 'tray' }) },
    { label: '设置…', click: () => createSettings() },
    { type: 'separator' },
    {
      label: '鼠标穿透（点得到游戏）',
      type: 'checkbox',
      checked: !!config.get().clickThrough,
      click: (item) => {
        const cfg = config.save({ clickThrough: !!item.checked });
        applyClickThrough(cfg.clickThrough);
        send('config', config.masked());
      },
    },
    { label: '打开配置文件夹', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '退出 AIPal', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => send('toggle-window'));
}

function applyClickThrough(on) {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(!!on, { forward: true });
}

/* ---------------- IPC ---------------- */

ipcMain.handle('app:init', () => ({
  config: config.masked(),
  game: game.get(),
  hotkeyOk,
  version: app.getVersion(),
  portable: /^AIPal\.exe$/i.test(path.basename(app.getPath('exe'))),
  configPath: config.file(),
  memory: memory.snapshot(),
  visionInfo: vision.info(),
}));

ipcMain.handle('config:get', () => config.masked());
ipcMain.handle('config:save', (_e, patch) => {
  const cfg = config.save(patch || {});
  if (patch && patch.hotkey !== undefined) registerHotkey();
  if (patch && patch.clickThrough !== undefined) applyClickThrough(cfg.clickThrough);
  if (patch && patch.tts && patch.tts.voice) tts.edge.reset();
  send('config', config.masked());
  return config.masked();
});
ipcMain.handle('config:reset', () => {
  const cfg = config.reset();
  registerHotkey();
  applyClickThrough(cfg.clickThrough);
  tts.edge.reset();
  send('config', config.masked());
  return config.masked();
});

ipcMain.handle('check:asr', () => asr.check());
ipcMain.handle('check:tts', () => tts.check());
ipcMain.handle('check:llm', () => llm.check());
ipcMain.handle('llm:models', () => llm.listModels());

ipcMain.handle('voice:list', async () => [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔女声' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼少女' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 清爽男声' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 沉稳男声' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 播音男声' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北大妞' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西妹子' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语女声' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾女声' },
]);

ipcMain.handle('turn:start', async (_e, payload) => {
  const audio = payload && payload.audio ? Buffer.from(payload.audio) : null;
  try {
    const r = await pipeline.run({
      wavBuffer: audio,
      text: payload && payload.text,
      withVision: !!(payload && payload.withVision),
      game: game.get().game,
      fullscreen: game.get().fullscreen,
      onEvent: (type, data) => {
        if (type === 'audio') send('turn:audio', { seq: data.seq, text: data.text, buffer: data.buffer });
        else send('turn:event', { type, data });
      },
    });
    return { ok: true, ...r };
  } catch (err) {
    send('turn:event', { type: 'error', data: { message: err.message } });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('turn:abort', () => {
  pipeline.abort();
  tts.edge.reset();
  return true;
});

ipcMain.handle('vision:test', async () => {
  try {
    const url = await vision.capture();
    return { ok: true, url, info: vision.info() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('game:current', () => game.get());

ipcMain.handle('memory:snapshot', () => memory.snapshot());
ipcMain.handle('memory:forget', () => {
  memory.forgetAll();
  return memory.snapshot();
});
ipcMain.handle('memory:remember', (_e, note) => {
  memory.remember(note);
  return memory.snapshot();
});

ipcMain.handle('win:size', (_e, targetH) => {
  if (!win || win.isDestroyed()) return false;
  const area = screen.getPrimaryDisplay().workArea;
  const h = Math.max(160, Math.min(640, Math.round(Number(targetH) || WIN_H)));
  const b = win.getBounds();
  const x = Math.max(area.x, Math.min(b.x, area.x + area.width - b.width - 12));
  const y = Math.max(area.y, area.y + area.height - h - 12);
  win.setBounds({ x, y, width: b.width, height: h });
  return true;
});

ipcMain.handle('win:setClickThrough', (_e, on) => {
  config.save({ clickThrough: !!on });
  applyClickThrough(!!on);
  return !!on;
});
ipcMain.handle('win:hide', () => {
  win && win.hide();
  return true;
});
ipcMain.handle('win:show', () => {
  if (win) win.showInactive();
  return true;
});
ipcMain.handle('win:openSettings', (_e, section) => {
  createSettings(typeof section === 'string' ? section : undefined);
  return true;
});

/* 自绘标题栏的窗口控制 */
ipcMain.handle('settings:minimize', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.minimize();
  return true;
});
ipcMain.handle('settings:toggleMax', () => {
  if (!settingsWin || settingsWin.isDestroyed()) return false;
  if (settingsWin.isMaximized()) settingsWin.unmaximize();
  else settingsWin.maximize();
  return settingsWin.isMaximized();
});
ipcMain.handle('settings:close', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  return true;
});
ipcMain.handle('app:openConfigDir', () => shell.openPath(app.getPath('userData')));
ipcMain.handle('app:openUrl', (_e, url) => {
  const u = String(url || '');
  if (!/^https:\/\//i.test(u)) return false;
  shell.openExternal(u);
  return true;
});

/* ---------------- 更新 ---------------- */
ipcMain.handle('update:check', async () => {
  const r = await updater.check();
  return { ...r, version: app.getVersion(), portable: /^AIPal\.exe$/i.test(path.basename(app.getPath('exe'))) };
});

ipcMain.handle('update:download', async (_e, asset) => {
  try {
    const r = await updater.download(asset, (p) => send('update:progress', p));
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('update:apply', async (_e, zipPath) => {
  try {
    await updater.apply(zipPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
ipcMain.handle('app:copy', (_e, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});
ipcMain.handle('app:quit', () => {
  app.quit();
  return true;
});

/* ---------------- 生命周期 ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.showInactive();
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.aipal.app');
    createWindow();
    buildTray();
    registerHotkey();
    game.start();
    game.on('change', (g) => send('game', g));

    // 预热语音合成连接：第一次说话就不用干等握手（预热失败不影响使用）
    tts.edge.warmup().catch(() => {});

    // 起手先摸一遍耳朵，出问题早点说清楚
    asr.check().then((r) => {
      if (!r.ok) send('warn', { message: `语音识别：${r.message}` });
    });

    // 静默查一次更新（失败不打扰），有新版就在小窗上挂个标记
    setTimeout(async () => {
      try {
        const r = await updater.check();
        if (r.ok && r.hasUpdate) send('update:available', { latest: r.latest });
      } catch {}
    }, 20000);
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    game.stop();
    asr.sapi.stop();
    tts.edge.reset();
  });

  app.on('window-all-closed', (e) => {
    e.preventDefault && e.preventDefault();
  });
}