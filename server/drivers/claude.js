'use strict';
// Claude 成员：通过 Claude Code 的无界面模式（claude -p）说话，用的是你自己的 Claude 订阅登录。
const crypto = require('crypto');
const paths = require('../paths');
const { runProcess, DriverError } = require('../proc');

// 只读类工具：预先放行（没有人在旁边点"允许"）。
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
// 动手模式多给两个写文件的工具，但【不】预先放行：
// 由 acceptEdits 模式只自动同意"工作目录之内"的修改；目录之外的写入需要询问，而询问一律被拒。
// （如果把 Edit/Write 也写进预先放行的名单，就等于允许它写电脑上任何位置。）
const WRITE_TOOLS = [...READ_TOOLS, 'Edit', 'Write'];

function toolDetail(input) {
  const i = input || {};
  const v = i.file_path || i.path || i.pattern || i.query || i.url || i.command || i.description || '';
  const s = String(v);
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

function normUsage(u) {
  if (!u) return null;
  return {
    input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    output: u.output_tokens || 0,
  };
}

async function run(opts) {
  const { prompt, sessionId, model, effort, cwd, canWrite, title, onEvent = () => {}, signal } = opts;
  const bin = paths.findClaude();
  if (!bin) {
    throw new DriverError('NOT_INSTALLED', '这台电脑上还没有 Claude Code。点左下角成员里的 Claude，可以让软件替你装好并登录。');
  }

  const tools = canWrite ? WRITE_TOOLS : READ_TOOLS;
  const newId = sessionId ? null : crypto.randomUUID();
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompts', 'none',        // 没人在旁边点"允许"：凡是需要询问的操作一律拒绝
    '--strict-mcp-config',                 // 不加载任何 MCP
    '--disable-slash-commands',            // 不加载技能和自定义命令
    '--tools', tools.join(','),
    '--allowedTools', READ_TOOLS.join(','),
  ];
  if (canWrite) args.push('--permission-mode', 'acceptEdits');
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (sessionId) args.push('--resume', sessionId);
  else {
    args.push('--session-id', newId);
    if (title) args.push('--name', title);
  }

  let sid = sessionId || newId;
  let modelName = model || '';
  let finalText = null;
  let isError = false;
  let usage = null;
  let lastAssistantText = '';
  let partial = '';
  let resultErrors = '';

  const onLine = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.parent_tool_use_id) return; // 子代理的内部对话，不进群
    if (ev.type === 'system' && ev.subtype === 'init') {
      sid = ev.session_id || sid;
      modelName = ev.model || modelName;
      onEvent({ type: 'status', text: '正在思考…' });
    } else if (ev.type === 'stream_event') {
      const e = ev.event || {};
      const block = e.content_block || {};
      const delta = e.delta || {};
      if (e.type === 'message_start') {
        partial = '';
        onEvent({ type: 'partial', text: '' });
      } else if (e.type === 'content_block_start' && block.type === 'tool_use') {
        onEvent({ type: 'status', text: `正在使用工具：${block.name}` });
      } else if (e.type === 'content_block_start' && block.type === 'thinking') {
        onEvent({ type: 'status', text: '正在思考…' });
      } else if (e.type === 'content_block_delta' && delta.type === 'text_delta') {
        partial += delta.text || '';
        onEvent({ type: 'partial', text: partial });
      }
    } else if (ev.type === 'assistant') {
      const msg = ev.message || {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text) lastAssistantText = text;
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          onEvent({ type: 'activity', item: { kind: 'tool', text: `${b.name} ${toolDetail(b.input)}`.trim(), ok: true } });
        }
      }
      if (msg.model && msg.model !== '<synthetic>') modelName = msg.model;
    } else if (ev.type === 'result') {
      finalText = typeof ev.result === 'string' ? ev.result : '';
      isError = !!ev.is_error;
      usage = ev.usage || usage;
      sid = ev.session_id || sid;
      if (Array.isArray(ev.errors)) resultErrors = ev.errors.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
    }
  };

  const res = await runProcess(bin, args, {
    cwd, env: paths.envFor('claude'), input: prompt, onLine, signal, timeoutMs: 30 * 60 * 1000,
  });
  if (res.aborted) throw new DriverError('ABORTED', '已停止');
  if (res.timedOut) throw new DriverError('TIMEOUT', 'Claude 这一轮超过 30 分钟，已中止。');

  if (isError || finalText == null) {
    // 出错原因可能在最终结果里，也可能只打印在错误输出里（例如找不到要续接的会话），都收集起来判断。
    const raw = [
      isError ? finalText || lastAssistantText : '',
      resultErrors,
      (res.stderr || '').trim().split('\n').slice(-6).join('\n'),
    ].filter(Boolean).join('\n') || `Claude Code 异常退出（代码 ${res.code}）`;
    if (/not logged in|\/login|authentication_error|invalid api key|oauth token|credentials/i.test(raw)) {
      throw new DriverError('NOT_LOGGED_IN',
        'Claude 还没有登录。点左下角成员里的 Claude，按提示在浏览器里登录一次，之后就不用再登了。', raw);
    }
    if (sessionId && /no conversation found|session.{0,40}(not found|does not exist)|not a valid session/i.test(raw)) {
      throw new DriverError('SESSION_LOST', raw);
    }
    if (/usage limit|rate limit|quota|overloaded|\b429\b|\b529\b/i.test(raw)) {
      throw new DriverError('RATE_LIMIT', `Claude 额度或频率受限：${raw.slice(0, 300)}`, raw);
    }
    throw new DriverError('FAILED', `Claude 出错：${raw.slice(0, 500)}`, raw);
  }

  return {
    text: finalText || lastAssistantText || '',
    sessionId: sid,
    model: modelName,
    usage: normUsage(usage),
  };
}

module.exports = { run };
