'use strict';
// "把成员接进来"：电脑上没有它的命令行工具时先从官方下载，再带你完成一次登录，最后确认它叫得动。
//
// 登录走的都是各家工具自己的登录流程——浏览器里打开的是各家官方的页面，登录凭据由各家工具自己保存。
// 本程序只负责"启动登录、等它完成"，不接触账号密码，也不读取或保存任何登录凭据。
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const paths = require('./paths');
const tools = require('./tools');
const health = require('./health');
const M = require('./members');
const { runProcess, sleep } = require('./proc');

const bus = new EventEmitter();
const jobs = new Map(); // 成员 → 他当前（或最近一次）的连接任务

const LOGIN_MS = Number(process.env.AIGROUP_LOGIN_MS) || 15 * 60 * 1000; // 等你在浏览器里登录，最多等这么久（环境变量只在测试时用）
const POLL_MS = 3000;
const EXPECT = '/usr/bin/expect';

// 每位成员登录时要用到的账号（显示在引导页上）。
const ACCOUNT = {
  claude: { site: 'Claude', need: '需要 Claude 账号，并且订阅了能用 Claude Code 的方案（Pro、Max 等）' },
  gemini: { site: 'Google', need: '需要 Google 账号（免费账号也可以，只是额度少一些）' },
  gpt: { site: 'ChatGPT', need: '需要 ChatGPT 账号，并且订阅了能用 Codex 的方案（一般是 Plus 及以上）' },
};

// ---------- 任务 ----------
// 阶段（phase）：
//   query 问官方最新版本 → download 下载 → verify 校验 → check 确认登录状态 → login 等你在浏览器里登录
//   → ok 已连接 / failed 没成 / cancelled 取消了
// terminal：这次登录是不是改在"终端"窗口里手动完成的（备用办法）。

function view(job) {
  if (!job) return null;
  return {
    id: job.id, agent: job.agent, phase: job.phase, terminal: !!job.terminal,
    done: job.done || 0, total: job.total || 0, version: job.version || '',
    error: job.error || '', hint: job.hint || '',
    startedAt: job.startedAt, endedAt: job.endedAt || 0,
  };
}

function active(job) {
  return !!job && !job.endedAt;
}

function emit(job, extra) {
  bus.emit('event', { type: 'setup', agent: job.agent, job: view(job), ...(extra || {}) });
}

function set(job, patch) {
  if (job.endedAt) return;
  Object.assign(job, patch);
  emit(job);
}

async function finish(job, phase, error, hint) {
  if (job.endedAt) return;
  job.phase = phase;
  job.error = error || '';
  job.hint = hint || '';
  job.endedAt = Date.now();
  health.invalidate();
  // 结果连同这位成员最新的状态一起推给页面，侧栏的小圆点马上就能变
  const h = await health.checkOne(job.agent, true).catch(() => null);
  const tool = await tools.info(job.agent).catch(() => null);
  emit(job, { health: h, tool });
}

function cancelled(job) {
  return job.ac.signal.aborted;
}

// ---------- 三家各自的登录 ----------
// 每个函数启动那家工具自己的登录命令，并一直等到它结束（或者被叫停）。

function loginClaude(signal) {
  // 它会自己打开浏览器；你在页面上同意之后，浏览器把结果交回给它，不需要再回来输入什么。
  return runProcess(paths.findClaude(), ['auth', 'login'], {
    env: paths.envFor('claude'), cwd: paths.idleDir(), signal, timeoutMs: LOGIN_MS, holdStdin: true,
  });
}

function loginCodex(signal) {
  return runProcess(paths.findCodex(), ['login'], {
    env: paths.envFor('gpt'), cwd: paths.idleDir(), signal, timeoutMs: LOGIN_MS, holdStdin: true,
  });
}

// Antigravity CLI 没有单独的"登录"命令：第一次启动它的界面时，它会先问用哪种方式登录，再打开浏览器。
// 这里借系统自带的 expect 给它一个看不见的终端，替你在第一个问题上按一下回车（选"Google OAuth"，也就是个人 Google 账号）。
const AGY_SCRIPT = [
  'set timeout -1',
  'set stty_init "rows 40 columns 120"',
  'log_user 0',
  'spawn -noecho $env(AIGROUP_LOGIN_BIN)',
  'expect {',
  '  "Select login method" { sleep 0.6; send "\\r" }',
  '  eof { exit 0 }',
  '}',
  'expect eof',
  'exit 0',
].join('\n');

