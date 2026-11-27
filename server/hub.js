'use strict';
// 群聊的调度中心：收到一条消息后决定叫谁、按什么顺序叫，并把每个人的回复发回群里。
//
// 几条核心规矩：
//   1. 用户不点名 → 主控回应；点了谁 → 谁回应。
//   2. AI 的回复里 @ 了别的 AI → 自动把对方叫起来（这就是"直接沟通"）。
//   3. 同一条消息叫到多位 → 他们同时作答，这一轮互相看不到对方的回复（"各出一份"）。
//   4. 回复里没有再 @ 谁，接力就自然停下，等用户发话；用户随时可以点"停止"。
//   5. 固定流程（flows.js）由程序按步骤叫人，流程中的回复不再触发 @ 接力。
//   6. 流程里"问清需求"这种步骤：主控提问后流程停下来等用户回答，答完再接着走（可以来回很多轮）。
const EventEmitter = require('events');
const fs = require('fs');
const store = require('./store');
const M = require('./members');
const flows = require('./flows');
const ask = require('./ask');

const drivers = {
  claude: require('./drivers/claude'),
  gemini: require('./drivers/gemini'),
  gpt: require('./drivers/codex'),
};

const HISTORY_BUDGET = 90000; // 一次最多带给成员的群聊记录字数

const bus = new EventEmitter();
bus.setMaxListeners(0);
const emit = (ev) => bus.emit('event', ev);

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- 每个群的运行状态（只在内存里） ----------

const runtimes = new Map();
function rt(roomId) {
  let r = runtimes.get(roomId);
  if (!r) {
    r = { queue: [], pumping: false, running: new Map(), flow: null };
    runtimes.set(roomId, r);
  }
  return r;
}

function isBusy(roomId) {
  const r = runtimes.get(roomId);
  return !!r && (r.pumping || r.queue.length > 0 || r.running.size > 0);
}

function typingView(st) {
  return {
    startedAt: st.startedAt,
    status: st.status,
    partial: st.partial,
    activity: st.activity.slice(-6),
    step: st.step || null,
  };
}

function flowView(run) {
  if (!run) return null;
  return {
    runId: run.id, id: run.flowId, name: run.name, icon: run.icon, next: run.next,
    state: run.state, steps: run.steps.map((s) => ({ label: s.label, agents: s.agents, state: s.state, ask: !!s.ask })),
    // 流程停在"等你回答"时：等的是哪一条提问、第几轮、有没有选项卡片
    wait: run.wait ? { askId: run.wait.askId, round: run.wait.round, card: !!run.wait.card } : null,
  };
}

function summary(room) {
  const last = [...room.messages].reverse().find((m) => m.kind === 'chat');
  return {
    id: room.id,
    title: room.title,
    mode: room.mode,
    updatedAt: room.updatedAt,
    count: room.messages.length,
    busy: isBusy(room.id),
    waiting: !!room.wait, // 有提问在等用户回答
    last: last ? { from: last.from, text: last.text.replace(/\s+/g, ' ').slice(0, 60) } : null,
  };
}

function roomSummaries() {
  return store.listRooms().map(summary);
}

function roomView(roomId) {
  const room = store.getRoom(roomId);
  if (!room) throw httpError(404, '找不到这个群');
  const r = restoreFlow(room);
  const typing = {};
  for (const [agent, st] of r.running) typing[agent] = typingView(st);
  return {
    id: room.id, title: room.title, mode: room.mode, createdAt: room.createdAt,
    messages: room.messages, typing, flow: flowView(r.flow), busy: isBusy(roomId),
  };
}

let roomsTimer = null;
function emitRooms() {
  if (roomsTimer) return;
  roomsTimer = setTimeout(() => {
    roomsTimer = null;
    emit({ type: 'rooms', rooms: roomSummaries() });
  }, 60);
}

