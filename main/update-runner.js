'use strict';

/**
 * 换壳器：主程序退出后，用它替换文件并重新启动。
 * 用 Electron 自带的 Node 运行（ELECTRON_RUN_AS_NODE=1），
 * 全程 Unicode 参数，不经过 cmd/PowerShell 的编码转换。
 *
 * 用法：AIPal.exe update-runner.js <父进程PID> <zip路径> <目标目录> <exe路径>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const LOG = path.join(os.tmpdir(), 'aipal-update.log');

function log(msg) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} ${msg}\n`);
  } catch {}
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* 纯忙等，runner 自身很轻，不占 CPU */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitParent(pid, maxMs) {
  const end = Date.now() + maxMs;
  while (alive(pid) && Date.now() < end) {
    const t = Date.now() + 250;
    while (Date.now() < t) {}
  }
  return !alive(pid);
}

function extract(zip, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // Windows 10+ 自带 bsdtar，可直接解 zip；失败再退回 PowerShell
  try {
    execFileSync('tar.exe', ['-xf', zip, '-C', outDir], { stdio: 'ignore', windowsHide: true });
    log('extract ok (tar)');
    return true;
  } catch (e) {
    log(`tar failed: ${e.message}`);
  }
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${outDir}' -Force`],
      { stdio: 'ignore', windowsHide: true }
    );
    log('extract ok (powershell)');
    return true;
  } catch (e) {
    log(`powershell extract failed: ${e.message}`);
    return false;
  }
}

function copyTree(src, dest) {
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyTree(from, to);
    } else {
      let ok = false;
      let lastErr = null;
      for (let i = 0; i < 12 && !ok; i++) {
        try {
          fs.copyFileSync(from, to);
          ok = true;
        } catch (e) {
          lastErr = e;
          sleep(400);
        }
      }
      if (!ok) {
        // 换壳器自己就是用 AIPal.exe 跑的，这个文件必然被占用；
        // Electron 主程序在版本间不变，跳过它只换 app 资源即可。
        if (/^AIPal\.exe$/i.test(ent.name) || /^electron\.exe$/i.test(ent.name)) {
          log(`skip locked ${ent.name}`);
        } else {
          throw lastErr || new Error(`复制失败 ${ent.name}`);
        }
      }
    }
  }
}

function main() {
  const [pidArg, zip, dest, exe] = process.argv.slice(2);
  log(`=== runner start pid=${pidArg} zip=${zip} dest=${dest}`);

  if (!zip || !dest || !exe) {
    log('missing args');
    return;
  }
  if (!fs.existsSync(zip)) {
    log('zip missing');
    return;
  }

  const gone = waitParent(Number(pidArg), 90000);
  log(`parent gone=${gone}`);
  // 再等一会，让 GPU/渲染进程一起退干净
  const t = Date.now() + 2500;
  while (Date.now() < t) {}

  const tmp = path.join(os.tmpdir(), `aipal-unpack-${Date.now()}`);
  if (!extract(zip, tmp)) {
    log('extract failed, abort');
    return;
  }

  let src = tmp;
  for (const ent of fs.readdirSync(tmp, { withFileTypes: true })) {
    if (ent.isDirectory() && fs.existsSync(path.join(tmp, ent.name, 'AIPal.exe'))) {
      src = path.join(tmp, ent.name);
      break;
    }
  }
  log(`copy from ${src}`);

  try {
    copyTree(src, dest);
    log('copied');
  } catch (e) {
    log(`copy failed: ${e.message}`);
    return;
  }

  try {
    spawn(exe, [], { detached: true, stdio: 'ignore', cwd: dest }).unref();
    log('restarted');
  } catch (e) {
    log(`restart failed: ${e.message}`);
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(zip, { force: true });
  } catch {}
  log('=== runner done');
}

main();