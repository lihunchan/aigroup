'use strict';
// AI 群聊 —— 本机服务入口。只监听本机地址，不对外网开放。
//   node server/main.js            启动
//   node server/main.js --open     启动并自动打开浏览器
//   node server/main.js --login-claude   在终端里给 Claude 做一次登录（备用；平时在页面上点成员就能登录）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const paths = require('./paths');
const store = require('./store');
const hub = require('./hub');
const health = require('./health');
const flows = require('./flows');
const M = require('./members');
const ag = require('./antigravity');
const setup = require('./setup');
const tools = require('./tools');
const { killAll } = require('./proc');

// 程序装在软件里面时，让服务待在本软件自己的文件夹里运行，而不是软件包里
// （软件包可能被放在"文稿""下载"这类受系统保护的位置；之后启动的命令行工具默认也待在这里）。
if (paths.MODE === 'bundled') {
  try { process.chdir(paths.idleDir()); } catch { /* 换不了就留在原地 */ }
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

if (flag('--login-claude')) {
  const bin = paths.findClaude();
  if (!bin) {
    console.error('这台电脑上还没有 Claude Code。打开「AI 群聊」，点左下角成员里的 Claude，可以让软件替你装好。');
    process.exit(1);
  }
  console.log('即将打开浏览器登录 Claude（用你平时的 Claude 账号）。登录完成后回到这个窗口。\n');
  const r = spawnSync(bin, ['auth', 'login'], { stdio: 'inherit', env: paths.envFor('claude') });
  process.exit(r.status == null ? 1 : r.status);
}

const BASE_PORT = parseInt(opt('--port', process.env.PORT || '4747'), 10) || 4747;
let PORT = BASE_PORT;

// 由软件窗口（AI 群聊.app）启动时会带上 --app <文件>，这时：
//   · 服务就绪后把地址写进这个文件，窗口据此打开页面；
//   · 窗口那边退出（标准输入断开）时，服务跟着退出，不留后台进程；
//   · 发现已经有一份在运行时不退出：窗口先连那一份，等它停了，这一份再顶上。
const APP_READY = opt('--app', '');

function writeReady(info) {
  if (!APP_READY) return;
  try {
    fs.writeFileSync(APP_READY + '.tmp', JSON.stringify(info));
    fs.renameSync(APP_READY + '.tmp', APP_READY);
  } catch (e) {
    console.error('写不了就绪文件：', e.message);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(hub.httpError(413, '内容太大了'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); } catch { reject(hub.httpError(400, '请求格式不对')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) return send(res, 404, { error: 'not found' });
  const file = path.join(paths.WEB_DIR, name);
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
    });
    res.end(data);
  });
}

// ---------- 实时推送（SSE） ----------

const clients = new Set();
hub.bus.on('event', (ev) => {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(data);
  // 成员的实际表现和上次检查的结论对不上时（报错了，或者之前叫不动现在能说话了），下次重新检查。
  if (ev.type === 'message' && M.AGENTS.includes(ev.message.from)) {
    const known = health.peek();
    const wasOk = known && known[ev.message.from] && known[ev.message.from].state === 'ok';
    if ((ev.message.kind === 'error') === !!wasOk) health.invalidate();
  }
});
setup.bus.on('event', (ev) => {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(data);
});
setInterval(() => {
  for (const res of clients) res.write(': keep-alive\n\n');
}, 20000).unref();

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1500\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// ---------- 接口 ----------

async function stateView(recheck) {
  let settings = store.getSettings();
  const [h, cat] = await Promise.all([health.check(recheck), ag.catalog(recheck)]);
  // 第一次打开时三位成员就都叫得动（这台电脑上本来就装好、登录好了）：不需要引导。
  if (!settings.onboarded && M.AGENTS.every((a) => h[a] && h[a].state === 'ok')) {
    settings = store.updateSettings({ onboarded: true });
  }
  return {
    app: 'aigroup',
    agents: M.AGENTS,
    info: M.INFO,
    roles: Object.fromEntries(M.ROLE_KEYS.map((k) => [k, { name: M.ROLES[k].name, duty: M.ROLES[k].duty }])),
    settings,
    // Gemini 这一路的模型清单是向 Antigravity 现问的；source 说明这份清单的来历（live 现问 / cache 上次的 / builtin 内置）。
    options: { ...store.options(), geminiModels: cat.models, geminiModelsSource: cat.source },
    flows: flows.publicList(),
    rooms: hub.roomSummaries(),
    health: h,
    root: paths.ROOT,
    mode: paths.MODE,       // dev：程序在一个文件夹里 / bundled：装在软件里（发给别人用的方式）
    sandbox: !!paths.SANDBOX, // 演练模式：页面上要标出来，免得和真实的那一份弄混
    dataDir: paths.DATA_DIR,
  };
}

