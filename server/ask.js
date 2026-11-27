'use strict';
// "问清需求"这一步：主控用一张带选项的提问卡片向用户提问。
// 这个文件只管两件事：
//   1. 从主控的回复里取出提问卡片（回复里的 ```ask 代码块，内容是 JSON）；
//   2. 把用户在卡片上的选择写成一条回答，发回群里。
//
// 约定：回复里带 ask 代码块 = 还要问；写了【需求已明确】= 问完了；两样都没有 = 当作普通的文字提问。

const DONE_MARK = '【需求已明确】';
const AUTO_LABEL = '你来定';
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

// 卡片上会自动带"其他（自己写）"和"你来定"。主控自己又写了这类选项的话就去掉，免得重复。
const BUILTIN_RE = /^(?:(?:其他|其它|others?)(?:\s*[（(].*[)）])?|以上都不是|都不是|你来定|你定|你决定|你来决定|由你(?:来)?(?:定|决定)|交给你(?:定|决定)?|随便|都可以|都行|无所谓)[\s。.！!…]*$/i;

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 找到回复里的提问代码块。标成 ask 的算；标成 json（或没标）但里面有 "questions" 的也算。
function findBlock(text) {
  const re = /```[ \t]*([A-Za-z]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    const lang = m[1].toLowerCase();
    if (lang === 'ask' || ((lang === 'json' || lang === '') && /"questions"\s*:/.test(m[2]))) {
      return { start: m.index, end: re.lastIndex, body: m[2] };
    }
  }
  // 开了头却没有收尾（回复被截断，或者忘了写结尾的 ```）：把后面的都当作代码块内容试试
  const open = /```[ \t]*ask[ \t]*\r?\n/i.exec(text);
  if (open) return { start: open.index, end: text.length, body: text.slice(open.index + open[0].length) };
  return null;
}

function parseJson(body) {
  const src = body.trim();
  try {
    return JSON.parse(src);
  } catch (first) {
    // 最常见的小毛病：最后一项后面多了个逗号
    try { return JSON.parse(src.replace(/,(\s*[}\]])/g, '$1')); } catch (e) { throw first; }
  }
}

// 把主控写的内容整理成固定的样子：[{ title, question, multi, options: [{ label, desc? }] }]
function normalize(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.questions) ? raw.questions : null;
  if (!list) throw new Error('里面没有 questions 数组');
  const out = [];
  for (const q of list) {
    if (!q || typeof q !== 'object') continue;
    const question = clip(q.question || q.q || q.text, 300);
    if (!question) continue;
    const seen = new Set();
    const options = [];
    for (const o of Array.isArray(q.options) ? q.options : []) {
      const label = clip(typeof o === 'string' ? o : o && (o.label || o.text || o.name), 80);
      if (!label || BUILTIN_RE.test(label) || seen.has(label)) continue;
      seen.add(label);
      const desc = o && typeof o === 'object' ? clip(o.desc || o.description, 160) : '';
      options.push(desc ? { label, desc } : { label });
      if (options.length >= MAX_OPTIONS) break;
    }
    out.push({
      title: clip(q.title || q.header, 14),
      question,
      multi: !!(q.multi || q.multiSelect || q.multiple),
      options,
    });
    if (out.length >= MAX_QUESTIONS) break;
  }
  if (!out.length) throw new Error('questions 里没有一个有效的问题（每个问题至少要有 question）');
  return out;
}

// 读主控的一条回复。
//   有提问卡片 → { intro: 卡片以外的话, questions: [...], done: false }
//   没有卡片   → { intro: 原文, questions: null, done: 是否写了【需求已明确】 }
//   卡片写坏了 → 同上，另带 error（说明哪里读不出来）
function parse(text) {
  const src = String(text || '');
  const block = findBlock(src);
  if (!block) return { intro: src.trim(), questions: null, done: src.includes(DONE_MARK) };
  let questions;
  try {
    questions = normalize(parseJson(block.body.replace(/`+\s*$/, '')));
  } catch (e) {
    return { intro: src.trim(), questions: null, done: false, error: e.message || String(e) };
  }
  const intro = (src.slice(0, block.start) + '\n' + src.slice(block.end))
    .split(DONE_MARK).join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { intro, questions, done: false };
}

function heading(q, i) {
  return `${i + 1}. ${q.title ? `〔${q.title}〕` : ''}${q.question}`;
}

// 把提问写成普通文字：存进聊天记录，别的成员（以及不认识卡片的旧页面）看到的就是这个。
function plain(questions) {
  return questions.map((q, i) => {
    const opts = q.options.map((o) => `   - ${o.label}${o.desc ? `：${o.desc}` : ''}`);
    return [heading(q, i) + (q.multi ? '（可多选）' : ''), ...opts].join('\n');
  }).join('\n');
}

// 把用户在卡片上的选择整理成一条回答。
// items[i] 对应第 i 个问题：{ picks: [选中的选项文字…], other: '自己写的话', auto: 是否选了"你来定" }
function answer(questions, items) {
  const list = Array.isArray(items) ? items : [];
  const norm = [];
  const lines = ['回答主控的提问：'];
  questions.forEach((q, i) => {
    const it = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const labels = q.options.map((o) => o.label);
    let picks = (Array.isArray(it.picks) ? it.picks : []).map(String)
      .filter((p, k, arr) => labels.includes(p) && arr.indexOf(p) === k);
    let other = String(it.other == null ? '' : it.other).trim().slice(0, 2000);
    if (!q.multi) { // 单选：选项、自己写、你来定，三者只取其一
      picks = picks.slice(0, 1);
      if (picks.length) other = '';
    }
    const auto = !picks.length && !other && !!it.auto;
    if (!auto && !picks.length && !other) {
      const e = new Error(`第 ${i + 1} 个问题还没有回答`);
      e.status = 400;
      throw e;
    }
    norm.push({ picks, other, auto });
    const said = auto
      ? `${AUTO_LABEL}（交给主控决定）`
      : [...picks, other ? `其他：${other}` : ''].filter(Boolean).join('；');
    lines.push(`${heading(q, i)}\n   → ${said}`);
  });
  return { text: lines.join('\n'), items: norm };
}

module.exports = { DONE_MARK, AUTO_LABEL, parse, plain, answer };
