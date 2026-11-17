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
  dialog,
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
const watcher = require('./main/watch');
const dbg = require('./main/debug');

const isDev = process.argv.includes('--dev');

/* ---------------- 崩溃与异常兜底 ---------------- */
// 主进程一崩就是静默消失，先把现场写进日志，再给用户一句话
process.on('uncaughtException', (err) => {
  dbg.always('[uncaughtException]', err);
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('turn:event', {
        type: 'error',
        data: { message: `程序内部出错：${err.message}（详情在配置文件夹的 debug.log）` },
      });
    }
  } catch {}
});
process.on('unhandledRejection', (err) => {
  dbg.always('[unhandledRejection]', err);
});

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

  // 窗口收起时把前台窗口轮询降频，省电
  win.on('hide', () => game.setInterval(10000));
  win.on('show', () => game.setInterval(3000));
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
    backgroundColor: '#0a0a0b',
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

function applyOpacity(v) {
  if (!win || win.isDestroyed()) return;
  const n = Number(v);
  win.setOpacity(Number.isFinite(n) ? Math.min(1, Math.max(0.45, n)) : 1);
}

function applyAutoStart(on) {
  try {
    // 开发模式不写入开机项，避免每次开机弹一堆 electron
    if (!/^AIPal\.exe$/i.test(path.basename(app.getPath('exe')))) return;
    app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true });
  } catch (err) {
    dbg.always('setLoginItemSettings failed', err);
  }
}

/* ---------------- 主动开口 ---------------- */
let proactiveTimer = null;
let lastTalkAt = Date.now();
let lastBreakAt = Date.now();

function touchTalk() {
  lastTalkAt = Date.now();
}

function scheduleProactive() {
  if (proactiveTimer) {
    clearInterval(proactiveTimer);
    proactiveTimer = null;
  }
  const p = config.get().proactive || {};
  if (!p.enabled) return;
  const idleMs = Math.max(2, Number(p.idleMinutes) || 10) * 60000;
  const breakMs = Math.max(20, Number(p.breakMinutes) || 120) * 60000;

  proactiveTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    const cfg = config.get();
    if (!cfg.proactive || !cfg.proactive.enabled) return;
    const g = game.get();
    const now = Date.now();

    // 久坐提醒优先，且一天最多提醒几次由间隔天然限制
    const needBreak = now - lastBreakAt > breakMs && g.game;
    const needTalk = now - lastTalkAt > idleMs && g.game;
    if (!needBreak && !needTalk) return;

    // 正在说话/思考时不插嘴
    if (pipeline.isBusy && pipeline.isBusy()) return;

    if (needBreak && g.game) {
      lastBreakAt = now;
      lastTalkAt = now;
      runProactive('提醒他玩太久了，让他起来活动一下、喝口水。只说一句，不要唠叨。');
      return;
    }
    lastTalkAt = now;
    runProactive('他很久没说话了。主动搭一句，吐槽一下场面或者随便聊两句。');
  }, 60000);
}