function loginAgy(signal) {
  const env = { ...paths.envFor('gemini'), TERM: 'xterm-256color', AIGROUP_LOGIN_BIN: paths.findAgy() };
  return runProcess(EXPECT, ['-c', AGY_SCRIPT], { env, cwd: paths.idleDir(), signal, timeoutMs: LOGIN_MS, holdStdin: true });
}

const LOGIN = { claude: loginClaude, gpt: loginCodex, gemini: loginAgy };

function canAutoLogin(agent) {
  return agent !== 'gemini' || paths.isExec(EXPECT);
}

// 备用办法：开一个"终端"窗口，让你直接面对那家工具自己的登录界面。
function openTerminalLogin(agent) {
  const bin = paths.find(agent);
  const env = paths.envFor(agent);
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const lines = ['#!/bin/bash', `cd ${q(paths.idleDir())} || cd`, 'clear', `printf '\\n  AI 群聊 · 登录 ${M.INFO[agent].name}\\n\\n'`];
  // 演练模式下，登录状态要落在演练文件夹里
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    if (paths.SANDBOX && env[k]) lines.push(`export ${k}=${q(env[k])}`);
  }
  if (paths.SANDBOX && agent === 'gemini') lines.push(`export HOME=${q(env.HOME)}`);
  if (agent === 'claude') {
    lines.push("printf '  浏览器会打开 Claude 的登录页。登录并同意之后，回到「AI 群聊」就行。\\n\\n'", `${q(bin)} auth login`);
  } else if (agent === 'gpt') {
    lines.push("printf '  浏览器会打开 ChatGPT 的登录页。登录完成后，回到「AI 群聊」就行。\\n\\n'", `${q(bin)} login`);
  } else {
    lines.push(
      "printf '  接下来是 Antigravity 自己的界面：\\n'",
      "printf '  1. 看到 Select login method 时直接按回车（选 Google OAuth）；\\n'",
      "printf '  2. 在浏览器里用 Google 账号登录；\\n'",
      "printf '  3. 「AI 群聊」显示已连接后，关掉这个窗口即可。\\n\\n'",
      "printf '  按回车开始…'", 'read -r _', q(bin));
  }
  lines.push("printf '\\n  可以关掉这个窗口了。\\n\\n'");
  const file = path.join(paths.SUPPORT_DIR, `登录 ${M.INFO[agent].name}.command`);
  fs.mkdirSync(paths.SUPPORT_DIR, { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  spawn('/usr/bin/open', [file], { stdio: 'ignore', detached: true }).unref();
}

// 启动登录，然后隔几秒问一次"登录上了吗"：一登上就算完成，不必等那个登录命令自己退出。
async function waitForLogin(job) {
  const { agent } = job;
  const inner = new AbortController();
  const stop = () => inner.abort();
  job.ac.signal.addEventListener('abort', stop, { once: true });
  let exited = false;
  let result = null;
  let proc = null;
  try {
    if (job.terminal) {
      openTerminalLogin(agent);
    } else {
      proc = LOGIN[agent](inner.signal).then(
        (r) => { exited = true; result = r; },
        (e) => { exited = true; result = { error: e }; });
    }
    const deadline = Date.now() + LOGIN_MS;
    await sleep(job.terminal ? 4000 : 2500, job.ac.signal);
    while (!cancelled(job) && Date.now() < deadline) {
      const h = await health.checkOne(agent, true);
      if (h.state === 'ok') {
        if (proc && !exited) await sleep(1500, job.ac.signal); // 让它把该存的存完
        return true;
      }
      if (exited) break; // 登录命令自己结束了，而且没登上
      await Promise.race([sleep(POLL_MS, job.ac.signal), proc || new Promise(() => {})]);
    }
    if (exited && result && !cancelled(job)) {
      const raw = result.error ? String(result.error.message || result.error) : (result.stderr || '').trim();
      // 登录页还没走完就退出了：把它留下的最后一句话带上，方便判断原因
      job.note = raw.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ').slice(0, 300);
    }
    return false;
  } finally {
    job.ac.signal.removeEventListener('abort', stop);
    inner.abort();
    if (proc) await proc;
  }
}

async function runJob(job, opts) {
  const { agent } = job;
  const t = tools.TOOLS[agent];
  try {
    // 1. 工具：电脑上没有（或者要更新本软件下载的那一份）就从官方下载
    if (!paths.find(agent) || opts.update) {
      await tools.install(agent, {
        signal: job.ac.signal,
        onProgress: (p) => { if (p.phase !== 'done') set(job, { phase: p.phase, done: p.done || 0, total: p.total || 0, version: p.version || job.version }); },
      });
    }
    // 2. 已经登录了就不用再登
    set(job, { phase: 'check', done: 0, total: 0 });
    let h = await health.checkOne(agent, true);
    if (h.state === 'login') {
      if (!job.terminal && !canAutoLogin(agent)) {
        return finish(job, 'failed', `这台电脑上没法由软件代为启动 ${t.tool} 的登录。`, 'terminal');
      }
      set(job, { phase: 'login' });
      const ok = await waitForLogin(job);
      if (cancelled(job)) return finish(job, 'cancelled');
      set(job, { phase: 'check' });
      h = ok ? { state: 'ok' } : await health.checkOne(agent, true);
    }
    if (cancelled(job)) return finish(job, 'cancelled');
    if (h.state === 'ok') return finish(job, 'ok');
    if (h.state === 'login') {
      return finish(job, 'failed', '登录没有完成。' + (job.note ? `（${t.tool} 的提示：${job.note}）` : '可以再试一次。'), job.terminal ? '' : 'terminal');
    }
    return finish(job, 'failed', h.detail || `${M.INFO[agent].name} 现在叫不动。`);
  } catch (e) {
    if (cancelled(job) || e.code === 'ABORTED') return finish(job, 'cancelled');
    return finish(job, 'failed', e.message || String(e));
  }
}

// 开始连接某位成员。opts：{ terminal: 改用"终端"窗口登录, update: 先把本软件下载的那份工具更新到最新 }
function start(agent, opts = {}) {
  if (!M.AGENTS.includes(agent)) throw Object.assign(new Error('没有这位成员'), { status: 404 });
  const cur = jobs.get(agent);
  if (active(cur)) return view(cur);
  if (opts.update) {
    const hit = paths.locate(agent);
    if (hit && hit.source !== 'own') throw Object.assign(new Error('这份工具不是本软件下载的，由它自己（或它所属的应用）负责更新。'), { status: 400 });
  }
  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    agent, phase: 'check', terminal: !!opts.terminal, ac: new AbortController(), startedAt: Date.now(),
  };
  jobs.set(agent, job);
  emit(job);
  runJob(job, opts).catch((e) => finish(job, 'failed', e.message || String(e)));
  return view(job);
}

