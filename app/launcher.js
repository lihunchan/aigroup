// AI 群聊 —— Mac 软件外壳。
//
// 用 macOS 自带的 JavaScript for Automation 写成，打包只用到系统自带的工具，不需要安装开发环境。
// 它只做三件事：找到程序 → 启动里面的本机服务 → 开一个窗口显示群聊页面。
//
// 有两种打包方式，用的是同一份外壳：
//   · 自用（bash app/build.sh）：外壳是一个小程序，程序本体（server/、web/）和聊天记录（data/）仍然在程序文件夹里，
//     所以平时改程序不用重新打包；
//   · 发给别人（bash app/build-dist.sh）：程序本体和运行环境都装在软件里面，聊天记录放在
//     ~/Library/Application Support/aigroup。这种方式下外壳由系统自带的 osascript 运行（见 app/stub.sh），
//     不带任何需要编译的程序，所以不挑系统版本。
ObjC.import('Cocoa');
ObjC.import('WebKit');

var NAME = 'AI 群聊';
var UTF8 = 4;
var CMD = 1 << 20, SHIFT = 1 << 17, OPT = 1 << 19;

var fm = $.NSFileManager.defaultManager;
// 由 osascript 运行时，软件包在哪由启动脚本通过环境变量告诉我们；这时偏好设置也要指明存在本软件名下。
var HOSTED_AT = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('AIGROUP_BUNDLE')) || '';
var HOSTED = !!HOSTED_AT;
var bundle = HOSTED ? $.NSBundle.bundleWithPath(HOSTED_AT) : $.NSBundle.mainBundle;
var prefs = HOSTED
  ? $.NSUserDefaults.alloc.initWithSuiteName(ObjC.unwrap(bundle.bundleIdentifier) || 'local.aigroup.app')
  : $.NSUserDefaults.standardUserDefaults;
var USER_HOME = ObjC.unwrap($.NSHomeDirectory());
// 程序本体是不是装在软件里面（发给别人的那种方式）
var BUNDLED = ObjC.unwrap(bundle.objectForInfoDictionaryKey('AIGroupMode')) === 'bundled';
// 菜单、以及提示里引用的系统用语（"文稿 / Documents"、"允许 / Allow"）跟着系统语言走：
// 系统自己加进菜单的项目、系统弹出的授权框用的都是系统语言，这样两边对得上。群聊页面本身始终是中文。
var ZH = /^zh/i.test(ObjC.unwrap($.NSLocale.preferredLanguages.firstObject) || '');
function T(zh, en) { return ZH ? zh : en; }
var LOG_DIR = USER_HOME + '/Library/Logs/' + (BUNDLED ? 'aigroup-app' : 'aigroup');
var APP_LOG = LOG_DIR + '/app.log';
var SERVER_LOG = LOG_DIR + '/server.log';

// 运行中的状态。state：boot 刚打开 / starting 服务启动中 / running 页面已打开 / failed 出错停在提示页
var S = {
  state: 'boot', home: '', url: '', standby: false, debug: false, dry: false,
  win: null, wv: null, helper: null, timer: null,
  task: null, pipe: null, out: null, ready: '', loadTries: 0,
};

// ---------- 小工具 ----------

function nil(o) {
  return o === undefined || o === null || (typeof o.isNil === 'function' && o.isNil());
}

function str(o) {
  if (nil(o)) return '';
  var v = ObjC.unwrap(o);
  return v === undefined || v === null ? '' : String(v);
}

function info(key) {
  return str(bundle.objectForInfoDictionaryKey(key));
}

function exists(p) {
  return !!p && fm.fileExistsAtPath(p);
}

function readText(p) {
  if (!exists(p)) return null;
  var s = $.NSString.stringWithContentsOfFileEncodingError(p, UTF8, null);
  return nil(s) ? null : s.js;
}

function fileSize(p) {
  var a = fm.attributesOfItemAtPathError(p, null);
  if (nil(a)) return 0;
  return Number(ObjC.unwrap(a.objectForKey('NSFileSize'))) || 0;
}

// 把上一次的日志留一份（.prev），本次从头记。
function rotate(p, minSize) {
  if (!exists(p) || fileSize(p) < (minSize || 0)) return;
  var prev = p.replace(/\.log$/, '.prev.log');
  fm.removeItemAtPathError(prev, null);
  fm.moveItemAtPathToPathError(p, prev, null);
}

function log(msg) {
  try {
    var line = $(new Date().toISOString() + '  ' + msg + '\n');
    var h = $.NSFileHandle.fileHandleForWritingAtPath(APP_LOG);
    if (nil(h)) {
      line.writeToFileAtomicallyEncodingError(APP_LOG, true, UTF8, null);
      return;
    }
    h.seekToEndOfFile;
    h.writeData(line.dataUsingEncoding(UTF8));
    h.closeFile;
  } catch (e) { /* 写不了日志不影响使用 */ }
}

