'use strict';
// Gemini 成员：通过 Google 官方的 Antigravity CLI（命令叫 agy）说话。
// 和 Claude、GPT 两路一样——每一轮在后台启动一次命令行，跑完就退出：
//   · 不依赖 Antigravity 应用开着；登录沿用应用里的 Google 账号，额度也是同一套；
//   · 对话存在 CLI 自己的地方（~/.gemini/antigravity-cli/），和 Antigravity 应用的对话库是分开的。
//
// 用到的都是官方文档里的无界面（headless）用法：https://antigravity.google/docs/cli/headless
const paths = require('../paths');
const ag = require('../antigravity');
const { runProcess, DriverError } = require('../proc');

const MAX_MS = 30 * 60 * 1000;
const STALL_MS = 8 * 60 * 1000; // 这么久没有任何输出，就认为卡住了

// 只读的规矩。实测：不加这些的话，agy 在无界面模式下会不经询问地改文件、执行命令。
// 这里只在这一次运行里生效（--settings），不会写进 agy 自己的设置文件。
//   deny 的事情它一做就会收到"被拒绝"，然后继续把话说完；
//   allow 的事情不用询问——无界面模式下没有人能回答询问，一询问这一轮就白跑了。
const READ_ONLY = JSON.stringify({
  agentMode: '',                          // 不用"自动"模式（那个模式会自己改文件、跑命令）
  artifactReviewPolicy: 'always-proceed', // 没有人在旁边审阅它的产物，不要停下来等
  permissions: {
    deny: ['write_file(*)', 'command(*)', 'execute_url(*)', 'mcp(*)'], // 不写文件、不执行命令、不操作浏览器、不用外接工具
    allow: ['read_file(*)', 'read_url(*)'],                             // 可以读文件、读网页（和 Claude、GPT 一样）
  },
});

function toolKind(name) {
  if (/command/.test(name)) return 'cmd';
  if (/write|replace|sed_file|notebook_edit/.test(name)) return 'edit';
  if (/search|grep|find/.test(name)) return 'search';
  return 'tool';
}

