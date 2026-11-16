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
const { spawn, execFileSync } = require('child_process');

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
  let idleTimer = null;
  const totalTimer = setTimeout(() => ctrl.abort(), 20 * 60 * 1000);
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    // 30 秒没有任何数据就判定这条链路不通
    idleTimer = setTimeout(() => ctrl.abort(), 30000);
  };

  let res;
  try {
    bumpIdle();
    res = await net.fetch(asset.url, {
      headers: { 'User-Agent': UA },
      signal: ctrl.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    throw new Error(
      '连不上 GitHub 的下载服务器（30 秒没有响应）。如果本机开着代理，检查代理是否放行了 github 相关域名；' +
        '也可以点「复制下载链接」，用浏览器或下载工具手动下载。'
    );
  }
  if (!res.ok) {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    throw new Error(`下载失败 HTTP ${res.status}，可能这个版本已下架，去下载页看看`);
  }

  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpIdle();
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
  } catch (err) {
    clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    try {
      await new Promise((r) => out.destroy(r));
    } catch {}
    try {
      fs.unlinkSync(file);
    } catch {}
    throw new Error(
      `下载中断（已收到 ${(received / 1048576).toFixed(1)} MB）：连接 30 秒没有数据。` +
        '网络不稳定时建议点「复制下载链接」，用下载工具续传。'
    );
  }

  clearTimeout(totalTimer);
  if (idleTimer) clearTimeout(idleTimer);
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));

  const st = fs.statSync(file);
  if (st.size < 1024 * 1024) throw new Error('下载的文件太小，可能下到了错误页面');
  return { file, size: st.size };
}

const PS_SCRIPT = `
param([int]$TargetPid_, [string]$Zip, [string]$Dest, [string]$Exe)
$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP 'aipal-update.log'
function L($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }
Set-Content -LiteralPath $log -Value ('=== update start ' + (Get-Date -Format 'HH:mm:ss') + ' ===')
try {
  L ('zip=' + $Zip + ' dest=' + $Dest)
  try { Wait-Process -Id $TargetPid_ -Timeout 60 -ErrorAction SilentlyContinue } catch { L ('wait pid: ' + $_) }
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    $left = @(Get-Process -Name 'AIPal' -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
  L 'processes gone'
  Start-Sleep -Milliseconds 800
  $tmp = Join-Path $env:TEMP ('aipal-unpack-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  L ('expand to ' + $tmp)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $tmp)
  L 'extracted'
  $src = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'AIPal.exe') } | Select-Object -First 1
  if (-not $src) { $src = Get-Item $tmp }
  L ('copy from ' + $src.FullName)
  Copy-Item (Join-Path $src.FullName '*') $Dest -Recurse -Force
  L 'copied'
  Start-Process -FilePath $Exe -WorkingDirectory $Dest
  L 'restarted'
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $Zip -Force -ErrorAction SilentlyContinue
} catch {
  L ('ERROR: ' + $_.Exception.Message)
}`.trim();

/**
 * 换壳：主进程退出后由独立 PowerShell 进程替换文件并重启。
 * 关键点：换壳器绝不能自己加载 Electron 运行时，否则 AIPal.exe / *.dll 会被锁住；
 * 路径全部内嵌在脚本里，不经过 cmd 参数，避免中文路径被转码。
 */
async function apply(rawZipPath) {
  const zipPath = path.normalize(String(rawZipPath || ''));
  const exe = app.getPath('exe');
  if (!/^AIPal\.exe$/i.test(path.basename(exe))) {
    throw Object.assign(new Error('当前是开发/调试模式运行，不能自动替换，请用便携版的 AIPal.exe'), {
      code: 'E_NOT_PORTABLE',
    });
  }
  const dest = path.dirname(exe);
  if (!fs.existsSync(zipPath)) throw new Error('更新包不存在，请重新下载');

  const dir = UPDATE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, 'apply-update.ps1');
  const logPath = path.join(dir, 'apply.log');
  const nodeLog = path.join(dir, 'apply-node.log');
  const nlog = (m) => {
    try {
      fs.appendFileSync(nodeLog, `${new Date().toISOString().slice(11, 19)} ${m}\n`);
    } catch {}
  };
  nlog(`apply start zip=${zipPath}`);
  nlog(`script=${scriptPath} exe=${exe}`);

  const q = (s) => String(s).replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Continue'
