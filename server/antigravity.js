'use strict';
// 问 Antigravity"现在有哪些模型、每个模型支持哪几档强度"。
// 用的是官方命令行的 `agy models`：直接连 Google 的服务，不需要 Antigravity 应用开着。
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { runProcess } = require('./proc');

const CACHE_FILE = path.join(paths.DATA_DIR, 'antigravity-models.json');
const TTL = 10 * 60 * 1000;

// ---------- 模型清单 ----------
// 每一项：{ id, name, note, efforts: [{ id, name }] }
//   有强度可选的模型：id 是"模型"本身（如 gemini-4-neon），真正交给 agy 的型号是 id + "-" + 强度；
//   没有强度可选的模型：efforts 为空，id 就是完整型号。

const L3 = [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }];
const L4 = [...L3, { id: 'xhigh', name: 'XHigh' }];

// 2026-11-27 在这台电脑上取到的清单：一时问不到、又没有缓存时用它垫底。
const BUILTIN = {
  defaultId: 'gemini-4-neon-high',
  models: [
    { id: 'gemini-4-neon', name: 'Gemini 4 Neon', note: '', efforts: L4 },
    { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', note: '', efforts: L3 },
    { id: 'gemini-4-argon', name: 'Gemini 4 Argon', note: '', efforts: L3 },
    { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', note: '', efforts: L4 },
    { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)', note: '', efforts: [] },
    { id: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)', note: '', efforts: [] },
    { id: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)', note: '', efforts: [] },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', note: '', efforts: L3 },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: '', efforts: L3 },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: '', efforts: L3 },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', note: '', efforts: [] },
  ],
};

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// agy models 一行一个型号："gemini-4-neon-high<Tab>Gemini 4 Neon (High)"。
// 型号以强度结尾、名字的括号里也是强度的，归成一个模型的几档强度；只有一档的就当作没有强度可选。
function normalizeCli(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\S+)\t(.+)$/);
    if (m) rows.push({ id: m[1], name: m[2].trim() });
  }
  const order = [];
  const families = new Map();
  for (const r of rows) {
    const byId = r.id.match(/^(.+)-(minimal|low|medium|high|xhigh|max)$/);
    const byName = r.name.match(/^(.*?)\s*\(([^()]+)\)$/);
    if (byId && byName) {
      let fam = families.get(byId[1]);
      if (!fam) {
        fam = { id: byId[1], name: byName[1], levels: [] };
        families.set(byId[1], fam);
        order.push(fam);
      }
      fam.levels.push({ id: byId[2], name: byName[2], full: r });
    } else {
      order.push({ id: r.id, name: r.name, levels: null });
    }
  }
  const models = order.map((x) => {
    if (!x.levels) return { id: x.id, name: x.name, note: '', efforts: [] };
    if (x.levels.length < 2) return { id: x.levels[0].full.id, name: x.levels[0].full.name, note: '', efforts: [] };
    const efforts = x.levels
      .sort((a, b) => EFFORT_ORDER.indexOf(a.id) - EFFORT_ORDER.indexOf(b.id))
      .map((l) => ({ id: l.id, name: l.name }));
    return { id: x.id, name: x.name, note: '', efforts };
  });
  const preferred = 'gemini-4-neon-high';
  return { defaultId: rows.some((r) => r.id === preferred) ? preferred : (rows[0] ? rows[0].id : ''), models };
}

// 最近一次问命令行的结果，成员状态检测也用它：{ ok, error, at }
let cli = null;

async function fetchCli() {
  let out = '';
  try {
    const bin = paths.findAgy();
    if (!bin) throw new Error('没有找到 Antigravity CLI（agy 命令）');
    const res = await runProcess(bin, ['models'], { timeoutMs: 25000, onLine: (l) => { out += l + '\n'; } });
    const n = normalizeCli(out);
    if (res.code !== 0 || !n.models.length) {
      throw new Error((res.stderr || '').trim().split('\n').slice(-3).join(' ') || `agy models 退出码 ${res.code}`);
    }
    cli = { ok: true, error: '', at: Date.now() };
    return n;
  } catch (e) {
    cli = { ok: false, error: String(e.message || e).slice(0, 300), at: Date.now() };
    throw e;
  }
}

function cliState() {
  return cli;
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && Array.isArray(j.models) && j.models.length) return j;
  } catch { /* 还没有缓存 */ }
  return null;
}

let mem = null; // { models, defaultId, fetchedAt, source: 'live' | 'cache' | 'builtin' }
let pending = null;

// 不等网络、立刻可用的"目前已知的清单"。
function known() {
  if (mem) return mem;
  const disk = readCache();
  mem = disk ? { ...disk, source: 'cache' } : { ...BUILTIN, fetchedAt: 0, source: 'builtin' };
  return mem;
}

async function refresh() {
  try {
    const n = await fetchCli();
    mem = { ...n, fetchedAt: Date.now(), source: 'live' };
    try {
      fs.mkdirSync(paths.DATA_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ models: mem.models, defaultId: mem.defaultId, fetchedAt: mem.fetchedAt }, null, 2));
    } catch { /* 缓存写不进去不影响使用 */ }
  } catch {
    const cur = known();
    if (cur.source === 'live') mem = { ...cur, source: 'cache' }; // 这次没问到：先沿用旧的，下次再问
  }
  return known();
}

// 最新的清单：10 分钟内问过就直接用，否则现问一次；问不到就退回缓存或内置清单。
async function catalog(force) {
  const cur = known();
  if (!force && cur.source === 'live' && Date.now() - cur.fetchedAt < TTL) return cur;
  if (!pending) pending = refresh().finally(() => { pending = null; });
  return pending;
}

// 设置里存的是"模型 + 强度"两项，这里合成真正交给 agy 的型号。
function resolveModelId(model, effort) {
  const m = known().models.find((x) => x.id === model);
  if (!m) return effort ? `${model}-${effort}` : model; // 清单里没有的（手填的）：原样使用
  if (!m.efforts.length) return m.id;
  const ok = m.efforts.some((e) => e.id === effort);
  const pick = ok ? effort : (m.efforts.some((e) => e.id === 'high') ? 'high' : m.efforts[0].id);
  return `${m.id}-${pick}`;
}

// 反过来：把一个完整型号（如 gemini-4-neon-high）拆成"模型 + 强度"。拆不出来返回 null。
function splitModelId(id) {
  for (const m of known().models) {
    if (m.id === id) return null; // 本身就是清单里的一项，不用拆
  }
  for (const m of known().models) {
    for (const e of m.efforts) if (id === `${m.id}-${e.id}`) return { model: m.id, effort: e.id };
  }
  return null;
}

module.exports = { catalog, known, resolveModelId, splitModelId, cliState, normalizeCli };