function post(room, msg) {
  const m = store.appendMessage(room, msg);
  emit({ type: 'message', roomId: room.id, message: m });
  emitRooms();
  return m;
}

function emitFlow(room) {
  emit({ type: 'flow', roomId: room.id, flow: flowView(rt(room.id).flow) });
}

function emitTyping(room, st, immediate) {
  const send = () => {
    st.timer = null;
    st.sentAt = Date.now();
    if (!st.finished) emit({ type: 'typing', roomId: room.id, agent: st.agent, state: typingView(st) });
  };
  if (immediate) {
    clearTimeout(st.timer);
    return send();
  }
  if (st.timer) return;
  st.timer = setTimeout(send, Math.max(0, 90 - (Date.now() - (st.sentAt || 0))));
}

// ---------- 组装发给成员的提示词 ----------

function buildPrompt(room, target, settings) {
  const agent = target.agent;
  const sess = room.sessions[agent] || (room.sessions[agent] = { id: null, seen: 0 });
  const fresh = !sess.id;
  const snapshot = room.messages.length;

  // 老会话只补"上次发言之后"的新消息；新会话把群聊记录从头带上（太长就只带最近的）。
  let msgs = room.messages.slice(fresh ? 0 : Math.min(sess.seen || 0, snapshot), snapshot).filter((m) => m.kind === 'chat');
  if (!fresh) msgs = msgs.filter((m) => m.from !== agent);

  const kept = [];
  let used = 0;
  let dropped = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const len = msgs[i].text.length + 30;
    if (kept.length && used + len > HISTORY_BUDGET) { dropped = i + 1; break; }
    used += len;
    kept.unshift(msgs[i]);
  }

  const parts = [];
  if (fresh) parts.push(M.charter(agent, room, settings));
  if (kept.length) {
    const head = fresh ? '【群聊记录】' : '【群聊新消息】（你上次发言之后）';
    const note = dropped ? `\n（更早的 ${dropped} 条消息已省略）` : '';
    parts.push(`${head}${note}\n\n${kept.map(M.formatMessage).join('\n\n')}`);
  }
  const instruction = target.instruction || M.defaultInstruction(target, settings);
  parts.push(`【轮到你（${M.displayName(agent)}）发言】\n${instruction}\n\n${M.modeLine(agent, room, settings)}`);
  return { text: parts.join('\n\n————————\n\n'), snapshot };
}

// ---------- 叫一位成员发言 ----------

function ensureWorkspace(settings) {
  try {
    fs.mkdirSync(settings.workspace, { recursive: true });
    return settings.workspace;
  } catch (e) {
    throw new Error(`工作目录不可用：${settings.workspace}（${e.code || e.message}）。请到设置里换一个文件夹。`);
  }
}

