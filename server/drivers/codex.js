'use strict';
// GPT 成员：通过 ChatGPT 应用自带的 Codex 命令行（codex exec）说话，用的是应用里已登录的账号。
const paths = require('../paths');
const { runProcess, DriverError } = require('../proc');

function shortCmd(cmd) {
  let s = Array.isArray(cmd) ? cmd.join(' ') : String(cmd || '');
  s = s.replace(/^\/bin\/(ba|z)?sh\s+-l?c\s+/, '').replace(/^['"]|['"]$/g, '');
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

function normUsage(u) {
  if (!u) return null;
  return { input: u.input_tokens || 0, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0) };
}

async function run(opts) {
  const { prompt, sessionId, model, effort, cwd, canWrite, onEvent = () => {}, signal } = opts;
  const bin = paths.findCodex();
  if (!bin) {
    throw new DriverError('NOT_INSTALLED', '没有找到 Codex 命令行。GPT 这一路需要安装并登录 ChatGPT 桌面应用。');
  }

  // --ignore-user-config：不加载个人配置里的插件和 MCP（电脑操控、浏览器等），群成员只需要读写代码的能力。
  const common = [
    '--json', '--skip-git-repo-check', '--ignore-user-config',
    '-c', `sandbox_mode="${canWrite ? 'workspace-write' : 'read-only'}"`,
  ];
  if (model) common.push('-m', model);
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
  // 提示词走标准输入（末尾的 "-"），避免命令行长度和转义问题。
  const args = sessionId ? ['exec', 'resume', sessionId, ...common, '-'] : ['exec', ...common, '-'];

  let threadId = sessionId || null;
  let usage = null;
  let failure = null;
  let lastError = null;
  const texts = [];

  const handleItem = (phase, item) => {
    const it = item || {};
    switch (it.type) {
      case 'agent_message':
        if (phase === 'item.completed' && it.text) {
          texts.push(it.text);
          onEvent({ type: 'partial', text: it.text });
        }
        break;
      case 'reasoning':
        onEvent({ type: 'status', text: '正在思考…' });
        break;
      case 'command_execution':
        if (phase === 'item.started') onEvent({ type: 'status', text: '正在执行命令：' + shortCmd(it.command) });
        else if (phase === 'item.completed') {
          onEvent({ type: 'activity', item: { kind: 'cmd', text: shortCmd(it.command), ok: it.exit_code === 0 || it.exit_code == null } });
        }
        break;
      case 'file_change':
        if (phase === 'item.completed') {
          const list = (it.changes || []).map((c) => `${c.kind || '改'} ${c.path || ''}`.trim()).join('、');
          onEvent({ type: 'activity', item: { kind: 'edit', text: list || '修改了文件', ok: it.status !== 'failed' } });
        }
        break;
      case 'web_search':
        if (phase !== 'item.started') onEvent({ type: 'activity', item: { kind: 'search', text: it.query || '联网搜索', ok: true } });
        break;
      case 'mcp_tool_call':
        if (phase === 'item.completed') onEvent({ type: 'activity', item: { kind: 'tool', text: `${it.server || ''}.${it.tool || ''}`, ok: it.status !== 'failed' } });
        break;
      case 'todo_list':
        onEvent({ type: 'status', text: '正在规划步骤…' });
        break;
      case 'error':
        lastError = it.message || lastError; // 多为提示性警告（例如换了模型），不算失败
        break;
      default:
        break;
    }
  };

  const onLine = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    switch (ev.type) {
      case 'thread.started': threadId = ev.thread_id || threadId; break;
      case 'turn.started': onEvent({ type: 'status', text: '正在思考…' }); break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': handleItem(ev.type, ev.item); break;
      case 'turn.completed': usage = ev.usage || usage; break;
      case 'turn.failed': failure = (ev.error && ev.error.message) || '这一轮执行失败'; break;
      case 'error': lastError = ev.message || lastError; break;
      default: break;
    }
  };

  const res = await runProcess(bin, args, { cwd, input: prompt, onLine, signal, timeoutMs: 30 * 60 * 1000 });
  if (res.aborted) throw new DriverError('ABORTED', '已停止');
  if (res.timedOut) throw new DriverError('TIMEOUT', 'GPT 这一轮超过 30 分钟，已中止。');

  if (!texts.length || failure) {
    const raw = failure || lastError || (res.stderr || '').trim().split('\n').slice(-6).join('\n') || `Codex 退出码 ${res.code}`;
    if (/not logged in|login required|please log ?in|unauthorized|\b401\b/i.test(raw)) {
      throw new DriverError('NOT_LOGGED_IN', 'GPT（Codex）还没有登录：请打开 ChatGPT 桌面应用并登录账号。', raw);
    }
    if (sessionId && /no rollout found|thread\/resume failed|(session|thread|conversation|rollout).{0,40}(not found|no such|missing|does not exist)|no (saved )?session/i.test(raw)) {
      throw new DriverError('SESSION_LOST', raw);
    }
    if (/usage limit|rate limit|quota|too many requests|\b429\b/i.test(raw)) {
      throw new DriverError('RATE_LIMIT', `GPT 额度或频率受限：${raw.slice(0, 300)}`, raw);
    }
    if (!texts.length) throw new DriverError('FAILED', `GPT 出错：${raw.slice(0, 500)}`, raw);
  }

  return {
    text: texts[texts.length - 1],
    sessionId: threadId,
    model: model || 'Codex 默认模型',
    usage: normUsage(usage),
  };
}

module.exports = { run };
