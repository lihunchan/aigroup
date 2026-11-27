'use strict';
// 群成员、分工、@ 点名的识别，以及发给每位成员的"入群须知"。

const AGENTS = ['claude', 'gemini', 'gpt'];

const INFO = {
  user: { name: '我', via: '' },
  claude: { name: 'Claude', vendor: 'Anthropic', via: 'Claude Code' },
  gemini: { name: 'Gemini', vendor: 'Google', via: 'Antigravity CLI' },
  gpt: { name: 'GPT', vendor: 'OpenAI', via: 'Codex' },
};

const ROLES = {
  lead: {
    name: '主控',
    duty: '理解需求、统筹推进；出方案和设计稿；把各方意见逐条对比、合成一份并标清取舍；定接口和验收标准；派活并验收。',
  },
  advisor: {
    name: '军师',
    duty: '独立出第二份方案；评审交互和文案；专门提供不同视角，发现问题直接指出。',
  },
  engineer: {
    name: '工程师',
    duty: '按派活单写成块的实现并给出回执；做代码审查。',
  },
};
const ROLE_KEYS = Object.keys(ROLES);

function rolesOf(agent, settings) {
  return ROLE_KEYS.filter((r) => settings.roles[r] === agent);
}

function roleLabel(agent, settings) {
  const rs = rolesOf(agent, settings);
  return rs.length ? rs.map((r) => ROLES[r].name).join(' / ') : '成员';
}

function displayName(id) {
  return (INFO[id] && INFO[id].name) || id;
}

// ---------- @ 点名 ----------

function aliasTable(settings) {
  const t = [];
  const add = (target, list) => list.forEach((a) => t.push({ alias: a.toLowerCase(), target }));
  add('claude', ['claude', '克劳德']);
  add('gemini', ['gemini', 'antigravity']);
  add('gpt', ['gpt', 'codex', 'chatgpt', 'openai']);
  add('all', ['所有人', '全体成员', '全体', '大家', 'all', 'everyone']);
  add('user', ['用户', '群主', '老板', 'user', '我']);
  for (const r of ROLE_KEYS) add(settings.roles[r], [ROLES[r].name]);
  return t.sort((a, b) => b.alias.length - a.alias.length);
}

function stripCode(text) {
  return String(text || '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

// 返回被点名的 AI（按出现顺序去重），以及是否点了用户。
function parseMentions(text, settings) {
  const src = stripCode(text);
  const table = aliasTable(settings);
  const agents = [];
  let user = false;
  const push = (a) => { if (AGENTS.includes(a) && !agents.includes(a)) agents.push(a); };
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '@' && src[i] !== '＠') continue;
    const prev = i > 0 ? src[i - 1] : '';
    if (/[A-Za-z0-9._%+-]/.test(prev)) continue; // 邮箱之类
    const rest = src.slice(i + 1, i + 24).toLowerCase();
    for (const { alias, target } of table) {
      if (!rest.startsWith(alias)) continue;
      const next = rest[alias.length] || '';
      if (/[a-z0-9]$/.test(alias) && /[a-z0-9_]/.test(next)) continue; // "@gptx" 不算
      if (target === 'all') AGENTS.forEach(push);
      else if (target === 'user') user = true;
      else push(target);
      break;
    }
  }
  return { agents, user };
}

// ---------- 提示词 ----------

function memberLine(agent, settings) {
  const rs = rolesOf(agent, settings);
  const via = agent === 'gpt' ? '（经由 Codex）' : agent === 'gemini' ? '（经由 Antigravity CLI）' : '';
  const duty = rs.length ? rs.map((r) => `${ROLES[r].name}——${ROLES[r].duty}`).join('；另兼') : '普通成员，被点名时发表意见。';
  return `- ${INFO[agent].name}${via}：${duty}`;
}