function safely(what, fn) {
  try {
    return fn();
  } catch (e) {
    log(what + ' 出错：' + e + (e && e.stack ? '\n' + e.stack : ''));
    return undefined;
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function openExternal(url) {
  var u = $.NSURL.URLWithString(url);
  if (nil(u)) return;
  if (S.debug) log('打开：' + url + (S.dry ? '（演练，不真的打开）' : ''));
  if (S.dry) return;
  $.NSWorkspace.sharedWorkspace.openURL(u);
}

// ---------- 找程序文件夹 ----------

function validHome(p) {
  return exists(p + '/server/main.js') && exists(p + '/web/index.html');
}

// 程序文件夹可能在哪：你上次手动选的位置、打包时记下的位置。
function remembered() {
  return [str(prefs.stringForKey('home')), info('AIGroupHome')].filter(Boolean);
}

// 程序装在软件里面时，就在软件包里；否则依次看：软件所在的文件夹（软件跟着程序文件夹走时）→ 你上次手动选的 → 打包时记下的位置。
function findHome() {
  if (BUNDLED) return str(bundle.resourcePath) + '/app';
  var list = [str(bundle.bundlePath.stringByDeletingLastPathComponent)].concat(remembered());
  var i;
  for (i = 0; i < list.length; i++) {
    if (list[i] && validHome(list[i])) return list[i];
  }
  // 记下的位置如果在"文稿 / 桌面 / 下载"里，系统授权之前可能连"它在不在"都问不出来：
  // 先当它在，交给启动那一步去验证——真不在的话，那一步会报"没找到"。
  list = remembered();
  for (i = 0; i < list.length; i++) {
    if (protectedFolder(list[i])) return list[i];
  }
  return '';
}

// 程序文件夹如果在"文稿 / 桌面 / 下载"里，第一次读它时系统会弹一次授权。
function protectedFolder(p) {
  var map = [['/Documents/', T('文稿', 'Documents')], ['/Desktop/', T('桌面', 'Desktop')], ['/Downloads/', T('下载', 'Downloads')]];
  for (var i = 0; i < map.length; i++) {
    if ((p + '/').indexOf(USER_HOME + map[i][0]) === 0) return map[i][1];
  }
  return '';
}

function chooseHome() {
  var panel = $.NSOpenPanel.openPanel;
  panel.setCanChooseDirectories(true);
  panel.setCanChooseFiles(false);
  panel.setAllowsMultipleSelection(false);
  panel.setMessage('请选择「' + NAME + '」的程序文件夹（里面有 server 和 web 两个文件夹）');
  panel.setPrompt('选择');
  if (panel.runModal != 1) return '';
  return str(panel.URL.path);
}

// ---------- 提示页（启动中 / 出错） ----------

var PAGE_CSS = [
  ':root{color-scheme:light dark;--bg:#f5f4f0;--panel:#fff;--line:#e1dfd7;--text:#1f1e1b;--muted:#7a766c;--ink:#26251f;--ink-text:#f7f6f2}',
  '@media(prefers-color-scheme:dark){:root{--bg:#171715;--panel:#21201d;--line:#32302b;--text:#ebe9e2;--muted:#9c988c;--ink:#ebe9e2;--ink-text:#1b1a18}}',
  'html,body{height:100%;margin:0}',
  'body{background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;display:flex;align-items:center;justify-content:center;-webkit-user-select:none;cursor:default}',
  '.box{max-width:540px;padding:32px;text-align:center}',
  '.mark{position:relative;width:64px;height:58px;margin:0 auto 18px}',
  '.mark i{position:absolute;width:34px;height:34px;border-radius:50%}',
  '.mark i:nth-child(1){left:15px;top:0;background:#c9643c}',
  '.mark i:nth-child(2){left:0;top:24px;background:#3d7bea;opacity:.9}',
  '.mark i:nth-child(3){left:30px;top:24px;background:#12956f;opacity:.9}',
  '.busy .mark{animation:breathe 1.6s ease-in-out infinite}',
  '@keyframes breathe{50%{opacity:.45}}',
  'h1{font-size:20px;font-weight:600;margin:0 0 8px}',
  'p{margin:6px 0;color:var(--muted)}',
  'code{font:13px ui-monospace,Menlo,monospace;color:var(--text);word-break:break-all}',
  '.row{margin-top:18px}',
  'button{font:inherit;border:0;border-radius:8px;padding:7px 18px;margin:0 5px;background:var(--ink);color:var(--ink-text);cursor:pointer}',
  'button.ghost{background:transparent;color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}',
  'pre{text-align:left;white-space:pre-wrap;word-break:break-all;background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:20px 0 0;padding:10px 12px;font:12px/1.5 ui-monospace,Menlo,monospace;max-height:190px;overflow:auto;color:var(--muted);-webkit-user-select:text;cursor:text}',
].join('');

function page(cls, inner, script) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + NAME + '</title><style>' + PAGE_CSS +
    '</style></head><body class="' + cls + '"><div class="box"><div class="mark"><i></i><i></i><i></i></div>' + inner +
    '</div><script>function post(m){try{window.webkit.messageHandlers.aigroup.postMessage(m)}catch(e){}}' + (script || '') +
    '</script></body></html>';
}

function show(html) {
  S.wv.loadHTMLStringBaseURL(html, $.NSURL.URLWithString('about:blank'));
}

function showLoading() {
  // 还没确定程序文件夹时（刚打开的那一下），按可能的位置来写提示，不去碰磁盘
  var where = BUNDLED ? '' : (protectedFolder(S.home) || remembered().map(protectedFolder).filter(Boolean)[0] || '');
  var hint = where
    ? '系统如果问是否允许「' + NAME + '」访问 ' + where + ' 文件夹，请点"' + T('允许', 'Allow') + '"——程序和聊天记录就放在那里。'
    : '还在启动，请再等一下…';
  show(page('busy',
    '<h1>' + NAME + '</h1><p>正在启动…</p><p id="hint" hidden>' + esc(hint) + '</p>',
    'setTimeout(function(){document.getElementById("hint").hidden=false},3500)'));
}

// buttons：[[消息类型, 按钮文字], …]，第一个是主按钮。lines 是已经转义好的 HTML。
function showError(title, lines, buttons, detail) {
  S.state = 'failed';
  var html = '<h1>' + esc(title) + '</h1>' +
    lines.map(function (l) { return '<p>' + l + '</p>'; }).join('') +
    '<div class="row">' + buttons.map(function (b, i) {
      return '<button' + (i ? ' class="ghost"' : '') + ' onclick="post({type:\'' + b[0] + '\'})">' + esc(b[1]) + '</button>';
    }).join('') + '</div>' +
    (detail ? '<pre>' + esc(detail) + '</pre>' : '');
  show(page('', html));
}

function showMissing(note) {
  var was = info('AIGroupHome') || str(prefs.stringForKey('home'));
  showError('没找到程序文件夹', [
    note || '「' + NAME + '」的程序和聊天记录放在一个单独的文件夹里（里面有 server 和 web），现在找不到它了。',
    was ? '原来的位置：<code>' + esc(was) + '</code>' : '',
    '如果你把它挪到了别处或改了名字，重新选一下就行。',
  ].filter(Boolean), [['locate', '选择文件夹…'], ['retry', '重试']]);
}

// ---------- 后台服务 ----------

function stopServer() {
  if (S.task && S.task.isRunning) {
    log('停止后台服务');
    S.task.terminate;
  }
  S.task = null;
  S.pipe = null; // 松开标准输入：即使上面那一下没送到，服务读到"结束"也会自己退出
  S.out = null;
}

function startServer() {
  stopServer();
  S.url = '';
  S.standby = false;
  S.ready = str($.NSTemporaryDirectory()) + 'aigroup-ready-' + $.NSProcessInfo.processInfo.processIdentifier + '.json';
  fm.removeItemAtPathError(S.ready, null);
  rotate(SERVER_LOG);
  fm.createFileAtPathContentsAttributes(SERVER_LOG, $.NSData.data, $());
  S.out = $.NSFileHandle.fileHandleForWritingAtPath(SERVER_LOG);

  // 从"访达"打开的软件，环境变量比终端里少：补上常见的命令目录和 UTF-8。
  var env = $.NSMutableDictionary.dictionaryWithDictionary($.NSProcessInfo.processInfo.environment);
  var path = str(env.objectForKey('PATH')) || '/usr/bin:/bin:/usr/sbin:/sbin';
  env.setObjectForKey($('/opt/homebrew/bin:/usr/local/bin:' + path), 'PATH');
  if (!str(env.objectForKey('LANG')) && !str(env.objectForKey('LC_ALL')) && !str(env.objectForKey('LC_CTYPE'))) {
    env.setObjectForKey($('UTF-8'), 'LC_CTYPE');
  }
  env.setObjectForKey($(S.home), 'AIGROUP_HOME');
  env.setObjectForKey($(S.ready), 'AIGROUP_READY');
  env.setObjectForKey($(info('AIGroupPort')), 'AIGROUP_PORT');
  // 这两个只是给外壳自己用的：不传下去，免得后面启动的命令行工具被当成本软件
  env.removeObjectForKey('CFProcessPath');
  env.removeObjectForKey('AIGROUP_BUNDLE');
  if (BUNDLED) {
    env.setObjectForKey($('bundled'), 'AIGROUP_MODE');
    env.setObjectForKey($(str(bundle.resourcePath)), 'AIGROUP_RES');
  }

  // 程序装在软件里面时：运行环境（Node.js）也在软件里，按这台电脑的处理器选对应的那一份
  var script = BUNDLED ? [
    'cd "$AIGROUP_HOME" || exit 21',
    'case "$(uname -m)" in arm64) A=arm64 ;; *) A=x64 ;; esac',
    'NODE="$AIGROUP_RES/node/$A/bin/node"',
    'if [ ! -x "$NODE" ]; then echo "安装包里没有适合这台电脑（$(uname -m)）的运行环境"; exit 24; fi',
    'echo "用 $NODE 启动：$AIGROUP_HOME"',
    'if [ -n "$AIGROUP_PORT" ]; then exec "$NODE" server/main.js --app "$AIGROUP_READY" --port "$AIGROUP_PORT"; fi',
    'exec "$NODE" server/main.js --app "$AIGROUP_READY"',
  ].join('\n') : [
    'cd "$AIGROUP_HOME" || exit 21',
    '. ./server/find-node.sh || exit 22',
    'NODE="$(find_node)"',
    'if [ -z "$NODE" ]; then no_node_help; exit 23; fi',
    'echo "用 $NODE 启动：$AIGROUP_HOME"',
    'if [ -n "$AIGROUP_PORT" ]; then exec "$NODE" server/main.js --app "$AIGROUP_READY" --port "$AIGROUP_PORT"; fi',
    'exec "$NODE" server/main.js --app "$AIGROUP_READY"',
  ].join('\n');

  var task = $.NSTask.alloc.init;
  task.setLaunchPath('/bin/bash');
  task.setArguments($(['-c', script]));
  task.setEnvironment(env);
  task.setCurrentDirectoryPath(USER_HOME);
  S.pipe = $.NSPipe.pipe; // 一直握着它：本软件一退出，服务那头就读到"结束"并跟着退出
  task.setStandardInput(S.pipe);
  task.setStandardOutput(S.out);
  task.setStandardError(S.out);
  task.launch;
  S.task = task;
  S.state = 'starting';
  log('启动后台服务：' + S.home);
}

function serverFailed(wasRunning) {
  var code = S.task ? S.task.terminationStatus : -1;
  var tail = (readText(SERVER_LOG) || '').trim().slice(-1200);
  log((wasRunning ? '后台服务意外停止' : '后台服务没能启动') + '，退出码 ' + code);
  S.task = null;
  S.pipe = null;
  var where = protectedFolder(S.home);
  if (BUNDLED && code === 24) {
    showError('这个安装包不支持这台电脑', [
      '安装包里没有适合这台电脑处理器的运行环境。请向给你这个软件的人要一份支持你这台电脑的版本。',
    ], [['retry', '重试'], ['logs', '打开日志文件夹']], tail);
  } else if (BUNDLED && (code === 21 || code === 22)) {
    showError('软件不完整', [
      '软件包里的程序文件找不到了。请重新安装一次（把安装包里的「' + NAME + '」再拖进"应用程序"）。',
    ], [['retry', '重试'], ['logs', '打开日志文件夹']], tail);
  } else if (/operation not permitted|EPERM/i.test(tail)) {
    showError(where ? '需要你允许访问 ' + where + ' 文件夹' : '需要你允许访问程序所在的文件夹', [
      '「' + NAME + '」的程序和聊天记录放在 <code>' + esc(S.home) + '</code>，没有这个权限就读不到。',
      '打开 ' + T('系统设置 → 隐私与安全性 → 文件与文件夹', 'System Settings → Privacy &amp; Security → Files and Folders') +
        '，找到「' + NAME + '」，把 ' + (where ? T(where + '文件夹', where + ' Folder') : '对应的那一项') + ' 打开，再回来点"重试"。',
    ], [['privacy', '打开系统设置'], ['retry', '重试']]);
  } else if (code === 21 || (code === 22 && /no such file/i.test(tail))) {
    showMissing();
  } else if (code === 23) {
    showError('缺少运行环境（Node.js）', [
      '任选其一：安装 ChatGPT 桌面应用（它自带一份，本程序会自动借用）；或者到 nodejs.org 下载安装 LTS 版。',
      '装好后点"重试"。',
    ], [['retry', '重试'], ['nodejs', '打开 nodejs.org']]);
  } else {
    showError(wasRunning ? '后台服务意外停止了' : '没能启动', [
      '点"重试"再来一次。一直不行的话，把下面这段内容发给帮你做这个程序的人。',
    ], [['retry', '重试'], ['logs', '打开日志文件夹']], tail || '（没有输出）');
  }
}

// ---------- 流程 ----------

function begin() {
  var home = findHome();
  if (!home) {
    log('没找到程序文件夹');
    showMissing();
    return;
  }
  S.home = home;
  showLoading();
  startServer();
}

function locate() {
  var p = chooseHome();
  if (p) useHome(p);
}

function useHome(p) {
  if (!validHome(p) && !protectedFolder(p)) {
    showMissing('你选的 <code>' + esc(p) + '</code> 里没有 server 和 web 这两个文件夹，不是「' + NAME + '」的程序文件夹。');
    return;
  }
  prefs.setObjectForKey($(p), 'home');
  log('手动选择了程序文件夹：' + p);
  begin();
}

function loadPage() {
  S.wv.loadRequest($.NSURLRequest.requestWithURL($.NSURL.URLWithString(S.url)));
}

function tick() {
  if (S.debug) debugCommand();
  if (S.state === 'boot') {
    S.state = 'idle';
    begin();
    return;
  }
  if (S.state === 'starting') {
    var raw = readText(S.ready);
    var r = null;
    if (raw) { try { r = JSON.parse(raw); } catch (e) { r = null; } }
    if (r && r.url) {
      S.url = r.url;
      S.standby = !!r.standby;
      S.state = 'running';
      S.loadTries = 0;
      log('服务就绪：' + raw);
      loadPage();
      return;
    }
    if (!S.task.isRunning) serverFailed(false);
    return;
  }
  if (S.state === 'running' && S.task && !S.task.isRunning) serverFailed(true);
}

// 页面发来的消息。群聊页面只会用到 open（外部链接交给默认浏览器）；其余几种来自上面的提示页。
function onMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'open') {
    if (typeof m.url === 'string' && /^https?:\/\//i.test(m.url)) openExternal(m.url);
    return;
  }
  if (m.type === 'log') {
    if (S.debug) log('页面：' + String(m.text).slice(0, 4000));
    return;
  }
  if (S.state !== 'failed') return;
  if (m.type === 'retry') begin();
  else if (m.type === 'locate') locate();
  else if (m.type === 'privacy') openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
  else if (m.type === 'nodejs') openExternal('https://nodejs.org/');
  else if (m.type === 'logs') $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath(LOG_DIR));
}