async function runTurn(room, r, round, target) {
  const agent = target.agent;
  const settings = store.getSettings();
  const cfg = settings.members[agent] || {};
  const ac = new AbortController();
  const st = {
    agent, startedAt: Date.now(), status: '正在连接…', partial: '', activity: [],
    abort: ac, timer: null, sentAt: 0, finished: false,
    step: round.flowRun ? round.flowRun.steps[round.stepIndex].label : null,
  };
  r.running.set(agent, st);
  emitTyping(room, st, true);
  emitRooms();

  const onEvent = (ev) => {
    if (ev.type === 'status') st.status = ev.text;
    else if (ev.type === 'partial') {
      st.partial = ev.text;
      if (ev.text) st.status = '正在输入…';
    } else if (ev.type === 'activity') {
      st.activity.push(ev.item);
      st.status = `${ev.item.kind === 'cmd' ? '执行了命令' : ev.item.kind === 'edit' ? '改了文件' : ev.item.kind === 'search' ? '搜索了' : '用了工具'}：${ev.item.text}`;
    }
    emitTyping(room, st);
  };

  // 实际要用的型号：多数成员就是设置里的"模型"；Gemini 要把"模型 + 强度"合成一个型号。
  const wantModel = drivers[agent].modelId
    ? drivers[agent].modelId(cfg.model || '', cfg.effort || '')
    : (cfg.model || '');
  const attempt = async (forceFresh, instruction) => {
    if (forceFresh) room.sessions[agent] = { id: null, seen: 0 };
    const cwd = ensureWorkspace(settings);
    const { text: prompt, snapshot } = buildPrompt(room, instruction ? { ...target, instruction } : target, settings);
    const out = await drivers[agent].run({
      prompt,
      sessionId: room.sessions[agent].id,
      model: wantModel,
      effort: cfg.effort || '',
      cwd,
      canWrite: room.mode === 'work' && agent !== 'gemini',
      title: `群聊·${room.title}`,
      onEvent,
      signal: ac.signal,
    });
    room.sessions[agent] = { id: out.sessionId || room.sessions[agent].id, seen: snapshot, model: wantModel };
    store.saveRoom(room);
    return out;
  };

  try {
    let out;
    try {
      out = await attempt(false);
    } catch (e) {
      // 成员在自家应用里的那场对话找不到了：开一场新的，把群聊记录重新带上。
      if (e.code !== 'SESSION_LOST') throw e;
      out = await attempt(true);
    }
    let text = String(out.text || '').trim();
    // 这一轮是"主控向用户提问"：看看回复里有没有提问卡片。
    let parsed = target.ask ? ask.parse(text) : null;
    if (parsed && parsed.error && !target.ask.final) {
      // 卡片写坏了（不是合法的 JSON）：这条先不发到群里，请他重写一次。
      st.status = '提问卡片的格式不对，正在请他重写…';
      st.partial = '';
      emitTyping(room, st, true);
      try {
        out = await attempt(false, target.ask.repair(parsed.error));
        text = String(out.text || '').trim();
        parsed = ask.parse(text);
      } catch (e) {
        if (e.code === 'ABORTED' || ac.signal.aborted) throw e;
        // 重写没成功：就把原来那条当普通文字发出去，用户可以直接用文字回答
      }
    }
    const meta = {
      model: out.model || '',
      ms: Date.now() - st.startedAt,
      activity: st.activity.slice(-30),
    };
    if (out.usage) meta.usage = out.usage;
    if (round.flowRun) meta.flow = { id: round.flowRun.flowId, name: round.flowRun.name, step: st.step, index: round.stepIndex, runId: round.flowRun.id };
    if (parsed) {
      if (parsed.questions && !target.ask.final) {
        // 有提问卡片：卡片的内容放在 meta.ask 里给页面画；正文存成普通文字，别的成员照样看得懂。
        const intro = parsed.intro || '我先确认几个问题：';
        meta.ask = { round: target.ask.round, intro, questions: parsed.questions };
        text = `${intro}\n\n${ask.plain(parsed.questions)}`;
      } else if (parsed.done || target.ask.final) {
        meta.askDone = true; // 问清楚了（或者用户说别问了）：这一步结束
        if (parsed.questions) text = parsed.intro || '（没有再提问，直接进入下一步。）';
      }
      // 两样都不是（没有卡片，也没说问清楚了）：当作普通的文字提问，等用户用文字回答。
    }
    const message = post(room, { from: agent, kind: 'chat', text: text || '（这一轮没有文字内容）', meta });
    return { agent, ok: true, message };
  } catch (e) {
    if (e.code === 'ABORTED' || ac.signal.aborted) return { agent, ok: false, aborted: true };
    post(room, { from: agent, kind: 'error', text: e.message || String(e), meta: { code: e.code || 'FAILED' } });
    return { agent, ok: false, error: e };
  } finally {
    st.finished = true;
    clearTimeout(st.timer);
    r.running.delete(agent);
    emit({ type: 'typing', roomId: room.id, agent, state: null });
  }
}

// ---------- 一轮（可能同时叫多位） ----------

