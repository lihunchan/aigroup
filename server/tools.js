'use strict';
// 三位成员各自靠一个官方的命令行工具说话。这里管三件事：
//   · 现在用的是哪一份（电脑上原有的，还是本软件自己下载的）、什么版本；
//   · 官方现在的最新版本是多少；
//   · 电脑上没有时，从各家官方的下载地址取回来——校验无误、确认是官方签名的才启用。
// 下载的东西只放进本软件自己的文件夹（见 paths.TOOLS_DIR），不改系统设置，也不动终端配置；
// 取回来的文件原样使用，不做任何修改。
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const paths = require('./paths');

const CURL = '/usr/bin/curl';
const ARM = os.arch() === 'arm64';

class ToolError extends Error {
  // code: NETWORK | VERIFY | UNSUPPORTED | ABORTED | FAILED
  constructor(code, message, detail) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.detail = detail || '';
  }
}

// ---------- 小工具 ----------

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: paths.idleDir(), timeout: opts.timeoutMs || 30000, maxBuffer: 16 * 1024 * 1024, env: opts.env || process.env, signal: opts.signal },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || ''), aborted: !!(err && err.name === 'AbortError') });
      });
  });
}

function aborted(signal) {
  return !!(signal && signal.aborted);
}

async function fetchText(url, who, signal) {
  const r = await run(CURL, ['-fsSL', '--connect-timeout', '15', '--max-time', '45', url], { timeoutMs: 50000, signal });
  if (aborted(signal)) throw new ToolError('ABORTED', '已取消');
  if (r.code !== 0) {
    throw new ToolError('NETWORK', `连不上 ${who} 的下载服务（${new URL(url).host}）。请检查网络，稍后再试。`, r.err.trim().slice(-300));
  }
  return r.out;
}

// 问一下要下载的文件有多大（只用来显示进度；问不到就算了）。
async function remoteSize(url, signal) {
  const r = await run(CURL, ['-fsSIL', '--connect-timeout', '10', '--max-time', '20', url], { timeoutMs: 25000, signal });
  const all = r.out.match(/^content-length:\s*(\d+)/gim) || [];
  const last = all.length ? Number(all[all.length - 1].replace(/\D+/g, '')) : 0;
  return last > 0 ? last : 0;
}