// ---------- 窗口和菜单 ----------

function showWindow() {
  if (!S.win) return;
  if (S.win.isMiniaturized) S.win.deminiaturize(null);
  S.win.makeKeyAndOrderFront(null);
}

// 由 osascript 运行时，自己记住窗口的大小和位置（见 makeWindow）
function saveFrame() {
  if (HOSTED && S.win) prefs.setObjectForKey(S.win.stringWithSavedFrame, 'frame');
}

function setZoom(z) {
  z = Math.min(2.5, Math.max(0.6, Math.round(z * 100) / 100));
  S.wv.setPageZoom(z);
  prefs.setDoubleForKey(z, 'zoom');
}

function makeWindow() {
  var rect = $.NSMakeRect(0, 0, 1180, 780);
  // 15 = 有标题栏 + 可关闭 + 可最小化 + 可调整大小；2 = 缓冲绘制
  var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(rect, 15, 2, false);
  win.setReleasedWhenClosed(false);
  win.setTitle(NAME);
  win.setMinSize($.NSMakeSize(420, 480));
  win.center;
  if (HOSTED) {
    // 由 osascript 运行时，系统自带的"记住窗口位置"会记到 osascript 名下：改成自己记在本软件的偏好设置里
    var saved = str(prefs.stringForKey('frame'));
    if (saved) win.setFrameFromString(saved);
  } else {
    win.setFrameAutosaveName('AIGroupMain'); // 记住上次的窗口大小和位置
  }

  var conf = $.WKWebViewConfiguration.alloc.init;
  // 同样的原因：网页数据不写到磁盘上（页面本来也不需要存东西），免得在 osascript 名下留下缓存
  if (HOSTED) conf.setWebsiteDataStore($.WKWebsiteDataStore.nonPersistentDataStore);
  conf.userContentController.addScriptMessageHandlerName(S.helper, 'aigroup');
  var wv = $.WKWebView.alloc.initWithFrameConfiguration(rect, conf);
  wv.setAutoresizingMask(18); // 跟着窗口变宽变高
  wv.setNavigationDelegate(S.helper);
  var z = prefs.doubleForKey('zoom');
  if (z >= 0.6 && z <= 2.5) wv.setPageZoom(z);

  win.setContentView(wv);
  win.makeFirstResponder(wv); // 一打开就能直接打字，不用先点一下页面
  win.setDelegate(S.helper);
  S.win = win;
  S.wv = wv;
}