function setStep(room, round, state) {
  const run = round.flowRun;
  if (!run) return;
  run.steps[round.stepIndex].state = state;
  emitFlow(room);
}

async function runRound(room, r, round) {
  const run = round.flowRun;
  if (run && run.state !== 'running') return;
  setStep(room, round, 'running');

  const results = await Promise.all(round.targets.map((t) => runTurn(room, r, round, t)));
  const aborted = results.some((x) => x.aborted);

  if (run) {
    if (run.state !== 'running') return; // 中途被停止
    if (results.every((x) => x.ok)) {
      const reply = results[0].message;
      if (run.plan[round.stepIndex].def.ask && !(reply.meta && reply.meta.askDone)) {
        // 主控提了问：流程停在这里，等用户回答
        setWaiting(room, run, {
          stepIndex: round.stepIndex, askId: reply.id, round: round.targets[0].ask.round,
          card: !!(reply.meta && reply.meta.ask), final: false,
        });
        return;
      }
      setStep(room, round, 'done');
      if (round.stepIndex === run.steps.length - 1) {
        run.state = 'done';
        emitFlow(room);
        const next = run.next && flows.get(run.next);
        post(room, {
          from: 'system', kind: 'system',
          text: `「${run.name}」流程走完了，等你拍板。`,
          meta: next ? { next: { id: next.id, name: next.name, icon: next.icon } } : undefined,
        });
      } else {
        r.queue.unshift(stepRound(room, run, round.stepIndex + 1)); // 接着走下一步
      }
    } else {
      const asking = run.plan[round.stepIndex].def.ask ? round.targets[0].ask : null;
      if (!aborted && asking && asking.round > 1) {
        // 追问到一半出了错（比如额度用完）：用户答过的题不作废。
        // 流程退回"等你回答"，问题解决后用户回一句话，就从这一轮接着走。
        setWaiting(room, run, { stepIndex: round.stepIndex, askId: null, round: asking.round - 1, card: false, final: asking.final });
        post(room, {
          from: 'system', kind: 'system',
          text: `「${run.steps[round.stepIndex].label}」这一步刚才没走成，你答过的内容都还在。解决上面的问题后，在输入框里回一句话（比如"继续"），就会接着往下走。`,
        });
        return;
      }
      setStep(room, round, 'failed');
      run.state = 'failed';
      r.queue = r.queue.filter((q) => q.flowRun !== run);
      emitFlow(room);
      if (!aborted) post(room, { from: 'system', kind: 'system', text: `「${run.name}」流程在「${run.steps[round.stepIndex].label}」这一步中断了。解决上面的问题后可以重新发起。` });
    }
    return;
  }

  if (aborted) return;

  // 自由聊天：看这一轮的回复里 @ 了谁，接着叫。
  const settings = store.getSettings();
  const chain = round.chain;
  // 这条接力里已经排了队的成员（用户按顺序点名的后几位）不用重复叫。
  const queued = new Set();
  for (const q of r.queue) if (q.chain === chain) q.targets.forEach((t) => queued.add(t.agent));
  const next = [];
  for (const res of results) {
    if (!res.ok) continue;
    for (const a of M.parseMentions(res.message.text, settings).agents) {
      if (a === res.agent || queued.has(a)) continue;
      if (!settings.members[a] || !settings.members[a].enabled) continue;
      if (!next.some((t) => t.agent === a)) next.push({ agent: a, by: res.agent });
    }
  }
  if (!next.length) return; // 没有人再 @ 谁：接力到此为止，等用户发话
  for (const t of next) t.peers = next.filter((x) => x.agent !== t.agent).map((x) => x.agent);
  r.queue.push({ chain, targets: next });
}

async function pump(room) {
  const r = rt(room.id);
  if (r.pumping) return;
  r.pumping = true;
  emitRooms();
  try {
    while (r.queue.length) {
      const round = r.queue.shift();
      try {
        await runRound(room, r, round);
      } catch (e) {
        post(room, { from: 'system', kind: 'error', text: `调度出错：${e.message || e}` });
      }
    }
  } finally {
    r.pumping = false;
    emit({ type: 'idle', roomId: room.id });
    emitRooms();
  }
}

