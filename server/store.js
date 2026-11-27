'use strict';
// 群聊记录和设置的存取。全部是本地文件：
//   data/settings.json        设置
//   data/rooms/<id>.json      群的基本信息（标题、模式、各成员的会话编号）
//   data/rooms/<id>.jsonl     消息记录，一行一条，只追加
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, ROOT, CODEX_HOME } = require('./paths');
const { AGENTS, ROLE_KEYS } = require('./members');
const ag = require('./antigravity');

const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODELS = [
  { id: '', name: '跟随账号默认' },
  { id: 'fable', name: 'Fable（最强）' },
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet（更快）' },
  { id: 'haiku', name: 'Haiku（最快）' },
];
// Gemini 这一路的模型清单不写死在这里：由 antigravity.js 向 Antigravity 现问（见 main.js 的 stateView）。

const rooms = new Map();
let settings = null;

function uid(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- Codex 的模型清单（读 ChatGPT 应用缓存在本机的列表） ----------

function codexDefaultModel() {
  try {
    const raw = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8');
    for (const line of raw.split('\n')) {
      if (/^\s*\[/.test(line)) break; // 只看最顶层的设置
      const m = line.match(/^\s*model\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
  } catch { /* 没有配置文件 */ }
  return '';
}

function codexModels() {
  const list = [{ id: '', name: '跟随 Codex 默认' }];
  const j = readJson(path.join(CODEX_HOME, 'models_cache.json'));
  for (const m of (j && j.models) || []) {
    if (!m || !m.slug || m.visibility !== 'list') continue;
    const item = { id: m.slug, name: m.display_name || m.slug, desc: m.description || '' };
    // 这个模型支持哪几档思考强度（只保留本程序认识的几档）；清单里没写就不限制。
    const levels = (m.supported_reasoning_levels || [])
      .map((x) => (typeof x === 'string' ? x : x && x.effort))
      .filter((x) => x && EFFORTS.includes(x));
    if (levels.length) item.efforts = levels;
    list.push(item);
  }
  return list;
}

// ---------- 设置 ----------

function defaults() {
  return {
    roles: { lead: 'claude', advisor: 'gemini', engineer: 'gpt' },
    workspace: path.join(ROOT, 'workspace'),
    members: {
      claude: { enabled: true, model: '', effort: '' },
      gemini: { enabled: true, model: 'gemini-4-neon', effort: 'high' },
      gpt: { enabled: true, model: codexDefaultModel(), effort: 'medium' },
    },
  };
}

function cleanModel(v, fallback) {
  const s = String(v == null ? '' : v).trim();
  return /^[\w.:\-\[\]]{0,80}$/.test(s) ? s : fallback;
}

// 把外来的设置补丁合并进现有设置，只接受认识的字段和合法的取值。
function applySettings(base, patch) {
  const out = JSON.parse(JSON.stringify(base));
  if (!patch || typeof patch !== 'object') return out;
  if (patch.roles && typeof patch.roles === 'object') {
    for (const r of ROLE_KEYS) if (AGENTS.includes(patch.roles[r])) out.roles[r] = patch.roles[r];
  }
  if (typeof patch.workspace === 'string' && patch.workspace.trim()) {
    let w = patch.workspace.trim();
    if (w === '~' || w.startsWith('~/')) w = path.join(require('os').homedir(), w.slice(1));
    if (path.isAbsolute(w)) out.workspace = path.normalize(w);
  }
  if (patch.members && typeof patch.members === 'object') {
    for (const a of AGENTS) {
      const p = patch.members[a];
      if (!p || typeof p !== 'object') continue;
      if (typeof p.enabled === 'boolean') out.members[a].enabled = p.enabled;
      if (p.model != null) out.members[a].model = cleanModel(p.model, out.members[a].model);
      // Gemini 的强度档位由 Antigravity 的清单决定（会变），这里只做格式检查；另外两位用固定的几档。
      const okEffort = a === 'gemini' ? /^[a-z0-9_]{0,16}$/.test(p.effort) : EFFORTS.includes(p.effort);
      if (p.effort != null && okEffort) out.members[a].effort = p.effort;
    }
  }
  normalizeGemini(out.members.gemini);
  return out;
}

// Gemini 的设置统一成"模型 + 强度"两项：
//   旧版本存的是合在一起的型号（如 gemini-4-neon-high），这里拆开；
//   模型不支持当前选的强度时，换成它支持的一档（优先 high）；模型没有强度可选时清空。
function normalizeGemini(g) {
  const split = ag.splitModelId(g.model);
  if (split) {
    g.model = split.model;
    g.effort = split.effort;
  }
  const m = ag.known().models.find((x) => x.id === g.model);
  if (!m) return; // 清单里没有的（手填的型号、旧的档位简称）原样保留
  if (!m.efforts.length) g.effort = '';
  else if (!m.efforts.some((e) => e.id === g.effort)) {
    g.effort = m.efforts.some((e) => e.id === 'high') ? 'high' : m.efforts[0].id;
  }
}

function getSettings() {
  return settings;
}

function updateSettings(patch) {
  settings = applySettings(settings, patch);
  writeJson(SETTINGS_FILE, settings);
  return settings;
}

function options() {
  return { claudeModels: CLAUDE_MODELS, gptModels: codexModels(), efforts: EFFORTS };
}

// ---------- 群 ----------

function metaOf(room) {
  const { messages, ...meta } = room;
  return meta;
}

function saveRoom(room) {
  writeJson(path.join(ROOMS_DIR, room.id + '.json'), metaOf(room));
}

function load() {
  fs.mkdirSync(ROOMS_DIR, { recursive: true });
  const saved = readJson(SETTINGS_FILE);
  settings = applySettings(defaults(), saved);
  // 旧格式的设置在读入时已经换成新格式：顺手写回去，文件和实际用的保持一致。
  if (saved && JSON.stringify(saved) !== JSON.stringify(settings)) writeJson(SETTINGS_FILE, settings);
  rooms.clear();
  for (const f of fs.readdirSync(ROOMS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const meta = readJson(path.join(ROOMS_DIR, f));
    if (!meta || !meta.id) continue;
    const messages = [];
    try {
      const raw = fs.readFileSync(path.join(ROOMS_DIR, meta.id + '.jsonl'), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { messages.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }
    } catch { /* 还没有消息 */ }
    rooms.set(meta.id, { mode: 'discuss', sessions: {}, ...meta, messages });
  }
}

function listRooms() {
  return [...rooms.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getRoom(id) {
  return rooms.get(id) || null;
}

function createRoom(title) {
  const now = Date.now();
  const t = String(title || '').trim().slice(0, 40);
  const room = {
    id: uid('r'),
    title: t || '新群聊',
    titled: !!t,       // 用户自己起过名字就不再自动改名
    createdAt: now,
    updatedAt: now,
    mode: 'discuss',   // discuss 只读讨论 / work 允许改工作目录里的文件
    sessions: {},      // 每位成员在自家应用里的会话编号，以及他已经读到第几条消息
    messages: [],
  };
  rooms.set(room.id, room);
  saveRoom(room);
  return room;
}

function updateRoom(room, patch) {
  if (typeof patch.title === 'string' && patch.title.trim()) {
    room.title = patch.title.trim().slice(0, 40);
    room.titled = true;
  }
  if (patch.mode === 'discuss' || patch.mode === 'work') room.mode = patch.mode;
  saveRoom(room);
  return room;
}

// 删除 = 移到 data/trash，不真正抹掉，后悔了还能找回来。
function deleteRoom(id) {
  const room = rooms.get(id);
  if (!room) return false;
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const ext of ['.json', '.jsonl']) {
    const src = path.join(ROOMS_DIR, id + ext);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(TRASH_DIR, `${stamp}_${id}${ext}`));
  }
  rooms.delete(id);
  return true;
}

function appendMessage(room, msg) {
  const m = {
    id: uid('m'),
    ts: Date.now(),
    from: msg.from,
    kind: msg.kind || 'chat',   // chat 正常发言 / system 系统提示 / error 出错提示
    text: String(msg.text == null ? '' : msg.text),
  };
  if (msg.meta) m.meta = msg.meta;
  room.messages.push(m);
  room.updatedAt = m.ts;
  fs.appendFileSync(path.join(ROOMS_DIR, room.id + '.jsonl'), JSON.stringify(m) + '\n');
  saveRoom(room);
  return m;
}

module.exports = {
  uid, load, getSettings, updateSettings, options,
  listRooms, getRoom, createRoom, updateRoom, deleteRoom, saveRoom, appendMessage,
};
