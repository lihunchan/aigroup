'use strict';
// 位置和环境：数据放在哪、三家的命令行工具在哪、启动它们时带什么环境变量。
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const ROOT = path.resolve(__dirname, '..');

// 运行方式：
//   dev      程序放在一个文件夹里（server/、web/、data/ 都在那儿），软件外壳只是指向它；
//   bundled  程序装在「AI 群聊.app」里面，聊天记录等放在 ~/Library/Application Support/aigroup —— 发给别人用的方式。
const MODE = process.env.AIGROUP_MODE === 'bundled' ? 'bundled' : 'dev';

// 演练用：AIGROUP_SANDBOX=<文件夹> 让程序表现得像在一台全新的电脑上——
// 不认这台电脑上已经装好的命令行工具，三家的登录状态也各自放在这个文件夹里，和真实的互不影响。
const SANDBOX = process.env.AIGROUP_SANDBOX ? path.resolve(process.env.AIGROUP_SANDBOX) : '';
// Antigravity CLI 的登录没法靠"换一个主文件夹"来隔离：换了以后系统的钥匙串也找不到了，登录存不下来。
// 要演练真实登录时加上 AIGROUP_SANDBOX_KEEP_HOME=1：它就用真实的主文件夹（也就是沿用这台电脑上已有的 Google 登录）。
const SANDBOX_KEEP_HOME = process.env.AIGROUP_SANDBOX_KEEP_HOME === '1';

// 本软件自己的文件夹：下载回来的命令行工具放在这里（bundled 方式下聊天记录也在这里）。
const SUPPORT_DIR = SANDBOX
  ? path.join(SANDBOX, 'support')
  : (process.env.AIGROUP_SUPPORT || path.join(HOME, 'Library', 'Application Support', 'aigroup'));
const DATA_DIR = process.env.AIGROUP_DATA || (MODE === 'bundled' || SANDBOX ? path.join(SUPPORT_DIR, 'data') : path.join(ROOT, 'data'));
const TOOLS_DIR = path.join(SUPPORT_DIR, 'tools');
const WEB_DIR = path.join(ROOT, 'web');
const CODEX_HOME = SANDBOX ? path.join(SANDBOX, 'codex') : (process.env.CODEX_HOME || path.join(HOME, '.codex'));

// 成员默认的工作目录。dev 方式沿用程序文件夹里的 workspace；
// bundled 方式放在个人文件夹下——那里不属于"文稿 / 桌面 / 下载"，系统不会为它弹授权框。
const DEFAULT_WORKSPACE = SANDBOX
  ? path.join(SANDBOX, 'workspace')
  : (MODE === 'bundled' ? path.join(HOME, 'AI 群聊工作区') : path.join(ROOT, 'workspace'));

// 只是"问一句话"（查版本、查登录状态、登录）而不是替你干活的时候，命令行工具在哪个文件夹里运行。
// 用本软件自己的文件夹：它不在"文稿 / 桌面 / 下载"里，工具启动时翻看上层文件夹也不会触发系统的授权询问
// （软件本身被放在"文稿"或"下载"里运行时，尤其要避开这一点）。
function idleDir() {
  try {
    fs.mkdirSync(SUPPORT_DIR, { recursive: true });
    return SUPPORT_DIR;
  } catch {
    return HOME;
  }
}

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

// ---------- 三家的命令行工具在哪 ----------
// 每位成员靠一个命令行工具说话：Claude → Claude Code（claude），GPT → Codex（codex），Gemini → Antigravity CLI（agy）。
// 找的顺序：手动指定的（环境变量）→ 这台电脑上原有的 → 本软件自己下载的那一份。

// 本软件自己下载的那一份放在哪（由 tools.js 负责下载和更新）。
const OWN = {
  claude: path.join(TOOLS_DIR, 'claude-code', 'claude'),
  gpt: path.join(TOOLS_DIR, 'codex', 'codex'),
  gemini: path.join(TOOLS_DIR, 'antigravity-cli', 'agy'),
};

const OVERRIDE = { claude: 'AIGROUP_CLAUDE', gpt: 'AIGROUP_CODEX', gemini: 'AIGROUP_AGY' };

const SYSTEM = {
  claude: () =>
    inPath('claude') ||
    firstExec([
      path.join(HOME, '.local', 'bin', 'claude'),
      path.join(HOME, '.claude', 'local', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
    ]) ||
    bundledClaude(),
  gpt: () =>
    inPath('codex') ||
    firstExec([
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      path.join(HOME, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ]),
  // Google 官方的安装脚本默认把 agy 装在 ~/.local/bin。
  gemini: () =>
    inPath('agy') ||
    firstExec([
      path.join(HOME, '.local', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
    ]),
};

const cache = new Map();
function cached(key, fn, ttl = 30000) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  const val = fn();
  cache.set(key, { val, at: Date.now() });
  return val;
}

// 某位成员的命令行工具：{ path, source }；source 是 env（手动指定）/ system（电脑上原有的）/ own（本软件下载的）。没有就是 null。
function locate(agent) {
  return cached(agent, () => {
    const manual = firstExec([process.env[OVERRIDE[agent]]]);
    if (manual) return { path: manual, source: 'env' };
    const sys = SANDBOX ? null : SYSTEM[agent]();
    if (sys) return { path: sys, source: 'system' };
    if (isExec(OWN[agent])) return { path: OWN[agent], source: 'own' };
    return null;
  });
}

function find(agent) {
  const hit = locate(agent);
  return hit ? hit.path : null;
}

// 刚装好或刚删掉一份之后：忘掉"它在哪"的旧结论，下次重新找。
function refresh() {
  cache.clear();
}

const findClaude = () => find('claude');
const findCodex = () => find('gpt');
const findAgy = () => find('gemini');

// ---------- 启动命令行工具时的环境变量 ----------

// 如果群聊程序是从 Claude 桌面应用里被启动的，环境里会带着那个会话专用的变量；
// 这里去掉它们，让群里的 Claude 作为一个独立进程用自己的登录状态运行。
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT') continue;
    if (k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK_') || k.startsWith('CLAUDE_PREVIEW_')) continue;
    env[k] = v;
  }
  return env;
}

function envFor(agent) {
  const env = agent === 'claude' ? cleanEnv() : { ...process.env };
  if (SANDBOX) {
    // 演练：三家的登录状态各放在演练文件夹里
    if (agent === 'claude') env.CLAUDE_CONFIG_DIR = path.join(SANDBOX, 'claude');
    if (agent === 'gpt') env.CODEX_HOME = CODEX_HOME;
    if (agent === 'gemini' && !SANDBOX_KEEP_HOME) env.HOME = path.join(SANDBOX, 'home');
    for (const dir of [agent === 'claude' && env.CLAUDE_CONFIG_DIR, agent === 'gpt' && CODEX_HOME, agent === 'gemini' && !SANDBOX_KEEP_HOME && env.HOME]) {
      if (dir) try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建不了的话，工具自己会报错 */ }
    }
  }
  // 本软件下载的那份 Claude Code 由本软件负责更新：不让它在后台自己另装一份到别处。
  const hit = agent === 'claude' ? locate('claude') : null;
  if (hit && hit.source === 'own') env.DISABLE_AUTOUPDATER = '1';
  return env;
}

module.exports = {
  HOME, ROOT, MODE, SANDBOX, SUPPORT_DIR, DATA_DIR, TOOLS_DIR, WEB_DIR, CODEX_HOME, DEFAULT_WORKSPACE, OWN,
  isExec, idleDir, cmpVersion, locate, find, refresh, findClaude, findCodex, findAgy, cleanEnv, envFor,
};