// ---------- 对外：发消息、发起流程、停止 ----------

function autoTitle(room, text) {
  if (room.titled || room.messages.filter((m) => m.from === 'user').length > 1) return;
  // 用第一句话当群名：到第一个标点为止，最长 20 个字。
  const clean = text.replace(/[@＠][A-Za-z一-龥]{1,8}/g, '').replace(/\s+/g, ' ').trim();
  const first = (clean.match(/^[^，。！？；,.!?;\n]{4,}/) || [clean])[0].trim();
  const t = first.length > 20 ? first.slice(0, 20) + '…' : first;
  if (!t) return;
  room.title = t;
  store.saveRoom(room);
  emit({ type: 'room', roomId: room.id, title: room.title, mode: room.mode });
}

// ---------- 固定流程 ----------

// 准备一次流程。saved 是服务重启前存下的"等你回答"现场，有它就照原样接回来。
function makeRun(flow, settings, saved) {
  const names = {};
  for (const role of M.ROLE_KEYS) names[role] = M.displayName(settings.roles[role]);
  const plan = flow.steps.map((s, i) => ({
    def: s,
    agents: saved && saved.agents && saved.agents[i] ? saved.agents[i] : [...new Set(s.who.map((role) => settings.roles[role]))],
  }));
  return {
    id: saved ? saved.runId : store.uid('f'),
    flowId: flow.id, name: flow.name, icon: flow.icon, next: flow.next || null,
    state: 'running',
    names: (saved && saved.names) || names,
    plan, // 每一步的定义和由谁来做（只在后台用，不发给页面）
    steps: plan.map((p) => ({ label: p.def.label, agents: p.agents, state: 'pending', ask: !!p.def.ask })),
    wait: null,
  };
}

// 流程的第 i 步：叫谁、对每个人说什么。提示词在轮到这一步时才生成，用的是当时的模式和工作目录。
// askOpts 只用于"向用户提问"的步骤：{ round: 第几轮, final: 用户是否说了别再问 }
function stepRound(room, run, i, askOpts) {
  const settings = store.getSettings();
  const step = run.plan[i];
  const def = step.def;
  return {
    flowRun: run,
    stepIndex: i,
    targets: step.agents.map((a) => {
      const peers = step.agents.filter((x) => x !== a);
      const ctx = { ...run.names, peer: peers.map(M.displayName).join('、'), canWrite: room.mode === 'work', workspace: settings.workspace };
      const t = { agent: a, by: 'flow', peers };
      if (def.ask) {
        const o = askOpts || { round: 1 };
        t.ask = { round: o.round, final: !!o.final, repair: def.repair };
        t.instruction = (o.final ? def.finish : o.round > 1 ? def.followup : def.instruction)(ctx);
      } else {
        t.instruction = def.instruction(ctx);
      }
      return t;
    }),
  };
}

// 流程停下来等用户回答。现场也存进群的资料里，服务重启后还能接着答。
// wait: { stepIndex 第几步, askId 等的是哪条提问, round 第几轮, card 有没有选项卡片, final 用户是否已经说过别再问 }
function setWaiting(room, run, wait) {
  run.state = 'waiting';
  run.steps[wait.stepIndex].state = 'waiting';
  run.wait = wait;
  room.wait = { flowId: run.flowId, runId: run.id, names: run.names, agents: run.plan.map((p) => p.agents), ...run.wait };
  store.saveRoom(room);
  emitFlow(room);
  emitRooms();
}

function clearWaiting(room, run) {
  if (run) run.wait = null;
  if (room.wait) {
    delete room.wait;
    store.saveRoom(room);
    emitRooms();
  }
}

