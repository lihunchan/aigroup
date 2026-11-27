// AI 群聊 —— 页面逻辑。不依赖任何第三方库。
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // 页面如果是开在软件窗口（AI 群聊.app）里，这里能拿到和软件通话的口子；在普通浏览器里是 null。
  const NATIVE = (function () {
    try { return window.webkit.messageHandlers.aigroup || null; } catch (e) { return null; }
  })();
  const DEFAULT_PH =window.innerWidth < 560 ? '说点什么…  @ 可以点名' : '说点什么…  直接发 = 主控来答；输入 @ 可以点名';

  const S = {
    rooms: [], roomId: null, room: null,
    settings: null, info: {}, roles: {}, flows: [], options: {}, health: {}, agents: [], root: '',
    typing: {}, flow: null, flowHidden: null, busy: false, picked: null, mention: null, live: false,
    drafts: {}, // 提问卡片上还没提交的选择，按提问那条消息的编号存
  };

  // ---------- 小工具 ----------

  function el(tag, attrs) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v; // 只用于 MD.render 的结果和固定图标
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const GLYPH = {
    claude: '<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6 6 18"/></g></svg>',
    gemini: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5c.6 5.2 4.3 8.9 9.5 9.5-5.2.6-8.9 4.3-9.5 9.5-.6-5.2-4.3-8.9-9.5-9.5 5.2-.6 8.9-4.3 9.5-9.5Z"/></svg>',
    gpt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round" d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6L12 3.2Z"/><circle cx="12" cy="12" r="2.4" fill="currentColor"/></svg>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.7" fill="currentColor"/><path fill="currentColor" d="M4.5 20c.5-4 3.6-6.3 7.5-6.3s7 2.3 7.5 6.3Z"/></svg>',
  };

  function avatar(id, small) {
    return el('div', { class: 'avatar ' + id + (small ? ' sm' : ''), html: GLYPH[id] || GLYPH.user });
  }

  function nameOf(id) {
    if (id === 'user') return '我';
    return (S.info[id] && S.info[id].name) || id;
  }

  function roleLabel(agent) {
    const keys = Object.keys(S.roles).filter((r) => S.settings.roles[r] === agent);
    return keys.length ? keys.map((r) => S.roles[r].name).join(' / ') : '成员';
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(ts) {
    const d = new Date(ts);
    const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return d.toDateString() === new Date().toDateString() ? hm : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }
  function fmtDur(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  async function api(method, url, body) {
    const init = { method: method, headers: {} };
    if (method !== 'GET') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body || {});
    }
    const res = await fetch(url, init);
    let data = {};
    try { data = await res.json(); } catch (e) { /* 不是 JSON */ }
    if (!res.ok) throw new Error(data.error || '请求失败（' + res.status + '）');
    return data;
  }

  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3400);
  }

  function copyText(text, btn) {
    const done = function () {
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { toast('复制失败，请手动选中复制'); });
    } else {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败，请手动选中复制'); }
      ta.remove();
    }
  }

  // ---------- 滚动 ----------

  function nearBottom() {
    const s = $('stream');
    return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
  }
  function scrollBottom() {
    const s = $('stream');
    s.scrollTop = s.scrollHeight;
    $('btnJump').hidden = true;
  }

  // ---------- 侧栏 ----------

  // 把某条消息的开头滚到可见区域的顶部（提问卡片可能很长，要从头看起）
  function scrollToNode(node) {
    const s = $('stream');
    s.scrollTop += node.getBoundingClientRect().top - s.getBoundingClientRect().top - 14;
    $('btnJump').hidden = true;
  }

  function renderRooms() {
    const box = $('rooms');
    box.textContent = '';
    if (!S.rooms.length) {
      box.append(el('div', { class: 'rooms-empty', text: '还没有群聊' }));
      return;
    }
    S.rooms.forEach(function (r) {
      const last = r.last ? nameOf(r.last.from) + '：' + r.last.text : '还没有消息';
      box.append(el('button', {
        class: 'room' + (r.id === S.roomId ? ' active' : ''), type: 'button',
        'aria-current': r.id === S.roomId ? 'true' : null,
        onclick: function () { openRoom(r.id).then(focusInput); },
      },
      el('div', { class: 'room-title', text: r.title }),
      el('div', { class: 'room-last' }, r.waiting ? el('b', { class: 'room-wait', text: '等你回答 · ' }) : null, last),
      r.busy ? el('span', { class: 'room-busy', title: '正在对话' }) : null));
    });
  }

  function healthOf(agent) {
    const m = S.settings.members[agent];
    const h = S.health[agent] || {};
    if (!m.enabled) return { cls: '', text: '已停用', state: 'off' };
    if (h.state === 'ok') return { cls: 'ok', text: h.detail || '可用', state: 'ok' };
    if (h.state === 'login') return { cls: 'bad', text: '需要登录', state: 'login' };
    if (h.state === 'missing') return { cls: 'bad', text: '没有安装', state: 'missing' };
    if (h.state === 'error') return { cls: 'bad', text: '暂时叫不动', state: 'error' };
    return { cls: '', text: '检测中…', state: '' };
  }

  function renderMembers() {
    const box = $('members');
    box.textContent = '';
    S.agents.forEach(function (a) {
      const d = healthOf(a);
      box.append(el('button', {
        class: 'member' + (S.settings.members[a].enabled ? '' : ' off'), type: 'button',
        onclick: function () { showMember(a); },
      },
      avatar(a, true),
      el('div', { class: 'member-main' },
        el('div', { class: 'member-name' }, nameOf(a), el('span', { class: 'tag', text: roleLabel(a) })),
        el('div', { class: 'member-sub', text: d.state === 'ok' ? '经由 ' + S.info[a].via : d.text })),
      el('span', { class: 'dot ' + d.cls, title: d.text })));
    });
    renderBanner();
  }

  // 主控叫不动（没登录 / 应用没开 / 被停用）时，在顶部说清楚，并给出两条出路。
  function renderBanner() {
    const bar = $('banner');
    bar.textContent = '';
    const lead = S.settings.roles.lead;
    const d = healthOf(lead);
    if (d.state === 'ok' || d.state === '') {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.append(el('span', { text: '主控 ' + nameOf(lead) + ' 现在叫不动（' + d.text + '）。不点名的消息和固定流程都要靠主控。' }));
    bar.append(el('button', {
      class: 'note-btn', type: 'button', text: d.state === 'off' ? '去设置' : '怎么解决',
      onclick: function () { if (d.state === 'off') showSettings(); else showMember(lead); },
    }));
    // 代任人选：优先找不是军师的那位——主控和军师是同一位的话，"各出一份方案"就只剩一份了。
    const able = S.agents.filter(function (a) {
      return a !== lead && S.settings.members[a].enabled && healthOf(a).state === 'ok';
    });
    const sub = able.find(function (a) { return a !== S.settings.roles.advisor; }) || able[0];
    if (sub) {
      bar.append(el('button', {
        class: 'link', type: 'button', text: '先让 ' + nameOf(sub) + ' 代任主控',
        onclick: async function () {
          try {
            const res = await api('POST', '/api/settings', { roles: { lead: sub } });
            applySettings(res.settings);
            toast('已让 ' + nameOf(sub) + ' 代任主控。之后可以在"设置与分工"里换回来。');
          } catch (e) { toast(e.message); }
        },
      }));
    }
  }

  // ---------- 头部 / 流程条 ----------

  function renderHeader() {
    const r = S.room;
    if (!r) return;
    $('roomTitle').textContent = r.title;
    const names = S.agents
      .filter(function (a) { return S.settings.members[a].enabled; })
      .map(function (a) { return nameOf(a) + '（' + roleLabel(a) + '）'; });
    $('roomSub').textContent = ['我'].concat(names).join(' · ');
    $('modeSeg').querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.mode === r.mode);
      b.setAttribute('aria-pressed', b.dataset.mode === r.mode ? 'true' : 'false');
    });
    document.title = r.title + ' · AI 群聊';
  }

  function renderFlow() {
    const bar = $('flowbar');
    const f = S.flow;
    if (!f || S.flowHidden === f.runId) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    bar.textContent = '';
    bar.append(el('span', { class: 'flowbar-name', text: (f.icon ? f.icon + ' ' : '') + f.name }));
    const steps = el('div', { class: 'steps' });
    f.steps.forEach(function (s, i) {
      if (i) steps.append(el('span', { class: 'step-arrow', text: '→' }));
      const mark = s.state === 'done' ? '✓' : s.state === 'waiting' ? '?' : (s.state === 'failed' || s.state === 'stopped') ? '!' : String(i + 1);
      steps.append(el('span', { class: 'step ' + s.state },
        el('span', { class: 'num', text: mark }),
        s.label + (s.state === 'waiting' ? ' · 等你回答' : ''),
        el('span', { class: 'who', text: s.agents.map(nameOf).join(' ∥ ') + (s.ask ? ' ⇄ 我' : '') })));
    });
    steps.append(el('span', { class: 'step-arrow', text: '→' }));
    steps.append(el('span', { class: 'step' + (f.state === 'done' ? ' running' : '') },
      el('span', { class: 'num', text: '我' }), '拍板'));
    bar.append(steps);
    const cur = steps.querySelector('.step.waiting, .step.running');
    if (cur) steps.scrollLeft += cur.getBoundingClientRect().left - steps.getBoundingClientRect().left - 8;
    if (f.state === 'waiting') {
      // 流程停在"等你回答"：不想答了可以直接结束
      bar.append(el('button', {
        class: 'flowbar-end', type: 'button', text: '结束流程', title: '不再回答，结束这个流程',
        onclick: async function () {
          try { await api('POST', '/api/rooms/' + S.roomId + '/stop'); } catch (e) { toast(e.message); }
        },
      }));
    } else if (f.state !== 'running') {
      bar.append(el('button', {
        class: 'flowbar-close', type: 'button', title: '收起', 'aria-label': '收起流程进度', text: '×',
        onclick: function () { S.flowHidden = f.runId; renderFlow(); },
      }));
    }
  }

  // ---------- 消息 ----------

  function activityNode(acts) {
    const list = el('ul');
    acts.forEach(function (a) {
      const icon = a.kind === 'cmd' ? '$ ' : a.kind === 'edit' ? '✎ ' : a.kind === 'search' ? '⌕ ' : '· ';
      list.append(el('li', { class: a.ok === false ? 'fail' : null, text: icon + a.text, title: a.text }));
    });
    return el('details', { class: 'activity' }, el('summary', { text: '过程 · ' + acts.length + ' 步' }), list);
  }

  function systemNode(m) {
    const inner = el('div', { class: 'note-inner' }, el('span', { text: m.text }));
    const next = m.meta && m.meta.next;
    if (next) {
      inner.append(el('button', {
        class: 'note-btn', type: 'button', text: '下一步：' + (next.icon ? next.icon + ' ' : '') + next.name,
        onclick: function () { pickFlow(next.id, true); },
      }));
    }
    return el('div', { class: 'note', 'data-id': m.id }, inner);
  }

  function errorNode(m) {
    const line = el('span');
    if (m.from && m.from !== 'system') line.append(el('b', { text: nameOf(m.from) + ' 没能回复：' }));
    line.append(m.text);
    const inner = el('div', { class: 'note-inner' }, line);
    const code = m.meta && m.meta.code;
    if (S.agents.indexOf(m.from) >= 0 && (code === 'NOT_LOGGED_IN' || code === 'NOT_RUNNING' || code === 'NOT_INSTALLED')) {
      inner.append(el('button', { class: 'note-btn', type: 'button', text: '怎么解决', onclick: function () { showMember(m.from); } }));
    }
    return el('div', { class: 'note err', 'data-id': m.id }, inner);
  }

  // ---------- 提问卡片（"问清需求"这一步，主控用它向你提问） ----------

  // 回答某条提问的那条消息（没有就是还没回答）
  function answerTo(askId) {
    const msgs = S.room ? S.room.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const a = msgs[i].meta && msgs[i].meta.answer;
      if (a && a.to === askId) return msgs[i];
    }
    return null;
  }

  // 一张提问卡片现在的状态：answered 已经回答 / live 正等你回答 / closed 没回答就结束了
  function askState(m) {
    if (answerTo(m.id)) return 'answered';
    const f = S.flow;
    if (f && f.state === 'waiting' && f.wait && f.wait.askId === m.id) return 'live';
    // 提问刚发出来、流程状态还没跟上的那一瞬间，也算正在等你回答
    const mf = m.meta.flow;
    if (f && f.state === 'running' && mf && mf.runId === f.runId) {
      const msgs = S.room.messages;
      if (msgs[msgs.length - 1] === m) return 'live';
    }
    return 'closed';
  }

  function draftDone(d) {
    return d.auto || d.picks.length > 0 || (d.otherOn && d.other.trim().length > 0);
  }

  async function sendAnswer(m, payload, btn) {
    btn.disabled = true;
    try {
      await api('POST', '/api/rooms/' + S.roomId + '/messages', { answer: payload });
      delete S.drafts[m.id];
      setBusy(true);
      if (!S.live) openRoom(S.roomId);
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  }

  function askNode(m) {
    const ask = m.meta.ask;
    const state = askState(m);
    const live = state === 'live';
    const ansMsg = state === 'answered' ? answerTo(m.id) : null;
    const ans = ansMsg ? ansMsg.meta.answer : null;
    const blank = function () { return { picks: [], other: '', otherOn: false, auto: false }; };
    const draft = S.drafts[m.id] || (S.drafts[m.id] = ask.questions.map(blank));
    const box = el('div', { class: 'ask ' + state, 'data-state': state });
    const syncs = [];
    let submit = null;
    let left = null;

    function syncAll() {
      syncs.forEach(function (fn) { fn(); });
      if (!submit) return;
      const n = draft.filter(function (d) { return !draftDone(d); }).length;
      submit.disabled = n > 0;
      left.textContent = n ? '还有 ' + n + ' 个问题没回答' : '';
    }

    ask.questions.forEach(function (q, i) {
      // 答过的卡片照当时的回答显示；正在等回答的照你现在点选的显示
      const got = ans && ans.items ? ans.items[i] : null;
      const d = got
        ? { picks: got.picks || [], other: got.other || '', otherOn: !!got.other, auto: !!got.auto }
        : (live ? draft[i] : blank());
      const qbox = el('div', { class: 'ask-q' },
        el('div', { class: 'ask-head' },
          q.title ? el('span', { class: 'ask-title', text: q.title }) : null,
          el('span', { class: 'ask-text', text: q.question }),
          q.multi ? el('span', { class: 'ask-multi', text: '可多选' }) : null));
      const list = el('div', { class: 'ask-opts' + (q.multi ? ' multi' : '') });
      const buttons = [];
      function add(extra, label, desc, isOn, onPick) {
        const b = el('button', { class: 'ask-opt' + (extra ? ' extra' : ''), type: 'button', disabled: !live },
          el('i', { class: 'ask-mark', 'aria-hidden': 'true' }),
          el('span', { class: 'ask-body' }, el('b', { text: label }), desc ? el('span', { text: desc }) : null));
        if (live) b.addEventListener('click', function () { onPick(); syncAll(); });
        buttons.push({ node: b, isOn: isOn });
        list.append(b);
      }
      q.options.forEach(function (o) {
        add(false, o.label, o.desc, function () { return d.picks.indexOf(o.label) >= 0; }, function () {
          if (q.multi) {
            const k = d.picks.indexOf(o.label);
            if (k >= 0) d.picks.splice(k, 1);
            else d.picks.push(o.label);
          } else {
            d.picks = [o.label];
            d.otherOn = false;
          }
          d.auto = false;
        });
      });
      let other;
      if (live) {
        other = el('textarea', { class: 'ask-other', rows: '2', placeholder: '用你自己的话写…', 'aria-label': '其他：自己写' });
        other.value = d.other;
        other.addEventListener('input', function () { d.other = other.value; syncAll(); });
      } else {
        other = el('div', { class: 'ask-other static', text: d.other });
      }
      add(true, '其他', '以上都不合适，我自己写', function () { return d.otherOn; }, function () {
        d.otherOn = q.multi ? !d.otherOn : true;
        if (!q.multi) d.picks = [];
        d.auto = false;
        if (d.otherOn) setTimeout(function () { other.focus(); }, 0);
      });
      list.append(other);
      add(true, '你来定', '这一项交给 ' + nameOf(m.from) + ' 决定', function () { return d.auto; }, function () {
        d.auto = !d.auto;
        if (d.auto) {
          d.picks = [];
          d.otherOn = false;
        }
      });
      syncs.push(function () {
        buttons.forEach(function (b) {
          const on = b.isOn();
          b.node.classList.toggle('on', on);
          b.node.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        other.hidden = !d.otherOn;
      });
      qbox.append(list);
      box.append(qbox);
    });

    const foot = el('div', { class: 'ask-foot' });
    if (live) {
      submit = el('button', { class: 'btn primary', type: 'button', text: '提交回答' });
      submit.addEventListener('click', function () {
        const items = draft.map(function (d) {
          return { picks: d.picks, other: d.otherOn ? d.other.trim() : '', auto: d.auto };
        });
        sendAnswer(m, { to: m.id, items: items }, submit);
      });
      left = el('span', { class: 'ask-left' });
      foot.append(submit, left, el('button', {
        class: 'link', type: 'button', text: '不用再问了，直接往下走',
        title: '还没问到的都交给 ' + nameOf(m.from) + ' 决定',
        onclick: function (e) { sendAnswer(m, { to: m.id, skip: true }, e.currentTarget); },
      }));
      box.append(foot, el('div', { class: 'ask-tip', text: '也可以不点选项，直接在下面的输入框里用自己的话回答。' }));
    } else {
      const note = state !== 'answered' ? '这一轮提问没有回答'
        : ans.skip ? '你选择了不再回答，直接往下走'
          : ans.items ? '已回答' : '已用文字回答（见下一条消息）';
      foot.append(el('span', { class: 'ask-left', text: note }));
      box.append(foot);
    }
    syncAll();
    return box;
  }

  // 你在卡片上的回答：一行一个问题，比整段文字好认
  function answerBubble(m) {
    const a = m.meta && m.meta.answer;
    if (!a || !a.items) return null;
    const card = S.room.messages.find(function (x) { return x.id === a.to; });
    const qs = card && card.meta && card.meta.ask && card.meta.ask.questions;
    if (!qs) return null;
    const box = el('div', { class: 'bubble answer' });
    qs.forEach(function (q, i) {
      const it = a.items[i] || {};
      const said = it.auto ? '你来定' : (it.picks || []).concat(it.other ? ['其他：' + it.other] : []).join('；');
      box.append(el('div', { class: 'ans-row' },
        el('span', { class: 'ans-q', text: (q.title || q.question) + '：' }),
        el('span', { class: 'ans-a', text: said })));
    });
    return box;
  }

  // 流程状态变了、或者来了一条回答之后：把状态对不上的提问卡片重画一遍
  function refreshAsks() {
    if (!S.room) return;
    Array.prototype.slice.call($('messages').querySelectorAll('.ask')).forEach(function (box) {
      const node = box.closest('.msg');
      const m = node && S.room.messages.find(function (x) { return x.id === node.dataset.id; });
      if (!m || askState(m) === box.dataset.state) return;
      node.replaceWith(messageNode(m));
    });
    if (!S.picked) $('input').placeholder = idlePlaceholder();
  }

  // 没有选流程时，输入框里的提示语
  function idlePlaceholder() {
    const f = S.flow;
    if (f && f.state === 'waiting') {
      if (!f.wait || !f.wait.card) return '在这里回答主控…'; // 这一轮没有选项卡片：只能打字
      return window.innerWidth < 560 ? '用自己的话回答…' : '在这里用自己的话回答（也可以点上面卡片里的选项）';
    }
    return DEFAULT_PH;
  }

  function messageNode(m) {
    if (m.kind === 'system') return systemNode(m);
    if (m.kind === 'error') return errorNode(m);
    const isUser = m.from === 'user';
    const ask = !isUser && m.meta && m.meta.ask;
    const node = el('article', { class: 'msg from-' + m.from, 'data-id': m.id });
    if (!isUser) node.append(avatar(m.from));
    const body = el('div', { class: 'msg-body' });
    const head = el('div', { class: 'msg-head' });
    if (!isUser) {
      head.append(el('span', { class: 'msg-name', text: nameOf(m.from) }), el('span', { class: 'tag', text: roleLabel(m.from) }));
    }
    const flow = m.meta && m.meta.flow;
    if (flow) {
      const round = ask && ask.round > 1 ? '（第 ' + ask.round + ' 轮）' : '';
      head.append(el('span', { class: 'tag flow', text: flow.step ? flow.name + ' · ' + flow.step + round : '流程：' + flow.name }));
    }
    head.append(el('span', { class: 'msg-meta', text: fmtTime(m.ts) }));
    body.append(head);
    // 带提问卡片的消息：气泡里只放开场白，问题和选项画成卡片
    body.append((isUser && answerBubble(m)) || el('div', { class: 'bubble md', html: window.MD.render(ask ? ask.intro : m.text) }));
    if (ask) body.append(askNode(m));
    if (!isUser) {
      const acts = (m.meta && m.meta.activity) || [];
      if (acts.length) body.append(activityNode(acts));
      const foot = el('div', { class: 'msg-foot' });
      const bits = [];
      if (m.meta && m.meta.model) bits.push(m.meta.model);
      if (m.meta && m.meta.ms) bits.push('用时 ' + fmtDur(m.meta.ms));
      if (bits.length) foot.append(el('span', { text: bits.join(' · ') }));
      if (m.meta && m.meta.modelWanted) {
        foot.append(el('span', { class: 'warn-text', text: '设置的是 ' + m.meta.modelWanted + '，这次没有用上' }));
      }
      foot.append(el('button', { class: 'link', type: 'button', text: '复制', onclick: function (e) { copyText(m.text, e.currentTarget); } }));
      body.append(foot);
    }
    node.append(body);
    return node;
  }

  // 很长的回复先折叠，免得把别人的发言顶得看不见。
  function clampIfLong(node) {
    const bubble = node.querySelector && node.querySelector('.bubble');
    const foot = node.querySelector && node.querySelector('.msg-foot');
    if (!bubble || !foot || bubble.scrollHeight < 640) return;
    bubble.classList.add('clamp');
    const btn = el('button', { class: 'link', type: 'button', text: '展开全文' });
    btn.addEventListener('click', function () {
      const on = bubble.classList.toggle('clamp');
      btn.textContent = on ? '展开全文' : '收起';
    });
    foot.prepend(btn);
  }

  function welcomeNode() {
    const lead = nameOf(S.settings.roles.lead);
    const adv = nameOf(S.settings.roles.advisor);
    const eng = nameOf(S.settings.roles.engineer);
    const how = [
      ['直接说话，或者 @ 点名', '不点名时由主控 ' + lead + ' 回应；@ 谁谁来答；同时 @ 多位，他们各答各的、这一轮互相看不到对方。'],
      ['AI 之间会自己接力', '他们在回复里互相 @ 就能直接对话，不用你来回转述。没有人再 @ 时自然停下等你，你也可以随时点"停止"。'],
      ['要按步骤来，就用下面的流程按钮', '各出一份方案 → 设计评审 → 派活 → 代码审查。每一步谁说话由程序安排，最后都停下来等你拍板。出方案之前，主控会先用几道选择题把你的需求问清楚。'],
    ];
    const tries = [
      { text: '@所有人 各用两三句话说说：三个 AI 在同一个群里协作，你最适合负责什么？' },
      { text: '@' + eng + ' 出一道逻辑题（先别给答案），然后 @' + adv + ' 来解，最后由 ' + eng + ' 判对错' },
      { text: '我想做一个记录每天喝水量的小工具，手机上用', flow: 'plan' },
    ];
    const box = el('div', { class: 'welcome' },
      el('h2', { text: '三个 AI，一个群' }),
      el('p', { text: '你说需求，他们直接互相讨论、分工，最后由你拍板。' }));
    const grid = el('div', { class: 'how' });
    how.forEach(function (h, i) {
      grid.append(el('div', { class: 'how-item' },
        el('div', { class: 'how-num', text: String(i + 1) }),
        el('div', null, el('b', { text: h[0] }), el('span', { text: h[1] }))));
    });
    box.append(grid, el('div', { class: 'try-label', text: '试一试（点一下填进输入框）' }));
    const list = el('div', { class: 'tries' });
    tries.forEach(function (t) {
      const f = t.flow && S.flows.find(function (x) { return x.id === t.flow; });
      list.append(el('button', {
        type: 'button', text: (f ? f.icon + ' ' + f.name + '：' : '') + t.text,
        onclick: function () {
          pickFlow(t.flow || null);
          const input = $('input');
          input.value = t.text;
          autoGrow();
          input.focus();
        },
      }));
    });
    box.append(list);
    return box;
  }

  function removeQuick() {
    const q = $('quick');
    if (q) q.remove();
  }

  // AI 以"请拍板"收尾时，给两个快捷回复。
  function renderQuick() {
    removeQuick();
    if (!S.room || S.busy) return;
    const msgs = S.room.messages;
    const last = msgs[msgs.length - 1];
    if (!last) return;
    const next = last.kind === 'system' && last.meta && last.meta.next;
    const target = last.kind === 'system' ? msgs[msgs.length - 2] : last;
    if (!target || target.kind !== 'chat' || target.from === 'user') return;
    if (!/请(你|您)?拍板[\s。．.!！~*_`）)」』"”’]*$/.test(target.text.trim())) return;
    const box = el('div', { class: 'quick', id: 'quick' });
    if (next) {
      box.append(el('button', {
        class: 'primary', type: 'button', text: '同意，进入下一步：' + next.name,
        onclick: function () { send('同意，按这个来。', next.id); },
      }));
    } else {
      box.append(el('button', {
        class: 'primary', type: 'button', text: '同意，按这个来',
        onclick: function () { send('同意，按这个来。', null); },
      }));
    }
    box.append(el('button', {
      type: 'button', text: '我有修改意见…',
      onclick: function () {
        const input = $('input');
        input.value = '修改意见：';
        autoGrow();
        input.focus();
      },
    }));
    $('messages').append(box);
  }

  function renderMessages() {
    const box = $('messages');
    box.textContent = '';
    const msgs = S.room ? S.room.messages : [];
    if (!msgs.length) {
      box.append(welcomeNode());
      return;
    }
    msgs.forEach(function (m) {
      const n = messageNode(m);
      box.append(n);
      clampIfLong(n);
    });
    renderQuick();
  }

  function appendMessage(m) {
    const box = $('messages');
    const w = box.querySelector('.welcome');
    if (w) w.remove();
    const stick = nearBottom();
    removeQuick();
    const n = messageNode(m);
    box.append(n);
    clampIfLong(n);
    renderQuick();
    if (stick && m.meta && m.meta.ask) scrollToNode(n);
    else if (stick || m.from === 'user') scrollBottom();
    else $('btnJump').hidden = false;
  }

  // ---------- 正在输入 ----------

  function typingNode(agent) {
    const node = el('article', { class: 'msg typing from-' + agent, 'data-agent': agent });
    node.append(avatar(agent));
    const body = el('div', { class: 'msg-body' });
    const head = el('div', { class: 'msg-head' },
      el('span', { class: 'msg-name', text: nameOf(agent) }),
      el('span', { class: 'tag', text: roleLabel(agent) }));
    const step = el('span', { class: 'tag flow', hidden: true });
    head.append(step);
    const partial = el('div', { class: 'md', hidden: true });
    const txt = el('span', { class: 'txt' });
    const secs = el('span', { class: 'msg-meta' });
    const status = el('div', { class: 'typing-status' },
      el('span', { class: 'dots' }, el('i'), el('i'), el('i')), txt, secs);
    body.append(head, el('div', { class: 'bubble' }, partial, status));
    node.append(body);
    node._refs = { step: step, partial: partial, txt: txt, secs: secs, last: null };
    return node;
  }

  function updateTypingNode(node, st) {
    const r = node._refs;
    r.step.hidden = !st.step;
    if (st.step) r.step.textContent = st.step;
    if (r.last !== st.partial) {
      r.last = st.partial;
      r.partial.hidden = !st.partial;
      if (st.partial) r.partial.innerHTML = window.MD.render(st.partial);
    }
    r.txt.textContent = st.status || '正在输入…';
    r.secs.textContent = fmtDur(Date.now() - st.startedAt);
  }

  function renderTyping() {
    const box = $('typing');
    const stick = nearBottom();
    Array.prototype.slice.call(box.children).forEach(function (child) {
      if (!S.typing[child.dataset.agent]) child.remove();
    });
    Object.keys(S.typing).forEach(function (a) {
      let node = box.querySelector('[data-agent="' + a + '"]');
      if (!node) {
        node = typingNode(a);
        box.append(node);
      }
      updateTypingNode(node, S.typing[a]);
    });
    if (stick) scrollBottom();
  }

  function setBusy(b) {
    S.busy = !!b;
    $('btnStop').hidden = !S.busy;
    renderQuick();
  }

  // ---------- 输入区 ----------

  function autoGrow() {
    const input = $('input');
    input.style.height = 'auto';
    input.style.height = Math.min(220, input.scrollHeight) + 'px';
  }

  function renderChips() {
    const box = $('chips');
    box.textContent = '';
    S.flows.forEach(function (f) {
      const on = S.picked === f.id;
      box.append(el('button', {
        class: 'chip' + (on ? ' on' : ''), type: 'button', title: f.desc, 'aria-pressed': on ? 'true' : 'false',
        text: f.icon + ' ' + f.name,
        onclick: function () { pickFlow(on ? null : f.id, true); },
      }));
    });
  }

  function pickFlow(id, focus) {
    S.picked = id || null;
    renderChips();
    const hint = $('flowHint');
    const input = $('input');
    const f = S.flows.find(function (x) { return x.id === S.picked; });
    hint.textContent = '';
    if (f) {
      const chain = f.steps.map(function (s) {
        const who = s.who.map(function (r) { return nameOf(S.settings.roles[r]); })
          .filter(function (v, i, arr) { return arr.indexOf(v) === i; });
        return who.join(' ∥ ') + ' ' + s.label;
      }).join(' → ');
      hint.hidden = false;
      hint.append(el('b', { text: '流程「' + f.name + '」' }), '：' + chain + ' → 等你拍板');
      input.placeholder = f.placeholder || DEFAULT_PH;
      $('btnSend').textContent = '发起';
    } else {
      hint.hidden = true;
      input.placeholder = idlePlaceholder();
      $('btnSend').textContent = '发送';
    }
    if (focus) input.focus();
  }

  async function send(textOverride, flowOverride) {
    if (!S.roomId) return;
    const input = $('input');
    const fromInput = textOverride == null;
    const text = (fromInput ? input.value : textOverride).trim();
    const flow = flowOverride === undefined ? S.picked : flowOverride;
    if (!text && !flow) return;
    const f = flow && S.flows.find(function (x) { return x.id === flow; });
    if (f && f.requireText && !text) {
      toast('先把需求写出来，再发起这个流程');
      input.focus();
      return;
    }
    try {
      await api('POST', '/api/rooms/' + S.roomId + '/messages', { text: text, flow: flow || undefined });
      if (fromInput) {
        input.value = '';
        autoGrow();
      }
      if (flow) {
        S.flowHidden = null;
        pickFlow(null);
      }
      setBusy(true);
      if (!S.live) openRoom(S.roomId); // 实时连接断了：直接重新拉一次
    } catch (e) {
      toast(e.message);
    }
  }

  // @ 点名弹层
  function mentionItems() {
    const items = S.agents
      .filter(function (a) { return S.settings.members[a].enabled; })
      .map(function (a) { return { id: a, label: nameOf(a), sub: roleLabel(a) }; });
    items.push({ id: 'all', label: '所有人', sub: '三位都答' });
    return items;
  }

  function hideMention() {
    S.mention = null;
    $('mentionPop').hidden = true;
  }

  function renderMention() {
    const pop = $('mentionPop');
    pop.textContent = '';
    S.mention.items.forEach(function (it, i) {
      const av = it.id === 'all' ? el('div', { class: 'avatar sm all', text: '全' }) : avatar(it.id, true);
      pop.append(el('button', {
        class: 'mention-item' + (i === S.mention.index ? ' on' : ''), type: 'button', role: 'option',
        'aria-selected': i === S.mention.index ? 'true' : 'false',
        onmousedown: function (e) { e.preventDefault(); applyMention(it); },
      }, av, el('span', { text: '@' + it.label }), el('small', { text: it.sub })));
    });
    pop.hidden = false;
  }

  function updateMention() {
    const input = $('input');
    const pos = input.selectionStart;
    const m = input.value.slice(0, pos).match(/(^|[^A-Za-z0-9._%+\-])[@＠]([^\s@＠]{0,10})$/);
    if (!m) return hideMention();
    const q = m[2].toLowerCase();
    const items = mentionItems().filter(function (it) {
      return !q || it.label.toLowerCase().indexOf(q) === 0 || it.id.indexOf(q) === 0 || it.sub.indexOf(q) >= 0;
    });
    if (!items.length) return hideMention();
    S.mention = { start: pos - m[2].length - 1, items: items, index: Math.min(S.mention ? S.mention.index : 0, items.length - 1) };
    renderMention();
  }

  function applyMention(item) {
    const input = $('input');
    const pos = input.selectionStart;
    const ins = '@' + item.label + ' ';
    input.value = input.value.slice(0, S.mention.start) + ins + input.value.slice(pos);
    const caret = S.mention.start + ins.length;
    input.setSelectionRange(caret, caret);
    hideMention();
    autoGrow();
    input.focus();
  }

  // ---------- 弹窗 ----------

  let modalClose = null;
  function openModal(content, onClose) {
    const m = $('modal');
    m.textContent = '';
    m.append(content);
    m.hidden = false;
    $('sidebar').classList.remove('open'); // 窄屏：弹窗出现时收起抽屉
    $('scrim').hidden = false;
    modalClose = onClose || null;
    const first = m.querySelector('input[type="text"], select, button.primary');
    if (first) first.focus();
  }
  function closeModal() {
    $('modal').hidden = true;
    $('scrim').hidden = true;
    if (modalClose) modalClose();
    modalClose = null;
  }

  function selectEl(options, value, onChange) {
    const sel = el('select');
    let found = false;
    options.forEach(function (o) {
      const op = el('option', { value: o.id, text: o.name });
      if (o.id === value) { op.selected = true; found = true; }
      sel.append(op);
    });
    if (!found && value) {
      const op = el('option', { value: value, text: value });
      op.selected = true;
      sel.append(op);
    }
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }

  const EFFORT_NAMES = { '': '默认强度', low: '强度 低', medium: '强度 中', high: '强度 高', xhigh: '强度 很高', max: '强度 最高' };

  function showSettings() {
    const s = JSON.parse(JSON.stringify(S.settings));
    const body = el('div');
    body.append(el('h3', { text: '设置与分工' }),
      el('p', { class: 'lead', text: '谁当主控、谁出第二份方案、谁写代码，都可以在这里换。改动对之后的消息生效。' }));

    body.append(el('h4', { text: '分工' }));
    Object.keys(S.roles).forEach(function (r) {
      body.append(el('div', { class: 'field' },
        el('span', { class: 'lbl', text: S.roles[r].name }),
        selectEl(S.agents.map(function (a) { return { id: a, name: nameOf(a) }; }), s.roles[r], function (v) { s.roles[r] = v; }),
        el('div', { class: 'hint', text: S.roles[r].duty })));
    });

    body.append(el('h4', { text: '成员 · 是否启用 · 模型 · 思考强度' }));
    const generic = S.options.efforts.map(function (e) { return { id: e, name: EFFORT_NAMES[e] || e }; });
    S.agents.forEach(function (a) {
      const m = s.members[a];
      const models = (a === 'claude' ? S.options.claudeModels : a === 'gemini' ? S.options.geminiModels : S.options.gptModels) || [];
      const cb = el('input', { type: 'checkbox', 'aria-label': '启用 ' + nameOf(a) });
      cb.checked = !!m.enabled;
      cb.addEventListener('change', function () { m.enabled = cb.checked; });

      // 这个模型能选哪几档强度：清单里写明了的按清单来，没写明的用通用的几档。
      const effortsFor = function (modelId) {
        const opt = models.find(function (x) { return x.id === modelId; });
        if (opt && Array.isArray(opt.efforts)) {
          const list = opt.efforts.map(function (e) {
            const id = typeof e === 'string' ? e : e.id;
            return { id: id, name: EFFORT_NAMES[id] || ('强度 ' + ((e && e.name) || id)) };
          });
          // Claude 和 GPT 可以不指定强度（交给它们各自的默认）；Antigravity 的模型必须明确选一档。
          return a === 'gemini' ? list : [generic[0]].concat(list);
        }
        return a === 'gemini' ? [generic[0]] : generic;
      };
      const effortSel = el('select', { 'aria-label': nameOf(a) + ' 的思考强度' });
      const fillEfforts = function () {
        const list = effortsFor(m.model || '');
        effortSel.textContent = '';
        if (!list.length) {
          m.effort = '';
          effortSel.append(el('option', { value: '', text: '无强度可选' }));
          effortSel.disabled = true;
          return;
        }
        effortSel.disabled = false;
        if (!list.some(function (o) { return o.id === (m.effort || ''); })) {
          // 换了模型后原来那档不支持了：有"默认"就回到默认，否则优先选"高"
          const pick = list.find(function (o) { return o.id === ''; }) || list.find(function (o) { return o.id === 'high'; }) || list[0];
          m.effort = pick.id;
        }
        list.forEach(function (o) {
          const op = el('option', { value: o.id, text: o.name });
          if (o.id === (m.effort || '')) op.selected = true;
          effortSel.append(op);
        });
      };
      effortSel.addEventListener('change', function () { m.effort = effortSel.value; });
      const modelSel = selectEl(
        models.map(function (o) { return { id: o.id, name: o.name + (o.note ? '（' + o.note + '）' : '') }; }),
        m.model || '',
        function (v) { m.model = v; fillEfforts(); });
      modelSel.setAttribute('aria-label', nameOf(a) + ' 的模型');
      fillEfforts();
      body.append(el('div', { class: 'mrow' }, avatar(a, true), el('span', { class: 'nm', text: nameOf(a) }), cb, modelSel, effortSel));
    });
    body.append(el('p', {
      class: 'lead',
      text: S.options.geminiModelsSource === 'live'
        ? 'Gemini 这一行的模型和强度由 Antigravity 实时提供，和它自己的模型选择器一致；选别家的模型也可以，这位成员在群里仍叫 Gemini。'
        : '这次没能向 Antigravity 取到最新的模型清单，Gemini 这一行显示的是上次取到的。',
    }));

    body.append(el('h4', { text: '其他' }));
    const ws = el('input', { type: 'text', spellcheck: 'false' });
    ws.value = s.workspace;
    ws.addEventListener('change', function () { s.workspace = ws.value; });
    body.append(el('div', { class: 'field' }, el('span', { class: 'lbl', text: '工作目录' }), ws,
      el('div', { class: 'hint', text: '成员读文件、以及"动手模式"下写文件的地方。想让他们看某个项目，就填那个项目文件夹的完整路径。' })));

    body.append(el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', type: 'button', text: '取消', onclick: closeModal }),
      el('button', {
        class: 'btn primary', type: 'button', text: '保存',
        onclick: async function () {
          try {
            const res = await api('POST', '/api/settings', s);
            applySettings(res.settings);
            closeModal();
            toast('已保存');
            refreshHealth(true);
          } catch (e) { toast(e.message); }
        },
      })));
    openModal(body);
  }

  function fixSteps(agent, state) {
    if (state === 'login' && agent === 'claude') {
      return {
        steps: [
          ['在访达里打开这个文件夹：', el('span', { class: 'kbd', text: S.root })],
          ['双击里面的「登录Claude.command」。'],
          ['浏览器会打开 Claude 的登录页，用你平时的账号登录并同意授权。'],
          ['回到这里，点「重新检测」。'],
        ],
        why: '为什么还要登一次：Claude 桌面应用的登录状态不对外共享；群里的 Claude 是一个独立运行的 Claude Code，需要它自己的登录。只需要做一次。',
      };
    }
    if (state === 'login' && agent === 'gemini') {
      return {
        steps: [['打开 Antigravity 应用，登录你的 Google 账号。'], ['回到这里，点「重新检测」。']],
        why: 'Gemini 这一路用的是 Antigravity 的命令行，它和 Antigravity 应用共用同一份登录。',
      };
    }
    if (state === 'error') return { steps: [['稍等一会儿，点「重新检测」。'], ['还是不行的话，打开 Antigravity 应用，看看账号和网络是否正常。']] };
    if (state === 'login' && agent === 'gpt') return { steps: [['打开 ChatGPT 桌面应用，登录你的账号。'], ['回到这里，点「重新检测」。']] };
    if (state === 'missing' && agent === 'gemini') {
      return {
        steps: [
          ['打开"终端"（Terminal）应用。'],
          ['粘贴下面这一行，按回车：', el('span', { class: 'kbd', text: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' })],
          ['装好以后回到这里，点「重新检测」。'],
        ],
        why: 'Gemini 这一路靠 Google 官方的命令行 Antigravity CLI（agy）说话。上面是它的官方安装命令；登录沿用 Antigravity 应用里的 Google 账号。',
      };
    }
    if (state === 'missing') {
      const app = agent === 'claude' ? 'Claude 桌面应用' : 'ChatGPT 桌面应用';
      return { steps: [['安装并登录 ' + app + '。'], ['回到这里，点「重新检测」。']] };
    }
    return null;
  }

  function showMember(agent) {
    const body = el('div');
    const draw = function () {
      body.textContent = '';
      const d = healthOf(agent);
      const h = S.health[agent] || {};
      const cfg = S.settings.members[agent];
      body.append(el('h3', { text: nameOf(agent) + ' · ' + roleLabel(agent) }),
        el('p', { class: 'lead', text: S.info[agent].vendor + ' 的模型，经由本机的 ' + S.info[agent].via + ' 发言，用的是你在那个应用里登录的账号。' }));
      body.append(el('div', { class: 'status-line' }, el('span', { class: 'dot ' + d.cls }), el('b', { text: d.state === 'ok' ? '可以正常发言' : d.text })));
      if (h.detail && d.state !== 'off') body.append(el('p', { class: 'lead', text: h.detail }));
      if (d.state === 'off') body.append(el('p', { class: 'lead', text: '已在设置里停用，不会被叫到。' }));
      const fix = fixSteps(agent, d.state);
      if (fix) {
        body.append(el('h4', { text: '怎么解决' }));
        const ol = el('ol', { class: 'steps-list' });
        fix.steps.forEach(function (parts) {
          const li = el('li');
          parts.forEach(function (p) { li.append(p); });
          ol.append(li);
        });
        body.append(ol);
        if (fix.why) body.append(el('p', { class: 'lead', text: fix.why }));
      }
      body.append(el('h4', { text: '当前设置' }),
        el('p', { class: 'lead', text: '模型：' + (cfg.model || '默认') + (cfg.effort ? '　思考强度：' + cfg.effort : '') + '　（可在"设置与分工"里修改）' }));
      const recheck = el('button', {
        class: 'btn', type: 'button', text: '重新检测',
        onclick: async function () {
          recheck.disabled = true;
          recheck.textContent = '检测中…';
          await refreshHealth(true);
          draw();
        },
      });
      body.append(el('div', { class: 'modal-actions' }, recheck,
        el('button', { class: 'btn primary', type: 'button', text: '关闭', onclick: closeModal })));
    };
    draw();
    openModal(body);
  }

  function showRename() {
    if (!S.room) return;
    const input = el('input', { type: 'text', maxlength: '40' });
    input.value = S.room.title;
    const save = async function () {
      const title = input.value.trim();
      if (!title) return;
      try {
        await api('PATCH', '/api/rooms/' + S.roomId, { title: title });
        closeModal();
      } catch (e) { toast(e.message); }
    };
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) save();
    });
    openModal(el('div', null, el('h3', { text: '给这个群改个名字' }), el('p', { class: 'lead', text: '成员们也会在各自的应用里看到这个名字。' }), input,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', type: 'button', text: '取消', onclick: closeModal }),
        el('button', { class: 'btn primary', type: 'button', text: '保存', onclick: save }))));
    input.select();
  }

  function showDelete() {
    if (!S.room) return;
    openModal(el('div', null,
      el('h3', { text: '删除「' + S.room.title + '」？' }),
      el('p', { class: 'lead', text: '群聊记录会从列表里消失。文件会被移到 data/trash 文件夹，需要时还能找回。' }),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', type: 'button', text: '取消', onclick: closeModal }),
        el('button', {
          class: 'btn danger', type: 'button', text: '删除',
          onclick: async function () {
            try {
              await api('DELETE', '/api/rooms/' + S.roomId);
              closeModal();
              await loadState();
              if (S.rooms.length) await openRoom(S.rooms[0].id);
              else await newRoom();
            } catch (e) { toast(e.message); }
          },
        }))));
  }

  function confirmWorkMode() {
    openModal(el('div', null,
      el('h3', { text: '切换到「动手模式」？' }),
      el('p', { class: 'lead', text: '切换后，Claude 和 GPT 可以在工作目录里创建、修改文件；Gemini 仍然只参与讨论。' }),
      el('div', { class: 'field' }, el('span', { class: 'lbl', text: '工作目录' }), el('span', { class: 'kbd', text: S.settings.workspace })),
      el('p', { class: 'lead', text: '他们不会被允许改动这个目录以外的东西。想换目录，先到"设置与分工"里改。' }),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', type: 'button', text: '保持讨论模式', onclick: closeModal }),
        el('button', {
          class: 'btn primary', type: 'button', text: '切换到动手模式',
          onclick: function () { closeModal(); setMode('work'); },
        }))));
  }

  async function setMode(mode) {
    try {
      await api('PATCH', '/api/rooms/' + S.roomId, { mode: mode });
    } catch (e) { toast(e.message); }
  }

  // ---------- 数据 ----------

  function applySettings(settings) {
    S.settings = settings;
    renderMembers();
    renderHeader();
    pickFlow(S.picked);
    if (S.room) {
      const stick = nearBottom();
      renderMessages();
      if (stick) scrollBottom();
    }
  }

  async function loadState(recheck) {
    const d = await api('GET', '/api/state' + (recheck ? '?recheck=1' : ''));
    S.agents = d.agents;
    S.info = d.info;
    S.roles = d.roles;
    S.settings = d.settings;
    S.options = d.options;
    S.flows = d.flows;
    S.rooms = d.rooms;
    S.health = d.health || {};
    S.root = d.root;
    renderRooms();
    renderMembers();
    renderChips();
  }

  async function refreshHealth(force) {
    try {
      const d = await api('GET', '/api/state' + (force ? '?recheck=1' : ''));
      S.health = d.health || {};
      S.options = d.options || S.options; // 模型清单也跟着更新（Antigravity 那边会增减模型）
      renderMembers();
    } catch (e) { /* 服务暂时连不上，下次再试 */ }
  }

  // 用鼠标的设备上（电脑），把光标放进输入框，可以直接打字；触屏设备上不这么做，免得一进来就弹出键盘。
  function focusInput() {
    if (!$('modal').hidden || !window.matchMedia('(pointer: fine)').matches) return;
    $('input').focus();
  }

  async function openRoom(id) {
    let d;
    try {
      d = await api('GET', '/api/rooms/' + id);
    } catch (e) {
      toast(e.message);
      return;
    }
    S.roomId = id;
    S.room = d.room;
    S.typing = d.room.typing || {};
    S.flow = d.room.flow;
    if (location.hash !== '#/r/' + id) history.replaceState(null, '', '#/r/' + id);
    renderRooms();
    renderHeader();
    renderFlow();
    if (!S.picked) $('input').placeholder = idlePlaceholder();
    renderMessages();
    renderTyping();
    setBusy(d.room.busy);
    const pending = $('messages').querySelector('.ask.live');
    if (pending) scrollToNode(pending.closest('.msg')); // 有提问在等你：从那张卡片的开头看起
    else if (d.room.messages.length) scrollBottom();
    else $('stream').scrollTop = 0; // 新群：从欢迎说明的开头看起
    $('sidebar').classList.remove('open');
    if ($('modal').hidden) $('scrim').hidden = true;
  }

  async function newRoom() {
    try {
      const d = await api('POST', '/api/rooms', {});
      await loadState();
      await openRoom(d.room.id);
      $('input').focus();
    } catch (e) { toast(e.message); }
  }

  // ---------- 实时事件 ----------

  function onEvent(ev) {
    const mine = ev.roomId && ev.roomId === S.roomId;
    switch (ev.type) {
      case 'message':
        if (!mine || !S.room) break;
        if (S.room.messages.some(function (m) { return m.id === ev.message.id; })) break;
        S.room.messages.push(ev.message);
        appendMessage(ev.message);
        if (ev.message.meta && ev.message.meta.answer) refreshAsks(); // 来了一条回答：对应的卡片改成"已回答"
        break;
      case 'typing':
        if (!mine) break;
        if (ev.state) S.typing[ev.agent] = ev.state;
        else delete S.typing[ev.agent];
        renderTyping();
        if (ev.state && !S.busy) setBusy(true);
        break;
      case 'flow':
        if (!mine) break;
        S.flow = ev.flow;
        renderFlow();
        refreshAsks();
        break;
      case 'idle':
        if (mine) setBusy(false);
        break;
      case 'rooms': {
        S.rooms = ev.rooms;
        renderRooms();
        const cur = ev.rooms.find(function (r) { return r.id === S.roomId; });
        if (cur && cur.busy !== S.busy) setBusy(cur.busy);
        break;
      }
      case 'room':
        if (mine && S.room) {
          S.room.title = ev.title;
          S.room.mode = ev.mode;
          renderHeader();
        }
        break;
      case 'settings':
        applySettings(ev.settings);
        break;
      default:
        break;
    }
  }

  function connect() {
    const es = new EventSource('/api/events');
    let dropped = false;
    es.onopen = function () {
      S.live = true;
      if (dropped) {
        dropped = false;
        loadState().then(function () { if (S.roomId) openRoom(S.roomId); }).catch(function () {});
      }
    };
    es.onmessage = function (e) {
      let ev;
      try { ev = JSON.parse(e.data); } catch (err) { return; }
      onEvent(ev);
    };
    es.onerror = function () {
      S.live = false;
      dropped = true;
    };
  }

  // ---------- 绑定 ----------

  function bind() {
    const input = $('input');
    input.placeholder = DEFAULT_PH;
    input.addEventListener('input', function () { autoGrow(); updateMention(); });
    input.addEventListener('click', updateMention);
    input.addEventListener('blur', function () { setTimeout(hideMention, 120); });
    input.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return; // 输入法还在选字
      if (S.mention) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const n = S.mention.items.length;
          S.mention.index = (S.mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
          renderMention();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          applyMention(S.mention.items[S.mention.index]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideMention();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    $('btnSend').addEventListener('click', function () { send(); });
    $('btnStop').addEventListener('click', async function () {
      try { await api('POST', '/api/rooms/' + S.roomId + '/stop'); } catch (e) { toast(e.message); }
    });
    $('btnNewRoom').addEventListener('click', newRoom);
    $('btnSettings').addEventListener('click', showSettings);
    $('roomTitle').addEventListener('click', showRename);
    $('btnDeleteRoom').addEventListener('click', showDelete);
    $('btnJump').addEventListener('click', scrollBottom);
    $('stream').addEventListener('scroll', function () { if (nearBottom()) $('btnJump').hidden = true; });
    $('modeSeg').addEventListener('click', function (e) {
      const b = e.target.closest('button');
      if (!b || !S.room || b.dataset.mode === S.room.mode) return;
      if (b.dataset.mode === 'work') confirmWorkMode();
      else setMode('discuss');
    });
    $('btnMenu').addEventListener('click', function () {
      $('sidebar').classList.add('open');
      $('scrim').hidden = false;
    });
    $('scrim').addEventListener('click', function () {
      if (!$('modal').hidden) closeModal();
      $('sidebar').classList.remove('open');
      $('scrim').hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('modal').hidden) closeModal();
    });
    window.addEventListener('hashchange', function () {
      const m = location.hash.match(/^#\/r\/([\w-]+)/);
      if (m && m[1] !== S.roomId && S.rooms.some(function (r) { return r.id === m[1]; })) openRoom(m[1]);
    });
    // 软件窗口里只显示群聊本身：回复里的外部链接交给系统默认的浏览器去开。
    if (NATIVE) {
      document.addEventListener('click', function (e) {
        const a = e.target.closest ? e.target.closest('a[href]') : null;
        if (!a || !/^https?:$/.test(a.protocol) || a.origin === location.origin) return;
        e.preventDefault();
        NATIVE.postMessage({ type: 'open', url: a.href });
      });
    }
    $('composerFoot').append(
      el('b', { text: 'Enter' }), ' 发送 · ', el('b', { text: 'Shift+Enter' }), ' 换行 · 同时 @ 多位：各答各的 · 写"先…然后…"：按顺序答');
  }

  async function init() {
    bind();
    try {
      await loadState();
    } catch (e) {
      $('messages').append(el('div', { class: 'note err' }, el('div', { class: 'note-inner', text: '连不上群聊服务：' + e.message })));
      return;
    }
    const m = location.hash.match(/^#\/r\/([\w-]+)/);
    let id = m && S.rooms.some(function (r) { return r.id === m[1]; }) ? m[1] : (S.rooms[0] && S.rooms[0].id);
    if (!id) {
      const d = await api('POST', '/api/rooms', {});
      id = d.room.id;
      await loadState();
    }
    await openRoom(id);
    focusInput();
    connect();
    setInterval(function () { if (Object.keys(S.typing).length) renderTyping(); }, 1000);
    setInterval(function () { refreshHealth(false); }, 60000);
  }

  init();
})();