function allowedHosts() {
  return new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method || 'GET';

  // 只接受发往本机地址、且由本页面自己发起的请求：别的网站不能借你的浏览器往群里发消息。
  const host = String(req.headers.host || '').toLowerCase();
  if (!allowedHosts().has(host)) return send(res, 403, { error: 'forbidden' });
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, { error: 'forbidden' });
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && origin.toLowerCase() !== `http://${host}`) return send(res, 403, { error: 'forbidden' });
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: '只接受 JSON' });
  }

  try {
    if (p === '/api/ping') return send(res, 200, { app: 'aigroup', ok: true });
    if (p === '/api/events' && method === 'GET') return sse(req, res);
    if (p === '/api/state' && method === 'GET') return send(res, 200, await stateView(url.searchParams.get('recheck') === '1'));

    if (p === '/api/settings' && method === 'POST') {
      const body = await readBody(req);
      const settings = store.updateSettings(body);
      hub.emit({ type: 'settings', settings });
      return send(res, 200, { settings });
    }

    // ---- 连接成员：装工具、登录、确认 ----
    if (p === '/api/setup' && method === 'GET') {
      return send(res, 200, { members: await setup.status(url.searchParams.get('recheck') === '1') });
    }
    if (p === '/api/setup/sizes' && method === 'GET') return send(res, 200, { sizes: await setup.sizes() });
    const sm = p.match(/^\/api\/setup\/(claude|gemini|gpt)\/(connect|cancel|check-update)$/);
    if (sm && method === 'POST') {
      const body = await readBody(req);
      if (sm[2] === 'connect') return send(res, 200, { job: setup.start(sm[1], { terminal: body.terminal === true, update: body.update === true }) });
      if (sm[2] === 'cancel') return send(res, 200, { job: setup.cancel(sm[1]) });
      return send(res, 200, await setup.checkUpdate(sm[1]));
    }

    if (p === '/api/rooms' && method === 'POST') {
      const body = await readBody(req);
      const room = store.createRoom(body.title);
      hub.emitRooms();
      return send(res, 200, { room: hub.roomView(room.id) });
    }

    const m = p.match(/^\/api\/rooms\/([\w-]+)(\/[\w-]+)?$/);
    if (m) {
      const id = m[1];
      const sub = m[2] || '';
      if (!sub && method === 'GET') return send(res, 200, { room: hub.roomView(id) });
      if (!sub && method === 'PATCH') {
        const room = store.getRoom(id);
        if (!room) throw hub.httpError(404, '找不到这个群');
        const body = await readBody(req);
        if (body.mode && body.mode !== room.mode && hub.isBusy(id)) throw hub.httpError(409, '群里还有人在说话，等他们说完再切换模式。');
        store.updateRoom(room, body);
        hub.emit({ type: 'room', roomId: id, title: room.title, mode: room.mode });
        hub.emitRooms();
        return send(res, 200, { room: hub.roomView(id) });
      }
      if (!sub && method === 'DELETE') {
        hub.forgetRoom(id);
        const ok = store.deleteRoom(id);
        hub.emitRooms();
        return send(res, ok ? 200 : 404, { ok });
      }
      if (sub === '/messages' && method === 'POST') {
        const body = await readBody(req);
        const message = hub.sendMessage(id, body);
        return send(res, 200, { message });
      }
      if (sub === '/stop' && method === 'POST') {
        await readBody(req);
        return send(res, 200, hub.stop(id));
      }
    }

    if (method === 'GET' && !p.startsWith('/api/')) return serveStatic(p, res);
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message || String(e) });
  }
}

// ---------- 启动 ----------

function openBrowser(url) {
  try { spawn('open', [url], { stdio: 'ignore', detached: true }).unref(); } catch { /* 打不开就让用户自己点 */ }
}

function pingExisting(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 1500 }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf).app === 'aigroup'); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      // 尽量也接受 localhost 解析到 IPv6 的情况；失败不影响使用。
      const v6 = http.createServer(handle);
      v6.once('error', () => {});
      v6.listen(port, '::1');
      resolve(server);
    });
  });
}

// 等另一份服务停下来（连续两次问不到才算），返回后本进程就可以接手那个端口。
async function waitUntilGone(port) {
  let misses = 0;
  while (misses < 2) {
    await new Promise((r) => setTimeout(r, 1500));
    misses = (await pingExisting(port)) ? 0 : misses + 1;
  }
}

async function start() {
  for (let i = 0; i < 10; i++) {
    PORT = BASE_PORT + i;
    store.load(); // 每次尝试前都重读：接手别人的端口时，要拿到它留下的最新记录
    try {
      await listen(PORT);
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      if (await pingExisting(PORT)) {
        const url = `http://127.0.0.1:${PORT}`;
        if (APP_READY) {
          console.log(`已经有一份在运行，窗口先用它：${url}（它停了以后由这一份接手）`);
          writeReady({ url, standby: true });
          await waitUntilGone(PORT);
          console.log('原来那一份停了，这一份接手。');
          i--;
          continue;
        }
        console.log(`AI 群聊已经在运行：${url}`);
        if (flag('--open')) openBrowser(url);
        process.exit(0);
      }
      if (i === 9) throw new Error(`端口 ${BASE_PORT}–${PORT} 都被占用了`);
    }
  }
  const url = `http://127.0.0.1:${PORT}`;
  if (APP_READY) console.log(`AI 群聊已启动：${url}`);
  else console.log(`\n  AI 群聊已启动：${url}\n  （保持这个窗口开着；关掉窗口或按 Ctrl+C 即停止）\n`);
  writeReady({ url, pid: process.pid });
  tools.cleanup(); // 上次没下完的半截文件
  health.check(true).catch(() => {});
  ag.catalog(true).catch(() => {}); // 先问一次 Antigravity 有哪些模型
  if (flag('--open')) openBrowser(url);
}

function shutdown() {
  setup.cancelAll();
  hub.stopAll();
  killAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('exit', killAll);
if (APP_READY) {
  // 软件窗口一直握着本进程的标准输入；它退出（哪怕是被强制退出）时这里会读到"结束"，于是跟着停。
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.on('error', shutdown);
  process.stdin.resume();
}

start().catch((e) => {
  console.error('启动失败：', e.message || e);
  process.exit(1);
});
