'use strict';
// 检查三位成员是否"叫得动"：对应的应用装了没有、登录了没有、在不在运行。
const fs = require('fs');
const paths = require('./paths');
const { runProcess } = require('./proc');
const { cleanEnv } = require('./drivers/claude');
const ag = require('./antigravity');

let cache = null;
let cacheAt = 0;
let pending = null;

async function capture(bin, args, env) {
  let out = '';
  try {
    const res = await runProcess(bin, args, { env, timeoutMs: 12000, onLine: (l) => { out += l + '\n'; } });
    return { out, err: res.stderr || '', code: res.code };
  } catch (e) {
    return { out, err: String(e.message || e), code: -1 };
  }
}

async function checkClaude() {
  const bin = paths.findClaude();
  if (!bin) return { state: 'missing', detail: '没有找到 Claude Code（需要安装 Claude 桌面应用）' };
  const r = await capture(bin, ['auth', 'status'], cleanEnv());
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* 旧版本可能不是 JSON */ }
  if (j && j.loggedIn) return { state: 'ok', detail: '已登录' + (j.subscriptionType ? `（${j.subscriptionType}）` : '') };
  if (j) return { state: 'login', detail: '还没有单独登录：双击文件夹里的「登录Claude.command」完成一次登录' };
  if (/logged in/i.test(r.out + r.err) && !/not logged in/i.test(r.out + r.err)) return { state: 'ok', detail: '已登录' };
  return { state: 'login', detail: '还没有单独登录：双击文件夹里的「登录Claude.command」完成一次登录' };
}

async function checkCodex() {
  const bin = paths.findCodex();
  if (!bin) return { state: 'missing', detail: '没有找到 Codex（需要安装 ChatGPT 桌面应用）' };
  const r = await capture(bin, ['login', 'status']);
  const text = r.out + r.err;
  if (/logged in/i.test(text) && !/not logged in/i.test(text)) return { state: 'ok', detail: text.trim().split('\n')[0].replace(/Logged in using\s*/, '已登录 · ') };
  return { state: 'login', detail: '还没有登录：打开 ChatGPT 桌面应用并登录账号' };
}

async function checkGemini(force) {
  if (!paths.findAgy()) return { state: 'missing', detail: '没有找到 Antigravity CLI（agy 命令）' };
  // 能列出模型，就说明它装好了、也登录了（清单 10 分钟内问过就不重复问）。
  await ag.catalog(force).catch(() => {});
  const c = ag.cliState();
  if (!c || c.ok) return { state: 'ok', detail: 'Antigravity CLI 可用' };
  if (/authentication required|not authenticated|unauthenticated|sign in|signed out|log ?in\b/i.test(c.error)) {
    return { state: 'login', detail: 'Antigravity CLI 还没有登录：打开 Antigravity 应用登录 Google 账号即可（两边共用同一份登录）' };
  }
  return { state: 'error', detail: `Antigravity CLI 现在连不上：${c.error}` };
}

// Claude 和 GPT 的检查要启动一次命令行，结果缓存 5 分钟；Gemini 每次现查（复用模型清单的结果，清单本身 10 分钟才重新问一次）。
const TTL = 5 * 60 * 1000;

async function check(force) {
  if (!force && cache && Date.now() - cacheAt < TTL) {
    cache = { ...cache, gemini: await checkGemini(false) };
    return cache;
  }
  if (pending) return pending;
  pending = Promise.all([checkClaude(), checkGemini(!!force), checkCodex()])
    .then(([claude, gem, gpt]) => {
      cache = { claude, gemini: gem, gpt };
      cacheAt = Date.now();
      return cache;
    })
    .finally(() => { pending = null; });
  return pending;
}

function peek() {
  return cache;
}

// 让下一次检查重新去问（例如某位成员刚报了"未登录"，或者刚恢复正常）。
function invalidate() {
  cacheAt = 0;
}

module.exports = { check, peek, invalidate };