function cancel(agent) {
  const job = jobs.get(agent);
  if (active(job)) job.ac.abort();
  return view(job);
}

function cancelAll() {
  for (const job of jobs.values()) if (active(job)) job.ac.abort();
}

// 三位成员现在各是什么情况：工具装了没有、是哪一份、登录了没有、有没有正在进行的连接任务。
async function status(force) {
  const h = await health.check(force);
  const out = {};
  await Promise.all(M.AGENTS.map(async (a) => {
    const tool = await tools.info(a);
    out[a] = {
      ...tool,
      state: (h[a] && h[a].state) || '',
      detail: (h[a] && h[a].detail) || '',
      account: ACCOUNT[a],
      job: view(jobs.get(a)),
    };
  }));
  return out;
}

// 本软件下载的那份工具有没有新版本：{ current, latest, newer }
async function checkUpdate(agent) {
  if (!M.AGENTS.includes(agent)) throw Object.assign(new Error('没有这位成员'), { status: 404 });
  const tool = await tools.info(agent);
  const rel = await tools.latest(agent, undefined, true);
  return {
    current: tool.version, latest: rel.version, size: rel.size || 0, source: tool.source,
    newer: !!tool.version && !!rel.version && paths.cmpVersion(rel.version, tool.version) > 0,
  };
}

// 下载之前先告诉你要下多大的东西：{ claude: { version, size }, … }（只问还没装的）
async function sizes() {
  const out = {};
  await Promise.all(M.AGENTS.map(async (a) => {
    if (paths.find(a)) return;
    try {
      const rel = await tools.latest(a);
      out[a] = { version: rel.version, size: rel.size || 0 };
    } catch { /* 问不到就不显示大小 */ }
  }));
  return out;
}

module.exports = { bus, start, cancel, cancelAll, status, checkUpdate, sizes, ACCOUNT };