function buildMenu() {
  function sub(main, title) {
    var holder = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, null, '');
    var m = $.NSMenu.alloc.initWithTitle(title);
    holder.setSubmenu(m);
    main.addItem(holder);
    return m;
  }
  function item(menu, title, action, key, mods, mine) {
    var it = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent(title, action, key || '');
    if (mods) it.setKeyEquivalentModifierMask(mods);
    if (mine) it.setTarget(S.helper);
    menu.addItem(it);
    return it;
  }
  function line(menu) { menu.addItem($.NSMenuItem.separatorItem); }

  var main = $.NSMenu.alloc.initWithTitle('Main');

  var app = sub(main, NAME);
  item(app, T('关于 ', 'About ') + NAME, 'orderFrontStandardAboutPanel:');
  line(app);
  item(app, T('隐藏 ', 'Hide ') + NAME, 'hide:', 'h');
  item(app, T('隐藏其他', 'Hide Others'), 'hideOtherApplications:', 'h', CMD | OPT);
  item(app, T('全部显示', 'Show All'), 'unhideAllApplications:');
  line(app);
  item(app, T('退出 ', 'Quit ') + NAME, 'terminate:', 'q');

  var edit = sub(main, T('编辑', 'Edit'));
  item(edit, T('撤销', 'Undo'), 'undo:', 'z');
  item(edit, T('重做', 'Redo'), 'redo:', 'z', CMD | SHIFT);
  line(edit);
  item(edit, T('剪切', 'Cut'), 'cut:', 'x');
  item(edit, T('拷贝', 'Copy'), 'copy:', 'c');
  item(edit, T('粘贴', 'Paste'), 'paste:', 'v');
  item(edit, T('全选', 'Select All'), 'selectAll:', 'a');

  var view = sub(main, T('显示', 'View'));
  item(view, T('重新载入', 'Reload'), 'menuReload:', 'r', 0, true);
  line(view);
  item(view, T('放大', 'Zoom In'), 'menuZoomIn:', '=', 0, true);
  item(view, T('缩小', 'Zoom Out'), 'menuZoomOut:', '-', 0, true);
  item(view, T('实际大小', 'Actual Size'), 'menuZoomReset:', '0', 0, true);

  var win = sub(main, T('窗口', 'Window'));
  item(win, T('显示主窗口', 'Show Main Window'), 'menuShow:', '1', 0, true);
  item(win, T('关闭窗口', 'Close Window'), 'performClose:', 'w');
  line(win);
  item(win, T('最小化', 'Minimize'), 'performMiniaturize:', 'm');
  item(win, T('缩放', 'Zoom'), 'performZoom:');

  $.NSApp.setMainMenu(main);
  $.NSApp.setWindowsMenu(win);
}