function hashFile(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function download(url, dest, { signal, total, onProgress, who }) {
  return new Promise((resolve, reject) => {
    if (aborted(signal)) return reject(new ToolError('ABORTED', '已取消'));
    // 一分钟内几乎没有数据就算断了（--speed-limit / --speed-time）；断了会自己再试几次，并且接着已经下好的部分往下下（-C -）
    const child = spawn(CURL, ['-fL', '--silent', '--show-error', '--connect-timeout', '20',
      '--speed-limit', '1024', '--speed-time', '60', '--retry', '3', '--retry-delay', '2', '-C', '-', '-o', dest, url],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    let stopped = false;
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const tick = setInterval(() => {
      fs.stat(dest, (e, st) => { if (!e && onProgress) onProgress(st.size, total || 0); });
    }, 500);
    const onAbort = () => { stopped = true; child.kill('SIGTERM'); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { clearInterval(tick); reject(new ToolError('FAILED', '启动下载失败：' + e.message)); });
    child.on('close', (code) => {
      clearInterval(tick);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (stopped) return reject(new ToolError('ABORTED', '已取消'));
      if (code !== 0) {
        return reject(new ToolError('NETWORK', `从 ${who} 下载到一半断了。请检查网络后重试。`, err.trim().slice(-300)));
      }
      resolve();
    });
  });
}

// ---------- 三个工具各自的"官方下载地址在哪、怎么校验" ----------
// 每个 release() 返回：
//   { version, url, pack, member?, size?, download: { algo, hash }, final?: { algo, hash } }
//   pack：raw 下载到的就是程序本身 / zst 用 zstd 压过的程序 / tgz 压缩包（程序是里面名叫 member 的那个文件）
//   download：下载到的文件应有的校验值；final：解开之后程序本身应有的校验值（官方给了才有）

const TOOLS = {
  claude: {
    tool: 'Claude Code', vendor: 'Anthropic', bin: 'claude',
    team: 'Q6L2SF6YDW', // Apple 发给 Anthropic PBC 的开发者编号：下载回来的程序必须是用它签名的
    async release(signal) {
      // 和官方安装脚本（https://claude.ai/install.sh）用的是同一个地址、同一套校验
      const base = 'https://downloads.claude.ai/claude-code-releases';
      const version = (await fetchText(base + '/latest', 'Anthropic', signal)).trim();
      if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new ToolError('NETWORK', 'Anthropic 的下载服务返回了看不懂的内容，可能暂时不可用，或者所在地区访问不了。');
      const platform = ARM ? 'darwin-arm64' : 'darwin-x64';
      const pick = (text) => {
        const j = JSON.parse(text);
        const p = j && j.platforms && j.platforms[platform];
        return p && /^[a-f0-9]{64}$/.test(p.checksum) ? p : null;
      };
      const plain = pick(await fetchText(`${base}/${version}/manifest.json`, 'Anthropic', signal));
      if (!plain) throw new ToolError('UNSUPPORTED', `Claude Code ${version} 没有适合这台电脑（${platform}）的版本。`);
      const rel = { version, final: { algo: 'sha256', hash: plain.checksum }, finalSize: plain.size };
      // 压缩过的那一份小得多（约三分之一），有就用它
      try {
        const z = pick(await fetchText(`${base}/${version}/manifest.zst.json`, 'Anthropic', signal));
        if (z) return { ...rel, url: `${base}/${version}/${platform}/claude.zst`, pack: 'zst', size: z.size, download: { algo: 'sha256', hash: z.checksum } };
      } catch (e) { if (e.code === 'ABORTED') throw e; /* 没有压缩版：下原版 */ }
      return { ...rel, url: `${base}/${version}/${platform}/claude`, pack: 'raw', size: plain.size, download: { algo: 'sha256', hash: plain.checksum } };
    },
  },

  gpt: {
    tool: 'Codex', vendor: 'OpenAI', bin: 'codex',
    team: '2DC432GLL2', // OpenAI OpCo, LLC
    async release(signal) {
      // OpenAI 自己的发布服务；问不到时退到它在 GitHub 上的发布页（两处的文件和校验值相同）
      const target = (ARM ? 'aarch64' : 'x86_64') + '-apple-darwin';
      let j;
      try {
        j = JSON.parse(await fetchText('https://releases.openai.com/codex/channels/latest', 'OpenAI', signal));
      } catch (e) {
        if (e.code === 'ABORTED') throw e;
        j = JSON.parse(await fetchText('https://api.github.com/repos/openai/codex/releases/latest', 'OpenAI（GitHub）', signal));
      }
      const version = String((j && j.tag_name) || '').replace(/^rust-v/, '');
      const assets = (j && j.assets) || [];
      const asset = (name) => {
        const a = assets.find((x) => x && x.name === name);
        const m = a && /^sha256:([a-f0-9]{64})$/.exec(a.digest || '');
        return a && m && /^https:\/\//.test(a.browser_download_url || '') ? { url: a.browser_download_url, hash: m[1], size: a.size || 0 } : null;
      };
      const zst = asset(`codex-${target}.zst`);
      const tgz = asset(`codex-${target}.tar.gz`);
      if (!version || (!zst && !tgz)) throw new ToolError('UNSUPPORTED', `没有找到适合这台电脑（${target}）的 Codex。`);
      if (zst) return { version, url: zst.url, pack: 'zst', size: zst.size, download: { algo: 'sha256', hash: zst.hash } };
      return { version, url: tgz.url, pack: 'tgz', member: `codex-${target}`, size: tgz.size, download: { algo: 'sha256', hash: tgz.hash } };
    },
  },

  gemini: {
    tool: 'Antigravity CLI', vendor: 'Google', bin: 'agy',
    team: 'EQHXZ8M8AV', // Google LLC
    async release(signal) {
      // 和官方安装脚本（https://antigravity.google/cli/install.sh）用的是同一个地址、同一套校验
      const platform = ARM ? 'darwin_arm64' : 'darwin_amd64';
      const text = await fetchText(`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${platform}.json`, 'Google', signal);
      const j = JSON.parse(text);
      if (!j || !/^https:\/\//.test(j.url || '') || !/^[a-f0-9]{128}$/.test(j.sha512 || '')) {
        throw new ToolError('NETWORK', 'Google 的下载服务返回了看不懂的内容，可能暂时不可用。');
      }
      const tgz = /\.tar\.gz(\?|$)/.test(j.url);
      return { version: String(j.version || ''), url: j.url, pack: tgz ? 'tgz' : 'raw', member: 'antigravity', download: { algo: 'sha512', hash: j.sha512 } };
    },
  },
};

// ---------- 现在用的是哪一份、什么版本 ----------

const versions = new Map(); // 路径 + 修改时间 → 版本号

async function versionOf(bin, agent) {
  let key = bin;
  try {
    const st = fs.statSync(fs.realpathSync(bin));
    key = `${bin}:${st.mtimeMs}:${st.size}`;
  } catch { /* 查不到就不缓存 */ }
  if (versions.has(key)) return versions.get(key);
  const r = await run(bin, ['--version'], { timeoutMs: 20000, env: paths.envFor(agent) });
  const m = /\d+\.\d+\.\d+[\w.-]*/.exec(r.out + r.err);
  const v = r.code === 0 && m ? m[0] : '';
  if (v) versions.set(key, v);
  return v;
}

// 某位成员的工具现状：{ tool, vendor, installed, source, path, version }
async function info(agent) {
  const t = TOOLS[agent];
  const hit = paths.locate(agent);
  if (!hit) return { tool: t.tool, vendor: t.vendor, installed: false, source: '', path: '', version: '' };
  return { tool: t.tool, vendor: t.vendor, installed: true, source: hit.source, path: hit.path, version: await versionOf(hit.path, agent) };
}

// ---------- 官方的最新版本 ----------

const LATEST_TTL = 6 * 60 * 60 * 1000;
const latestCache = new Map();

async function latest(agent, signal, force) {
  const hit = latestCache.get(agent);
  if (!force && hit && Date.now() - hit.at < LATEST_TTL) return hit.rel;
  const rel = await TOOLS[agent].release(signal);
  if (!rel.size) rel.size = await remoteSize(rel.url, signal).catch(() => 0);
  latestCache.set(agent, { rel, at: Date.now() });
  return rel;
}

// ---------- 下载并装好 ----------

// 只认 Apple 发给这家公司的"开发者 ID"签出来的程序（第三段就是比对公司编号）。
function requirement(team) {
  return '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists' +
    ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' +
    ` and certificate leaf[subject.OU] = "${team}"`;
}

async function signedBy(file, team) {
  const r = await run('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement(team), file], { timeoutMs: 120000 });
  return { ok: r.code === 0, detail: (r.err || r.out).trim().slice(-300) };
}

async function unpack(rel, src, dest, tmpDir, signal) {
  if (rel.pack === 'raw') {
    fs.renameSync(src, dest);
  } else if (rel.pack === 'zst') {
    await pipeline(fs.createReadStream(src), zlib.createZstdDecompress(), fs.createWriteStream(dest), { signal });
  } else {
    const dir = path.join(tmpDir, 'x');
    fs.mkdirSync(dir, { recursive: true });
    const r = await run('/usr/bin/tar', ['-xzf', src, '-C', dir, rel.member], { timeoutMs: 180000, signal });
    if (r.code !== 0) throw new ToolError('VERIFY', '下载到的压缩包解不开，已丢弃。可以重试一次。', r.err.trim().slice(-300));
    fs.renameSync(path.join(dir, rel.member), dest);
  }
}

// 从官方下载某位成员的工具，装进本软件自己的文件夹。onProgress({ phase, done, total, version })：
//   phase：query 问官方最新版 / download 下载 / verify 校验 / done
async function install(agent, { signal, onProgress = () => {} } = {}) {
  const t = TOOLS[agent];
  const target = paths.OWN[agent];
  const tmpDir = path.join(paths.TOOLS_DIR, '.tmp', `${agent}-${process.pid}-${Date.now().toString(36)}`);
  const part = path.join(tmpDir, 'download.part');
  const staged = path.join(tmpDir, t.bin);
  const t0 = Date.now();
  const lap = (what) => console.log(`[工具] ${t.tool}：${what}（第 ${((Date.now() - t0) / 1000).toFixed(0)} 秒）`);
  try {
    onProgress({ phase: 'query' });
    const rel = await latest(agent, signal, true);
    lap(`官方最新版本 ${rel.version}，开始下载 ${new URL(rel.url).host}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    onProgress({ phase: 'download', done: 0, total: rel.size || 0, version: rel.version });
    await download(rel.url, part, {
      signal, total: rel.size, who: t.vendor,
      onProgress: (done, total) => onProgress({ phase: 'download', done, total, version: rel.version }),
    });

    lap('下载完成，开始校验');
    onProgress({ phase: 'verify', version: rel.version });
    if (await hashFile(part, rel.download.algo) !== rel.download.hash) {
      throw new ToolError('VERIFY', `下载到的 ${t.tool} 和 ${t.vendor} 公布的校验值对不上，已丢弃。可以重试一次。`);
    }
    await unpack(rel, part, staged, tmpDir, signal);
    if (rel.final && await hashFile(staged, rel.final.algo) !== rel.final.hash) {
      throw new ToolError('VERIFY', `解开后的 ${t.tool} 和 ${t.vendor} 公布的校验值对不上，已丢弃。可以重试一次。`);
    }
    fs.chmodSync(staged, 0o755);
    const sig = await signedBy(staged, t.team);
    if (!sig.ok) throw new ToolError('VERIFY', `下载到的 ${t.tool} 不是 ${t.vendor} 官方签名的程序，已丢弃。`, sig.detail);
    if (aborted(signal)) throw new ToolError('ABORTED', '已取消');
    // 试着运行一下，确认它在这台电脑上能用
    const probe = await run(staged, ['--version'], { timeoutMs: 30000, env: paths.envFor(agent) });
    const vm = /\d+\.\d+\.\d+[\w.-]*/.exec(probe.out + probe.err);
    if (probe.code !== 0 || !vm) {
      throw new ToolError('FAILED', `${t.tool} 下载好了，但在这台电脑上运行不起来。`, (probe.err || probe.out).trim().slice(-300));
    }

    // 放到位（同一个磁盘上的改名：要么是旧的，要么是新的，不会出现半个文件）
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(staged, target);
    const record = { tool: t.tool, version: vm[0], from: rel.url, installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(path.dirname(target), 'install.json'), JSON.stringify(record, null, 2));
    paths.refresh();
    lap(`装好了，版本 ${vm[0]}`);
    onProgress({ phase: 'done', version: vm[0] });
    return record;
  } catch (e) {
    lap('没有装上：' + (e.message || e) + (e.detail ? ' ｜ ' + e.detail : ''));
    if (aborted(signal) || e.name === 'AbortError') throw new ToolError('ABORTED', '已取消');
    if (e instanceof ToolError) throw e;
    if (e instanceof SyntaxError) throw new ToolError('NETWORK', `${t.vendor} 的下载服务返回了看不懂的内容，可能暂时不可用。`, String(e.message));
    if (e.code === 'ENOSPC') throw new ToolError('FAILED', '磁盘空间不够，没能装上。腾出一些空间后再试。');
    throw new ToolError('FAILED', `没能装上 ${t.tool}：${e.message || e}`);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

// 启动时顺手清掉上次没下完留下的半截文件。
function cleanup() {
  fs.rm(path.join(paths.TOOLS_DIR, '.tmp'), { recursive: true, force: true }, () => {});
}

module.exports = { TOOLS, ToolError, info, latest, install, cleanup, signedBy };
