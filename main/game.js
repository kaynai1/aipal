'use strict';

/**
 * 你在玩什么：常驻 PowerShell 监视前台窗口，3 秒一次。
 * 只读窗口标题和进程名，不读游戏内存、不注入进程。
 */

const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

const HELPER = path.join(__dirname, '..', 'helpers', 'fg-watch.ps1');

const SELF = ['aipal.exe', 'electron.exe', 'powershell.exe', 'conhost.exe', 'cmd.exe', 'windowsterminal.exe'];
const BROWSER_SUFFIX = [
  /\s*-\s*(Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Opera|360 极速浏览器|QQ 浏览器|搜狗高速浏览器)\s*$/i,
  /\s*-\s*Visual Studio Code\s*$/i,
  /\s*-\s*Notepad\+\+\s*$/i,
];

class GameWatcher extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.current = { proc: '', title: '', game: '', fullscreen: false, at: 0 };
    this.timer = null;
  }

  start() {
    if (this.proc) return;
    const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    try {
      this.proc = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      this.proc = null;
      return;
    }
    this.proc.stdout.setEncoding('utf8');
    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let json = null;
        try {
          json = JSON.parse(line);
        } catch {
          continue;
        }
        this._apply(json);
      }
    });
    this.proc.on('exit', () => {
      this.proc = null;
      // 5 秒后自动重启，避免一次性故障导致彻底失联
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.start(), 5000);
    });
  }

  _apply(json) {
    const proc = String(json.proc || '').toLowerCase();
    const title = String(json.title || '').trim();
    const fullscreen = json.fullscreen === true;
    const self = SELF.includes(proc) || /aipal/i.test(title);

    let game = '';
    if (!self && title) {
      game = title;
      for (const re of BROWSER_SUFFIX) game = game.replace(re, '');
      game = game.replace(/\s*[-|–]\s*$/, '').trim();
    }

    const changed = game !== this.current.game || fullscreen !== this.current.fullscreen;
    this.current = { proc, title, game: self ? '' : game, fullscreen, at: Date.now() };
    if (changed) this.emit('change', this.current);
  }

  get() {
    return this.current;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    try {
      this.proc && this.proc.kill();
    } catch {}
    this.proc = null;
  }
}

module.exports = new GameWatcher();