// 窗口、网页、菜单、定时器都通过这个对象回调到上面的函数。
ObjC.registerSubclass({
  name: 'AIGHelper',
  superclass: 'NSObject',
  methods: {
    'tick:': {
      types: ['void', ['id']],
      implementation: function () { safely('定时检查', tick); },
    },
    // 点窗口左上角的关闭：只把窗口收起来，AI 们继续干活；点程序坞图标再打开。真正退出用 ⌘Q。
    'windowShouldClose:': {
      types: ['bool', ['id']],
      implementation: function () {
        safely('收起窗口', function () { saveFrame(); S.win.orderOut(null); });
        return false;
      },
    },
    'userContentController:didReceiveScriptMessage:': {
      types: ['void', ['id', 'id']],
      implementation: function (controller, message) {
        safely('页面消息', function () { onMessage(ObjC.deepUnwrap(message.body)); });
      },
    },
    'webView:didFinishNavigation:': {
      types: ['void', ['id', 'id']],
      implementation: function (wv) {
        safely('载入完成', function () { if (S.debug) log('载入完成：' + str(wv.URL.absoluteString)); });
      },
    },
    // 页面没打开（比如服务刚好在重启）：隔一会儿再试几次，还不行就给出提示。
    'webView:didFailProvisionalNavigation:withError:': {
      types: ['void', ['id', 'id', 'id']],
      implementation: function (wv, nav, error) {
        safely('载入失败', function () {
          log('页面没打开：' + str(error.localizedDescription));
          if (S.state !== 'running') return;
          S.loadTries += 1;
          if (S.loadTries <= 8) {
            $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(1, S.helper, 'retryLoad:', null, false);
          } else {
            showError('群聊页面打不开', ['后台服务没有回应。点"重试"会把它重新启动。'], [['retry', '重试'], ['logs', '打开日志文件夹']]);
          }
        });
      },
    },
    'retryLoad:': {
      types: ['void', ['id']],
      implementation: function () { safely('重新载入', function () { if (S.state === 'running') loadPage(); }); },
    },
    'webViewWebContentProcessDidTerminate:': {
      types: ['void', ['id']],
      implementation: function () { safely('页面进程重启', function () { log('页面进程意外退出，重新载入'); if (S.state === 'running') loadPage(); }); },
    },
    'menuReload:': {
      types: ['void', ['id']],
      implementation: function () { safely('重新载入', function () { if (S.state === 'running') loadPage(); }); },
    },
    'menuZoomIn:': {
      types: ['void', ['id']],
      implementation: function () { safely('放大', function () { setZoom(S.wv.pageZoom + 0.1); }); },
    },
    'menuZoomOut:': {
      types: ['void', ['id']],
      implementation: function () { safely('缩小', function () { setZoom(S.wv.pageZoom - 0.1); }); },
    },
    'menuZoomReset:': {
      types: ['void', ['id']],
      implementation: function () { safely('实际大小', function () { setZoom(1); }); },
    },
    'menuShow:': {
      types: ['void', ['id']],
      implementation: function () { safely('显示主窗口', showWindow); },
    },
    // 下面三个只在由 osascript 运行时用到（那时没有小程序外壳替我们接这些事件）
    'applicationShouldHandleReopen:hasVisibleWindows:': {
      types: ['bool', ['id', 'bool']],
      implementation: function () { reopen(); return true; },
    },
    'applicationShouldTerminateAfterLastWindowClosed:': {
      types: ['bool', ['id']],
      implementation: function () { return false; },
    },
    'applicationWillTerminate:': {
      types: ['void', ['id']],
      implementation: function () { safely('记住窗口位置', saveFrame); quit(); },
    },
    'windowDidEndLiveResize:': {
      types: ['void', ['id']],
      implementation: function () { safely('记住窗口位置', saveFrame); },
    },
  },
});