// 服务重启后，把停在"等你回答"的流程接回来。
function restoreFlow(room) {
  const r = rt(room.id);
  if (r.flow || !room.wait) return r;
  const w = room.wait;
  const flow = flows.get(w.flowId);
  if (!flow || !flow.steps[w.stepIndex] || !flow.steps[w.stepIndex].ask) {
    delete room.wait; // 流程的定义变了，接不回来：就当它已经结束
    store.saveRoom(room);
    return r;
  }
  const run = makeRun(flow, store.getSettings(), w);
  run.state = 'waiting';
  run.steps.forEach((s, i) => { s.state = i < w.stepIndex ? 'done' : i === w.stepIndex ? 'waiting' : 'pending'; });
  run.wait = { stepIndex: w.stepIndex, askId: w.askId || null, round: w.round || 1, card: !!w.card, final: !!w.final };
  r.flow = run;
  return r;
}

// 结束一个还没走完的流程（正在跑的，或者停在"等你回答"的）。
function endFlow(room, r) {
  const run = r.flow;
  if (run && (run.state === 'running' || run.state === 'waiting')) {
    run.state = 'stopped';
    for (const s of run.steps) if (s.state === 'running' || s.state === 'pending' || s.state === 'waiting') s.state = 'stopped';
    clearWaiting(room, run);
    emitFlow(room);
    return run;
  }
  clearWaiting(room, null);
  return null;
}

function startFlow(room, flowId, text) {
  const flow = flows.get(flowId);
  if (!flow) throw httpError(400, '没有这个流程');
  const settings = store.getSettings();
  const r = restoreFlow(room);
  if (isBusy(room.id)) throw httpError(409, '群里还有人在说话。等他们说完，或者先点"停止"，再发起流程。');
  const userText = text || flow.defaultText || '';
  if (flow.requireText && !text) throw httpError(400, '这个流程需要先把需求写出来');

  const run = makeRun(flow, settings);
  for (const step of run.steps) {
    for (const a of step.agents) {
      if (!settings.members[a] || !settings.members[a].enabled) {
        throw httpError(400, `${M.displayName(a)} 已在设置里停用，这个流程需要他参与。`);
      }
    }
  }

  endFlow(room, r); // 上一个流程如果还停在"等你回答"，到此为止
  const msg = post(room, { from: 'user', kind: 'chat', text: userText, meta: { flow: { id: flow.id, name: flow.name } } });
  autoTitle(room, userText);
  r.flow = run;
  emitFlow(room);
  r.queue.push(stepRound(room, run, 0));
  pump(room);
  return msg;
}

const SKIP_TEXT = '不用再问了：按你现在的理解直接往下走，还没问到的都由你来定。';

// 用户回答了主控的提问。a 是卡片上的选择（{ to, items } 或 { to, skip: true }）；freeText 是直接打字的回答。
function answerFlow(room, r, a, freeText) {
  const run = r.flow;
  if (!run || run.state !== 'waiting' || !run.wait) throw httpError(409, '现在没有在等你回答的提问。');
  if (isBusy(room.id)) throw httpError(409, '群里还有人在说话，等他们说完再回答。');
  const w = run.wait;
  const step = run.steps[w.stepIndex];
  const meta = {
    flow: { id: run.flowId, name: run.name, step: step.label, index: w.stepIndex, runId: run.id },
    answer: { to: w.askId || '' },
  };
  let text = freeText || '';
  let final = !!w.final;
  if (a) {
    if (a.to && a.to !== w.askId) throw httpError(409, '这张提问卡片已经过期了。');
    if (a.skip) {
      text = SKIP_TEXT;
      meta.answer.skip = true;
      final = true;
    } else {
      const card = w.card ? room.messages.find((m) => m.id === w.askId) : null;
      const questions = card && card.meta && card.meta.ask && card.meta.ask.questions;
      if (!questions) throw httpError(409, '这一轮提问没有选项卡片，请直接用文字回答。');
      const built = ask.answer(questions, a.items); // 有没答的题会报错
      text = built.text;
      meta.answer.items = built.items;
    }
  }
  const msg = post(room, { from: 'user', kind: 'chat', text, meta });
  clearWaiting(room, run);
  run.state = 'running';
  r.queue.push(stepRound(room, run, w.stepIndex, { round: w.round + 1, final }));
  pump(room);
  return msg;
}

