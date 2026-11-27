'use strict';
// 找到本机已安装的三家命令行，以及数据目录的位置。
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.AIGROUP_DATA || path.join(ROOT, 'data');
const WEB_DIR = path.join(ROOT, 'web');
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');

function isExec(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function inPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (isExec(p)) return p;
  }
  return null;
}

function firstExec(list) {
  for (const p of list) if (p && isExec(p)) return p;
  return null;
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Claude 桌面应用自带的 Claude Code：目录名带版本号，升级后会变，所以每次现找最新的。
function bundledClaude() {
  const base = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code');
  let versions = [];
  try { versions = fs.readdirSync(base); } catch { return null; }
  versions.sort((a, b) => cmpVersion(b, a));
  for (const v of versions) {
    let subs = [];
    try { subs = fs.readdirSync(path.join(base, v)); } catch { continue; }
    for (const s of subs) {
      const hit = firstExec([
        path.join(base, v, s, 'claude.app', 'Contents', 'MacOS', 'claude'),
        path.join(base, v, s, 'claude'),
      ]);
      if (hit) return hit;
    }
    const direct = firstExec([path.join(base, v, 'claude')]);
    if (direct) return direct;
  }
  return null;
}

const cache = new Map();
function cached(key, fn, ttl = 30000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  const val = fn();
  cache.set(key, { val, at: Date.now() });
  return val;
}

function findClaude() {
  return cached('claude', () =>
    firstExec([process.env.AIGROUP_CLAUDE]) ||
    inPath('claude') ||
    firstExec([
      path.join(HOME, '.local', 'bin', 'claude'),
      path.join(HOME, '.claude', 'local', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ]) ||
    bundledClaude());
}

function findCodex() {
  return cached('codex', () =>
    firstExec([process.env.AIGROUP_CODEX]) ||
    inPath('codex') ||
    firstExec([
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      path.join(HOME, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ]));
}

// Google 官方的 Antigravity CLI（命令叫 agy）。官方安装脚本默认装在 ~/.local/bin。
function findAgy() {
  return cached('agy', () =>
    firstExec([process.env.AIGROUP_AGY]) ||
    inPath('agy') ||
    firstExec([
      path.join(HOME, '.local', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
    ]));
}

module.exports = {
  HOME, ROOT, DATA_DIR, WEB_DIR, CODEX_HOME,
  isExec, findClaude, findCodex, findAgy,
};