// ---------- 调试（只有打包时加了 AIGROUP_APP_DEBUG=1 才有） ----------
// 往 ~/Library/Logs/aigroup/debug-cmd 里写一行命令：
//   state / close / show / quit / snap <文件> / js <代码> / dry on|off / zoom <倍数> / menuitem <第几个菜单> <第几项>
//   post <JSON>（当作页面发来的消息）/ sethome <文件夹>（当作手动选了这个文件夹）/ locate-abort（弹出选文件夹的框，1 秒后自动取消）
//   type <文字>（模拟键盘输入）

function describeMenu() {
  var out = [];
  var items = $.NSApp.mainMenu.itemArray;
  for (var i = 0; i < items.count; i++) {
    var it = items.objectAtIndex(i);
    var subs = [];
    if (it.hasSubmenu) {
      var arr = it.submenu.itemArray;
      for (var j = 0; j < arr.count; j++) {
        var s = arr.objectAtIndex(j);
        subs.push(s.isSeparatorItem ? '—' : str(s.title) + (str(s.keyEquivalent) ? '(' + str(s.keyEquivalent) + ')' : ''));
      }
    }
    out.push('[' + str(it.title) + '] ' + subs.join(' | '));
  }
  return out.join('\n  ');
}

function snapshot(path) {
  ObjC.import('CoreGraphics');
  // 8 = 只拍指定的那个窗口；1 = 不带窗口阴影
  var img = $.CGWindowListCreateImage($.CGRectMake(Infinity, Infinity, 0, 0), 8, S.win.windowNumber, 1);
  var rep = $.NSBitmapImageRep.alloc.initWithCGImage(img);
  var data = rep.representationUsingTypeProperties(4, $({}));
  data.writeToFileAtomically(path, true);
  log('截图：' + path);
}