function sendMessage(roomId, body) {
  const room = store.getRoom(roomId);
  if (!room) throw httpError(404, '找不到这个群');
  const text = String((body && body.text) || '').trim();
  if (text.length > 200000) throw httpError(400, '这条消息太长了');
  if (body && body.flow) return startFlow(room, String(body.flow), text);
  const r = restoreFlow(room);
  if (body && body.answer && typeof body.answer === 'object') return answerFlow(room, r, body.answer, '');
  if (!text) throw httpError(400, '消息不能为空');

  const settings = store.getSettings();
  const mentioned = M.parseMentions(text, settings).agents;
  // 主控正等着用户回答提问：没有点名别人的消息，就是对提问的回答（不点卡片、直接打字也行）。
  if (r.flow && r.flow.state === 'waiting' && r.flow.wait && !isBusy(roomId)) {
    const asker = r.flow.plan[r.flow.wait.stepIndex].agents[0];
    if (!mentioned.length || mentioned.includes(asker)) return answerFlow(room, r, null, text);
  }
  const msg = post(room, { from: 'user', kind: 'chat', text });
  autoTitle(room, text);

  const wanted = mentioned.length ? mentioned : [settings.roles.lead];
  const targets = wanted.filter((a) => settings.members[a] && settings.members[a].enabled);
  if (!targets.length) {
    post(room, { from: 'system', kind: 'system', text: `${wanted.map(M.displayName).join('、')} 已在设置里停用，没有人能接这条消息。可以 @ 其他成员，或到设置里重新启用。` });
    return msg;
  }
  const chain = {}; // 标记"同一条用户消息引出的这一串接力"
  if (targets.length > 1 && M.wantsSequence(text)) {
    // "先 @A …然后 @B"：按点名顺序一个个来，后面的人能看到前面的回复。
    targets.forEach((a, i) => {
      r.queue.push({ chain, targets: [{ agent: a, by: 'user', mentioned: true, order: { index: i, all: targets } }] });
    });
  } else {
    // 同时点了多位：一起作答，这一轮互相看不到对方的回复。
    r.queue.push({
      chain,
      targets: targets.map((a) => ({
        agent: a, by: 'user', mentioned: mentioned.includes(a), peers: targets.filter((x) => x !== a),
      })),
    });
  }
  pump(room);
  return msg;
}

function stop(roomId) {
  const room = store.getRoom(roomId);
  if (!room) throw httpError(404, '找不到这个群');
  const r = restoreFlow(room);
  const wasBusy = isBusy(roomId);
  r.queue.length = 0;
  const ended = endFlow(room, r);
  for (const st of r.running.values()) st.abort.abort();
  if (wasBusy) post(room, { from: 'system', kind: 'system', text: '已停止。' });
  else if (ended) post(room, { from: 'system', kind: 'system', text: `已结束「${ended.name}」流程。` });
  return { ok: true };
}

function stopAll() {
  for (const id of runtimes.keys()) {
    const r = runtimes.get(id);
    r.queue.length = 0;
    for (const st of r.running.values()) st.abort.abort();
  }
}

function forgetRoom(roomId) {
  const r = runtimes.get(roomId);
  if (r) {
    r.queue.length = 0;
    for (const st of r.running.values()) st.abort.abort();
    runtimes.delete(roomId);
  }
}

module.exports = {
  bus, emit, emitRooms, sendMessage, stop, stopAll, forgetRoom,
  roomView, roomSummaries, isBusy, httpError,
};