function charter(agent, room, settings) {
  const enabled = AGENTS.filter((a) => settings.members[a] && settings.members[a].enabled);
  const mine = rolesOf(agent, settings);
  const myDuty = mine.length
    ? mine.map((r) => `${ROLES[r].name}（${ROLES[r].duty}）`).join('；')
    : '普通成员，被点名时发表意见。';
  return [
    `你正在一个多 AI 协作群「${room.title}」里。这个群由一个本地程序转发消息：你的每次回复都会原样发到群里，群里所有成员都能看到。`,
    '',
    '群成员',
    '- 我（用户）：提需求、做最终拍板。',
    ...enabled.map((a) => memberLine(a, settings)),
    '',
    `你是 ${INFO[agent].name}。你在群里的分工：${myDuty}`,
    '',
    '群规',
    '1. 直接说正事。不要写"收到""好的，我来……"这类开场白，不要复述别人的原话，不要自我介绍。',
    '2. 需要某位成员接话时，在回复里写 @Claude、@Gemini 或 @GPT（@所有人 表示三位都答），被 @ 的成员会自动被叫起来回复。只是提到对方、不需要他接话时，只写名字，不要加 @。',
    '3. 拍板只属于用户。需要用户做决定时，列清选项和你的建议，以"请拍板"结尾，并且这条消息里不要再 @ 其他 AI。',
    '4. 不要 @ 自己。话题已经说清楚时，不要为了客气再 @ 别人——没有 @ 时接力自然停下，等用户发话。',
    '5. 接力是一条直线，不绕圈：把话交给下一位之后，不要再和对方就同一个问题来回 @。意见不一致时，各自把理由说清楚，然后请用户拍板。',
    '6. 用中文，简明、具体、可执行。有不同意见直接说，并给出理由。回复使用 Markdown。',
    '7. 你看不到别人的思考过程，只能看到群里的消息；别人也只能看到你发到群里的这段回复，所以结论和依据都要写在回复里。',
  ].join('\n');
}

function modeLine(agent, room, settings) {
  if (agent === 'gemini') {
    return '提醒：你在本群只做讨论和评审——需要的材料都在群消息里；不要创建、修改、删除任何文件，不要执行有副作用的命令。';
  }
  if (room.mode === 'work') {
    return `提醒：当前是「动手模式」——可以在工作目录 ${settings.workspace} 内创建和修改文件；不要动这个目录以外的任何东西。`;
  }
  return '提醒：当前是「讨论模式」——只读。不要创建、修改、删除任何文件，不要执行有副作用的命令。';
}

function formatMessage(m) {
  const who = m.from === 'user' ? '我（用户）' : displayName(m.from);
  return `〔${who}〕\n${m.text}`;
}

// 用户一条消息点了多位成员时：出现"然后/再由/等…说完"这类先后词 → 按点名顺序一个个来；否则同时各答各的。
const SEQUENCE_RE = /然后|之后|接着|随后|其后|再(由|让|请|叫|交给|给|[@＠])|最后(由|让|请|叫|再|交给)|等.{0,16}(说|答|讲|写|做|出|回复|回答|发言)(完|好)|依次|轮流|按顺序|一个一个/;

function wantsSequence(text) {
  return SEQUENCE_RE.test(stripCode(text));
}

// 自由聊天时，告诉被叫到的成员"是谁叫的你"。
function defaultInstruction(target, settings) {
  if (target.order) {
    const { index, all } = target.order;
    const line = all.map(displayName).join(' → ');
    const later = all.slice(index + 1).map(displayName);
    return [
      `用户在最新消息里按先后顺序点了几位成员：${line}。现在轮到你（第 ${index + 1} 位）。`,
      index > 0 ? '排在你前面的成员已经回复，内容就在上面。' : '',
      '只做用户要你做的那一部分。',
      later.length ? `${later.join('、')} 排在你后面，程序会自动叫到，不需要你再 @。` : '',
    ].filter(Boolean).join('\n');
  }
  const peers = (target.peers || []).map(displayName);
  const peerNote = peers.length
    ? `\n同时被叫到的还有 ${peers.join('、')}：你们各自独立回答，这一轮互相看不到对方的回复。`
    : '';
  if (target.by === 'user') {
    return (target.mentioned
      ? '用户在最新消息里 @ 了你，请回应。'
      : `用户发了新消息（没有点名），由你作为${roleLabel(target.agent, settings)}来回应。`) + peerNote;
  }
  return `${displayName(target.by)} 在上面的消息里 @ 了你，请回应。` + peerNote;
}

module.exports = {
  AGENTS, INFO, ROLES, ROLE_KEYS,
  rolesOf, roleLabel, displayName, parseMentions, wantsSequence,
  charter, modeLine, formatMessage, defaultInstruction,
};