function debugCommand() {
  var p = LOG_DIR + '/debug-cmd';
  var cmd = readText(p);
  if (cmd === null) return;
  fm.removeItemAtPathError(p, null);
  cmd = cmd.trim();
  log('调试命令：' + cmd);
  safely('调试命令', function () {
    if (cmd === 'state') {
      var f = S.win.frame;
      log('状态 ' + JSON.stringify({
        state: S.state, home: S.home, url: S.url, standby: S.standby,
        visible: !!S.win.isVisible, mini: !!S.win.isMiniaturized, key: !!S.win.isKeyWindow, active: !!$.NSApp.isActive,
        frame: [f.origin.x, f.origin.y, f.size.width, f.size.height],
        responder: str($.NSStringFromClass(S.win.firstResponder.class)),
        page: str(S.wv.URL.absoluteString), title: str(S.wv.title), zoom: S.wv.pageZoom,
        server: S.task ? !!S.task.isRunning : null,
      }) + '\n  ' + describeMenu());
    } else if (cmd === 'close') {
      S.win.performClose(null);
    } else if (cmd === 'show') {
      showWindow();
    } else if (cmd === 'quit') {
      $.NSApp.performSelectorWithObjectAfterDelay('terminate:', $.NSApp, 0.2);
    } else if (cmd.indexOf('snap ') === 0) {
      snapshot(cmd.slice(5));
    } else if (cmd.indexOf('js ') === 0) {
      // 回调必须给一个真的函数：给 null 的话系统回调时会让整个软件崩掉
      S.wv.evaluateJavaScriptCompletionHandler(cmd.slice(3), function (result, error) {
        safely('页面脚本结果', function () {
          log('页面脚本结果：' + (nil(error) ? str(result) : '出错 ' + str(error.localizedDescription)));
        });
      });
    } else if (cmd.indexOf('post ') === 0) {
      onMessage(JSON.parse(cmd.slice(5)));
    } else if (cmd.indexOf('sethome ') === 0) {
      useHome(cmd.slice(8));
    } else if (cmd === 'locate-abort') {
      $.NSApp.performSelectorWithObjectAfterDelayInModes('abortModal', $.NSApp, 1, $(['NSModalPanelRunLoopMode', 'kCFRunLoopDefaultMode']));
      locate();
      log('选文件夹的框已取消');
    } else if (cmd.indexOf('type ') === 0) {
      // 模拟键盘一个字一个字地敲（10 = 按下，11 = 松开）
      var text = cmd.slice(5);
      for (var n = 0; n < text.length; n++) {
        [10, 11].forEach(function (kind) {
          S.win.sendEvent($.NSEvent.keyEventWithTypeLocationModifierFlagsTimestampWindowNumberContextCharactersCharactersIgnoringModifiersIsARepeatKeyCode(
            kind, $.NSMakePoint(0, 0), 0, 0, S.win.windowNumber, $(), text[n], text[n], false, 0));
        });
      }
    } else if (cmd.indexOf('dry ') === 0) {
      S.dry = cmd.slice(4) === 'on';
    } else if (cmd.indexOf('zoom ') === 0) {
      setZoom(Number(cmd.slice(5)));
    } else if (cmd.indexOf('menuitem ') === 0) {
      // 模拟点一下菜单项，例如 "menuitem 2 0" = 第 3 个菜单的第 1 项
      var ij = cmd.slice(9).split(' ');
      $.NSApp.mainMenu.itemAtIndex(Number(ij[0])).submenu.performActionForItemAtIndex(Number(ij[1]));
    }
  });
}

