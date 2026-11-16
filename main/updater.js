'use strict';

/**
 * 自动更新
 *
 * 走 GitHub Releases：
 *   1. 正常查 api.github.com（匿名限流 60 次/小时）
 *   2. 撞到 403/429 就用 releases.atom（不受 API 限流）
 *   3. 都失败才报错，并给出下载页地址兜底
 *
 * 便携版自更新：下载 zip → 落盘到临时目录 → 写一个 PowerShell 换壳脚本 →
 * 退出当前进程 → 脚本覆盖文件并重新启动。
 */

const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = 'kaynai1/aipal';
const UA = 'AIPal-Updater';
const UPDATE_DIR = () => path.join(app.getPath('temp'), 'aipal-update');

function norm(v) {
  return String(v || '')
    .trim()
    .replace(/^v/i, '');
}

function isNewer(latest, current) {
  const a = norm(latest).split('.').map((n) => parseInt(n, 10) || 0);
  const b = norm(current).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function fetchJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 兜底：解析 releases.atom，拿最新 tag 与页面地址 */
function parseAtom(xml) {
  const entries = String(xml).match(/<entry>[\s\S]*?<\/entry>/g) || [];
  if (!entries.length) return null;
  const first = entries[0];
  const title = (first.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  const link = (first.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
  const updated = (first.match(/<updated>([^<]+)<\/updated>/) || [])[1] || '';
  const content = (first.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '';
  return { tag: norm(title), pageUrl: link, updated, content: content.slice(0, 4000) };
}

async function check() {
  const current = app.getVersion();

  // 1. GitHub API
  try {
    const j = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const latest = norm(j.tag_name || j.name);
    if (!latest) throw new Error('没有读到版本号');
    const assets = (j.assets || []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    }));
    const asset =
      assets.find((a) => /portable.*\.zip$/i.test(a.name)) ||
      assets.find((a) => /\.zip$/i.test(a.name)) ||
      assets.find((a) => /portable.*\.exe$/i.test(a.name)) ||
      null;
    return {
      ok: true,
      via: 'api',
      current,
      latest,
      hasUpdate: isNewer(latest, current),
      notes: String(j.body || '').slice(0, 1500),
      publishedAt: j.published_at,
      asset,
      assets,
      pageUrl: j.html_url || `https://github.com/${REPO}/releases/latest`,
    };
  } catch (err) {
    // 2. 限流或网络问题 → releases.atom
    try {
      const xml = await fetchText(`https://github.com/${REPO}/releases.atom`);
      const a = parseAtom(xml);
      if (!a) throw new Error('原子源里没有发布记录');
      return {
        ok: true,
        via: 'atom',
        current,
        latest: a.tag,
        hasUpdate: isNewer(a.tag, current),
        notes: '（通过 releases.atom 获取，没有完整更新说明）',
        publishedAt: a.updated,
        asset: null,
        assets: [],
        pageUrl: a.pageUrl || `https://github.com/${REPO}/releases/latest`,
      };
    } catch (err2) {
      const limited = err.status === 403 || err.status === 429;
      return {
        ok: false,
        current,
        message: limited
          ? `更新检查被 GitHub 限流（匿名每小时 60 次），可以稍后再试，或直接打开下载页手动取：${`https://github.com/${REPO}/releases/latest`}`
          : `检查更新失败：${err.message}`,
        pageUrl: `https://github.com/${REPO}/releases/latest`,
      };
    }
  }
}

async function download(asset, onProgress) {
  if (!asset || !asset.url) throw new Error('这个发布没有可直接下载的安装包，请打开下载页手动取');
  const dir = UPDATE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, asset.name || 'aipal-update.zip');

  const ctrl = new AbortController();
  const res = await net.fetch(asset.url, {
    headers: { 'User-Agent': UA },
    signal: ctrl.signal,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (!out.write(Buffer.from(value))) {
      await new Promise((r) => out.once('drain', r));
    }
    if (onProgress) {
      onProgress({
        received,
        total,
        percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
      });
    }
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));

  const st = fs.statSync(file);
  if (st.size < 1024 * 1024) throw new Error('下载的文件太小，可能下到了错误页面');
  return { file, size: st.size };
}

const PS_SCRIPT = `
param([int]$TargetPid_, [string]$Zip, [string]$Dest, [string]$Exe)
$ErrorActionPreference = 'Stop'
try { Wait-Process -Id $TargetPid_ -Timeout 90 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 900
$tmp = Join-Path $env:TEMP ('aipal-unpack-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Expand-Archive -LiteralPath $Zip -DestinationPath $tmp -Force
$src = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'AIPal.exe') } | Select-Object -First 1
if (-not $src) { $src = Get-Item $tmp }
Copy-Item (Join-Path $src.FullName '*') $Dest -Recurse -Force
Start-Process -FilePath $Exe -WorkingDirectory $Dest
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $Zip -Force -ErrorAction SilentlyContinue
`.trim();

/** 用换壳脚本替换当前程序并重启 */
async function apply(zipPath) {
  const exe = app.getPath('exe');
  if (!/^AIPal\.exe$/i.test(path.basename(exe))) {
    throw Object.assign(new Error('当前是开发/调试模式运行，不能自动替换，请用便携版的 AIPal.exe'), {
      code: 'E_NOT_PORTABLE',
    });
  }
  const dest = path.dirname(exe);
  if (!fs.existsSync(zipPath)) throw new Error('更新包不存在，请重新下载');

  const scriptPath = path.join(UPDATE_DIR(), 'apply-update.ps1');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8');

  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      String(process.pid),
      zipPath,
      dest,
      exe,
    ],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();

  setTimeout(() => {
    app.quit();
  }, 400);
  return true;
}

module.exports = { check, download, apply, isNewer, REPO };