$log = '${q(logPath)}'
function L($m) { try { Add-Content -LiteralPath $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) } catch {} }
L '=== apply start ==='
$zip  = '${q(zipPath)}'
$dest = '${q(dest)}'
$exe  = '${q(exe)}'
$pid_ = ${Number(process.pid)}
L ('zip=' + $zip + ' dest=' + $dest)

$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  $p = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
  if (-not $p) { break }
  Start-Sleep -Milliseconds 300
}
L 'parent gone'
Start-Sleep -Milliseconds 2500

$tmp = Join-Path $env:TEMP ('aipal-unpack-' + (Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$ok = $false
try {
  & tar.exe -xf $zip -C $tmp
  if ($LASTEXITCODE -eq 0) { $ok = $true; L 'extract ok (tar)' }
} catch { L ('tar err: ' + $_) }
if (-not $ok) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmp)
    $ok = $true
    L 'extract ok (zipfile)'
  } catch { L ('zipfile err: ' + $_) }
}
if (-not $ok) { L 'EXTRACT FAILED'; exit 1 }

$src = $tmp
Get-ChildItem $tmp -Directory | ForEach-Object {
  if (Test-Path (Join-Path $_.FullName 'AIPal.exe')) { $src = $_.FullName }
}
L ('copy from ' + $src)

$items = Get-ChildItem -LiteralPath $src -Force
$srcRoot = (Get-Item -LiteralPath $src).FullName
if (-not $srcRoot.EndsWith('\')) { $srcRoot = $srcRoot + '\' }
L ('robocopy ' + $srcRoot + ' -> ' + $dest)
& robocopy $srcRoot $dest /E /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
$rc = $LASTEXITCODE
L ('robocopy exit=' + $rc)
if ($rc -ge 8) { L 'COPY FAILED' } else { L 'copy finished' }

Start-Process -FilePath $exe -WorkingDirectory $dest
L 'restarted'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $zip -Force -ErrorAction SilentlyContinue
& schtasks.exe /delete /tn 'AIPalSelfUpdate' /f 2>$null | Out-Null
L '=== done ==='
`.trim();

  // 带 BOM 写，PowerShell 5.1 才会按 UTF-8 正确读取中文路径
  fs.writeFileSync(scriptPath, '\ufeff' + script, 'utf8');

// 拉起独立进程：Electron 退出时会把子进程一起带走（job object），
// 所以让 WMI 服务代为创建进程，它不在当前进程树里。
  const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const inner = `${psExe} -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`;
  const wmiCmd =
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='` +
    inner.replace(/'/g, "''") +
    `'} | Out-Null`;

  let started = false;
  try {
    execFileSync(psExe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wmiCmd], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 25000,
    });
    started = true;
    nlog('wmi create ok');
  } catch (err) {
    nlog(`wmi create failed: ${err.message}`);
  }

  if (!started) {
    // 退路：直接 spawn，部分环境可行
    try {
      const child = spawn(inner, { shell: true, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      started = true;
      nlog('fallback spawn ok');
    } catch (err) {
      nlog(`fallback spawn failed: ${err.message}`);
    }
  }
  if (!started) throw new Error('无法启动更新进程，请手动下载安装包');

  // 藏窗口后退出，剩下的交给换壳脚本
  setTimeout(() => {
    try {
      if (win && !win.isDestroyed()) win.hide();
    } catch {}
    app.exit(0);
  }, 2500);
  return true;
}

module.exports = { check, download, apply, isNewer, REPO };