// ---------- 系统调用的三个入口 ----------

function run() {
  if (S.win) { // 已经在运行时又被打开了一次
    showWindow();
    return;
  }
  fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(LOG_DIR, true, $(), null);
  rotate(APP_LOG, 300 * 1024);
  log('—— 打开 ' + str(bundle.bundlePath) + ' ——');
  safely('启动', function () {
    S.debug = info('AIGroupDebug') === '1';
    S.helper = $.AIGHelper.alloc.init;
    if (HOSTED) {
      // 由 osascript 运行：自己把"应用"搭起来（普通的带程序坞图标的应用），事件交给上面那个对象
      $.NSApplication.sharedApplication;
      $.NSApp.setActivationPolicy(0);
      $.NSApp.setDelegate(S.helper);
      var icon = $.NSImage.alloc.initWithContentsOfFile(str(bundle.resourcePath) + '/AppIcon.icns');
      if (!nil(icon)) $.NSApp.setApplicationIconImage(icon);
    }
    makeWindow();
    safely('菜单', buildMenu);
    showLoading();
    S.win.makeKeyAndOrderFront(null);
    $.NSApp.activateIgnoringOtherApps(true);
    S.timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.3, S.helper, 'tick:', null, true);
  });
  if (HOSTED) $.NSApp.run; // 由 osascript 运行时，这里一直运行到软件退出
}

// 点程序坞图标 / 再次双击软件
function reopen() {
  if (S.debug) log('再次打开（点了程序坞图标）');
  safely('再次打开', showWindow);
}

function quit() {
  log('退出');
  safely('退出', stopServer);
  return true;
}
