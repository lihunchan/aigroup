'use strict';
// 启动子进程、逐行读它的输出，并支持中途停止。
const { spawn } = require('child_process');

class DriverError extends Error {
  // code: NOT_INSTALLED | NOT_LOGGED_IN | NOT_RUNNING | SESSION_LOST | RATE_LIMIT | ABORTED | TIMEOUT | FAILED
  constructor(code, message, detail) {
    super(message);
    this.name = 'DriverError';
    this.code = code;
    this.detail = detail || '';
  }
}

const active = new Set();

// 子进程自成一个进程组，停止时连它派生出的命令一起结束。
function killTree(child, sig) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try { process.kill(-child.pid, sig); } catch {
    try { child.kill(sig); } catch { /* 已经退出 */ }
  }
}

function killAll() {
  for (const c of active) killTree(c, 'SIGTERM');
}

function runProcess(cmd, args, opts = {}) {
  // onErrLine：错误输出也逐行交出来（有的工具把提示写在那边）；holdStdin：不关标准输入（有的工具一读到"输入结束"就退出）
  const { cwd, env, input, onLine, onErrLine, holdStdin, signal, timeoutMs } = opts;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new DriverError('ABORTED', '已停止'));
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return reject(e);
    }
    active.add(child);

    let buf = '';
    let errBuf = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killTimer = null;

    const stopChild = () => {
      killTree(child, 'SIGTERM');
      clearTimeout(killTimer);
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), 4000);
    };
    const onAbort = () => { aborted = true; stopChild(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; stopChild(); }, timeoutMs);

    const settle = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      active.delete(child);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(val);
    };
    const feed = (line) => {
      if (!onLine || !line.trim()) return;
      try { onLine(line); } catch { /* 一行解析失败不该中断整轮 */ }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        feed(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-6000);
      if (!onErrLine) return;
      errBuf += d;
      let i;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i);
        errBuf = errBuf.slice(i + 1);
        if (line.trim()) try { onErrLine(line); } catch { /* 同上 */ }
      }
    });
    child.stdin.on('error', () => {});
    child.on('error', (e) => settle(e));
    child.on('close', (code, sig) => {
      if (buf) feed(buf);
      settle(null, { code, signal: sig, stderr, aborted, timedOut });
    });
    if (holdStdin) {
      if (input != null) child.stdin.write(input);
    } else {
      child.stdin.end(input == null ? '' : input);
    }
  });
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

module.exports = { DriverError, runProcess, killAll, sleep };