function toolDetail(info) {
  const p = (info && info.parameters) || {};
  const v = p.Path || p.AbsolutePath || p.TargetFile || p.CommandLine || p.Query || p.Url || p.Prompt || '';
  const s = String(v).replace(/\s+/g, ' ');
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

async function run(opts) {
  const { prompt, sessionId, model, cwd, onEvent = () => {}, signal } = opts;
  const bin = paths.findAgy();
  if (!bin) {
    throw new DriverError('NOT_INSTALLED',
      '这台电脑上还没有 Antigravity CLI。点左下角成员里的 Gemini，可以让软件替你装好并登录。');
  }
  if (signal && signal.aborted) throw new DriverError('ABORTED', '已停止');

  const args = [
    '--input-format', 'stream-json',   // 消息从标准输入送进去：群聊记录可能很长，不适合放在命令行参数里
    '--output-format', 'stream-json',  // 一行一个事件：可以边写边显示
    '--disable-slash-commands',        // 以 / 开头的内容当普通文字，不触发它的内置命令
    '--settings', READ_ONLY,
  ];
  if (model) args.push('--model', model);
  if (sessionId) args.push('--conversation', sessionId);

  // 自己的"停止"开关：用户喊停、续接错了对话、太久没动静，都靠它结束进程。
  const ac = new AbortController();
  const outerAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', outerAbort, { once: true });

  let cid = null;
  let modelName = '';
  let result = null;
  let partial = '';
  let lost = false;
  let stalled = false;
  let stallTimer = null;
  const alive = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stalled = true; ac.abort(); }, STALL_MS);
  };
  alive();

  const onLine = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    alive();
    if (ev.event === 'init') {
      cid = ev.conversation_id || cid;
      modelName = (ev.init && ev.init.model) || modelName;
      // 要续接的对话找不到时，agy 不报错，而是悄悄新开一场（它没看过之前的群聊记录）。
      // 一发现编号对不上就立刻停下，让调度那边带上完整记录重新来。
      if (sessionId && cid && cid !== sessionId) {
        lost = true;
        ac.abort();
        return;
      }
      onEvent({ type: 'status', text: '正在思考…' });
    } else if (ev.event === 'step_update') {
      const s = ev.step_update || {};
      if (s.step_type === 'agent_response') {
        if (typeof s.text_delta === 'string' && s.text_delta) {
          partial += s.text_delta;
          onEvent({ type: 'partial', text: partial });
        }
      } else if (s.tool_name) {
        if (s.state === 'ACTIVE') onEvent({ type: 'status', text: `正在使用工具：${s.tool_name}` });
        else {
          onEvent({
            type: 'activity',
            item: { kind: toolKind(s.tool_name), text: `${s.tool_name} ${toolDetail(s.tool_info)}`.trim(), ok: s.state !== 'ERROR' },
          });
        }
      }
    } else if (ev.event === 'result') {
      result = ev.result || {};
      cid = result.conversation_id || cid;
    }
  };

  let res;
  try {
    res = await runProcess(bin, args, {
      cwd,
      env: paths.envFor('gemini'),
      input: JSON.stringify({ event: 'user', message: { content: String(prompt || '') } }) + '\n',
      onLine,
      signal: ac.signal,
      timeoutMs: MAX_MS,
    });
  } finally {
    clearTimeout(stallTimer);
    if (signal) signal.removeEventListener('abort', outerAbort);
  }

  if (lost) throw new DriverError('SESSION_LOST', 'Antigravity CLI 里找不到这场对话了');
  if (stalled) throw new DriverError('TIMEOUT', 'Gemini 很久没有动静了，已中止这一轮。可以稍后再叫它一次。');
  if (res.aborted) throw new DriverError('ABORTED', '已停止');
  if (res.timedOut) throw new DriverError('TIMEOUT', 'Gemini 这一轮超过 30 分钟，已中止。');

  const text = result && typeof result.response === 'string' ? result.response.trim() : '';
  if (!result || result.status !== 'SUCCESS' || !text) {
    const raw = [
      result && result.error,
      (res.stderr || '').trim().split('\n').slice(-8).join('\n'),
    ].filter(Boolean).join('\n') || `agy 异常退出（代码 ${res.code}）`;
    if (/authentication required|not authenticated|unauthenticated|sign in|signed out|log ?in\b/i.test(raw)) {
      throw new DriverError('NOT_LOGGED_IN',
        'Gemini（Antigravity CLI）还没有登录 Google 账号。点左下角成员里的 Gemini，按提示在浏览器里登录一次。', raw);
    }
    if (/invalid model selection|not recognized as a known model/i.test(raw)) {
      throw new DriverError('FAILED', `设置里给 Gemini 选的型号（${model}）现在用不了。请到"设置与分工"里换一个。`, raw);
    }
    if (/auto-denied|cannot prompt/i.test(raw)) {
      const what = (raw.match(/required the "([^"]+)" permission/) || [])[1];
      throw new DriverError('FAILED',
        `Gemini 这一轮没有产生回复：它想做一件需要有人批准的事${what ? `（${what}）` : ''}，而后台运行时没有人能批准。可以换个说法再叫它一次。`, raw);
    }
    if (/quota|exhausted|rate limit|\b429\b|credits/i.test(raw)) {
      throw new DriverError('RATE_LIMIT', `Gemini 额度或频率受限：${raw.slice(0, 300)}`, raw);
    }
    throw new DriverError('FAILED', `Gemini 出错：${raw.slice(0, 500)}`, raw);
  }

  const u = result.usage || {};
  return {
    text,
    sessionId: cid || sessionId || null,
    model: modelName || model || '',
    usage: { input: u.input_tokens || 0, output: u.output_tokens || 0 },
  };
}

module.exports = {
  run,
  // 设置里是"模型 + 强度"两项，交给 agy 的是合成后的一个型号（如 gemini-4-neon-high）。
  modelId: (model, effort) => ag.resolveModelId(model, effort),
};