async function runProactive(hint) {
  try {
    await pipeline.run({
      text: hint,
      silent: true,
      withVision: !!config.get().vision,
      game: game.get().game,
      fullscreen: game.get().fullscreen,
      onEvent: (type, data) => {
        if (type === 'audio') send('turn:audio', { seq: data.seq, text: data.text, buffer: data.buffer });
        else send('turn:event', { type, data });
      },
    });
  } catch (err) {
    dbg.always('proactive failed', err);
  }
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
  if (patch && patch.autoStart !== undefined) applyAutoStart(!!cfg.autoStart);
  if (patch && patch.opacity !== undefined) applyOpacity(cfg.opacity);
  if (patch && patch.proactive !== undefined) scheduleProactive();
  if (patch && patch.watch !== undefined) watcher.restart();
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
ipcMain.handle('check:llm', (_e, override) => llm.check(override || {}));
ipcMain.handle('llm:models', (_e, override) => llm.listModels(override || {}));

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
  touchTalk();
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
ipcMain.handle('memory:remove', (_e, index) => {
  memory.removeNote(index);
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

/* ---------------- 备份、导入、诊断 ---------------- */

ipcMain.handle('app:exportConfig', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(settingsWin || win, {
    title: '导出配置（含 Key，请自己保管好）',
    defaultPath: 'aipal-config.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    fs.copyFileSync(config.file(), filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:importConfig', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWin || win, {
    title: '选择要导入的配置',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false };
  try {
    const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    config.save(raw);
    registerHotkey();
    applyClickThrough(config.get().clickThrough);
    tts.edge.reset();
    send('config', config.masked());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:exportPersona', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(settingsWin || win, {
    title: '导出角色卡',
    defaultPath: 'aipal-persona.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    const p = config.get().persona || {};
    fs.writeFileSync(
      filePath,
      JSON.stringify({ _type: 'aipal-persona', _version: 1, persona: p }, null, 2),
      'utf8'
    );
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:importPersona', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(settingsWin || win, {
    title: '选择角色卡',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePaths || !filePaths[0]) return { ok: false };
  try {
    const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    const p = raw && raw.persona ? raw.persona : raw;
    if (!p || typeof p !== 'object') throw new Error('文件里没有角色卡内容');
    config.save({ persona: p });
    send('config', config.masked());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:diagnostic', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(settingsWin || win, {
    title: '导出诊断信息',
    defaultPath: 'aipal-diagnostic.txt',
    filters: [{ name: '文本', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return { ok: false };
  try {
    const c = config.masked();
    let logTail = '';
    try {
      const p = path.join(app.getPath('userData'), 'debug.log');
      const buf = fs.readFileSync(p);
      logTail = buf.slice(Math.max(0, buf.length - 200 * 1024)).toString('utf8');
    } catch {}
    const lines = [
      'AIPal 诊断信息',
      '==============',
      `版本: ${app.getVersion()}`,
      `时间: ${new Date().toISOString()}`,
      `系统: ${process.platform} ${process.arch} ${require('os').release()}`,
      `运行方式: ${/^AIPal\.exe$/i.test(path.basename(app.getPath('exe'))) ? '便携版' : '开发模式'}`,
      `配置文件夹: ${app.getPath('userData')}`,
      `热键注册: ${hotkeyOk ? '正常' : '失败'}`,
      '',
      '--- 配置（密钥已打码）---',
      JSON.stringify(c, null, 2),
      '',
      '--- 日志尾部 ---',
      logTail || '（没有日志；设置环境变量 AIPAL_DEBUG=1 后再复现一次）',
    ];
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* 演示：不需要大模型，直接用免费语音说一句，让第一次打开的人先听到声音 */
const DEMO_LINES = [
  '我叫小满，是你的游戏搭子。你填好模型接口之后，我就能陪你说话了。',
  '现在我还听不见你。去设置里把大脑填上，回来敲一下热键就行。',
  '别紧张，我又不会抢你人头。先吧配置弄好，咱们再开局。',
];
let demoIdx = 0;
ipcMain.handle('demo:speak', async () => {
  try {
    const text = DEMO_LINES[demoIdx++ % DEMO_LINES.length];
    const buf = await tts.speak(text);
    if (!buf || buf.length < 100) throw new Error('语音合成没有返回内容');
    send('turn:audio', { seq: 0, text, buffer: buf });
    send('turn:event', { type: 'reply', data: { text } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('stats:get', () => {
  const st = config.get().stats || {};
  const today = new Date().toISOString().slice(0, 10);
  return {
    day: st.day || '',
    today: st.day === today,
    chars: st.day === today ? st.chars || 0 : 0,
    images: st.day === today ? st.images || 0 : 0,
    notes: memory.snapshot().notes.length,
    playMinutes: memory.playMinutes(),
  };
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
    const cfg0 = config.get();
    createWindow();
    buildTray();
    registerHotkey();
    game.start();
    game.on('change', (g) => send('game', g));

    applyAutoStart(!!cfg0.autoStart);
    applyOpacity(cfg0.opacity);
    scheduleProactive();
    watcher.start();

    // 统计每个游戏玩了多久（记忆里“他常玩什么”的依据）
    setInterval(() => {
      const g = game.get();
      if (g.game) memory.addPlay(g.game, 60000);
    }, 60000);

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
    watcher.stop();
    if (proactiveTimer) clearInterval(proactiveTimer);
  });

  app.on('window-all-closed', (e) => {
    e.preventDefault && e.preventDefault();
  });
}