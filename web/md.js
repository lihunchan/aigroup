// 一个很小的 Markdown 渲染器：先把所有文字转义，再只生成白名单里的标签。
// AI 的回复不可信，所以不直接插入任何原始 HTML。
(function (global) {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const MENTION_RE = /(^|[^A-Za-z0-9._%+\-])[@＠](Claude|Gemini|GPT|Codex|ChatGPT|所有人|主控|军师|工程师)/gi;

  function inline(src) {
    const codes = [];
    let s = String(src).replace(/`([^`\n]+)`/g, function (_, c) {
      codes.push(c);
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = esc(s);
    // [文字](链接)：只放行 http/https/mailto，其余（例如 file://）只留文字
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, t, u) {
      const url = u.replace(/&amp;/g, '&');
      if (/^(https?:\/\/|mailto:)/i.test(url)) {
        return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
      }
      return t;
    });
    // 裸链接
    s = s.replace(/(^|[\s(（：:，,。；;])(https?:\/\/[^\s<>"'）)，。；]+)/g, function (m, p, u) {
      return p + '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    s = s.replace(MENTION_RE, '$1<span class="mention">@$2</span>');
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) {
      return '<code>' + esc(codes[+i]) + '</code>';
    });
    return s;
  }

  const LIST_RE = /^(\s*)([-*+•]|\d{1,3}[.)、])\s+(.*)$/;
  const FENCE_RE = /^\s*(```+|~~~+)/;
  const HEAD_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
  const QUOTE_RE = /^\s{0,3}>/;

  function width(ws) {
    return ws.replace(/\t/g, '    ').length;
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line || '');
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
    return s.replace(/\\\|/g, '\u0001').split('|').map(function (c) {
      return c.replace(/\u0001/g, '|').trim();
    });
  }

  function codeBlock(lines, i) {
    const open = lines[i].match(FENCE_RE)[1];
    const lang = lines[i].replace(FENCE_RE, '').trim().split(/\s+/)[0] || '';
    const closeRe = new RegExp('^\\s*' + open.charAt(0) + '{' + open.length + ',}\\s*$');
    const buf = [];
    i++;
    while (i < lines.length && !closeRe.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    // 去掉整体缩进（列表里的代码块）
    let min = Infinity;
    buf.forEach(function (l) {
      if (l.trim()) min = Math.min(min, l.match(/^\s*/)[0].length);
    });
    if (min === Infinity) min = 0;
    const body = buf.map(function (l) { return l.slice(min); }).join('\n');
    const html = '<pre class="code"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '><code>' + esc(body) + '</code></pre>';
    return { html: html, next: i + 1 };
  }

  function parseList(lines, i, indent) {
    const first = lines[i].match(LIST_RE);
    const ordered = /\d/.test(first[2]);
    const startNum = ordered ? parseInt(first[2], 10) : 1;
    const items = [];

    while (i < lines.length) {
      const m = lines[i].match(LIST_RE);
      if (!m) break;
      const ind = width(m[1]);
      if (ind < indent) break;
      if (ind > indent + 1) {
        if (!items.length) break;
        const sub = parseList(lines, i, ind);
        items[items.length - 1].parts.push(sub.html);
        i = sub.next;
        continue;
      }
      if (/\d/.test(m[2]) !== ordered) break; // 有序/无序切换，算新的列表

      const item = { parts: [], text: [m[3]] };
      items.push(item);
      i++;
      const flush = function () {
        if (item.text.length) {
          item.parts.push(item.text.map(inline).join('<br>'));
          item.text = [];
        }
      };
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          // 空行之后如果还是列表项，或是缩进的续行，列表继续
          if (j < lines.length && (LIST_RE.test(lines[j]) || width(lines[j].match(/^\s*/)[0]) > indent + 1)) {
            i = j;
            if (LIST_RE.test(lines[j])) break;
            item.text.push('');
            continue;
          }
          break;
        }
        if (LIST_RE.test(l)) break;
        const lead = width(l.match(/^\s*/)[0]);
        if (FENCE_RE.test(l)) {
          if (lead <= indent) break;
          flush();
          const cb = codeBlock(lines, i);
          item.parts.push(cb.html);
          i = cb.next;
          continue;
        }
        if ((HEAD_RE.test(l) || QUOTE_RE.test(l) || HR_RE.test(l)) && lead <= indent) break;
        item.text.push(l.trim());
        i++;
      }
      flush();
    }

    const tag = ordered ? 'ol' : 'ul';
    const html = '<' + tag + (ordered && startNum !== 1 ? ' start="' + startNum + '"' : '') + '>' +
      items.map(function (it) { return '<li>' + it.parts.join('') + '</li>'; }).join('') + '</' + tag + '>';
    return { html: html, next: i };
  }

  function startsBlock(line, next) {
    return FENCE_RE.test(line) || HEAD_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) ||
      LIST_RE.test(line) || (line.indexOf('|') >= 0 && isTableSep(next));
  }

  function render(text) {
    const lines = String(text == null ? '' : text).replace(/\u0000|\u0001/g, '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      if (FENCE_RE.test(line)) {
        const cb = codeBlock(lines, i);
        out.push(cb.html);
        i = cb.next;
        continue;
      }

      const h = line.match(HEAD_RE);
      if (h) {
        const lv = Math.min(6, h[1].length);
        out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>');
        i++;
        continue;
      }

      if (HR_RE.test(line)) { out.push('<hr>'); i++; continue; }

      if (line.indexOf('|') >= 0 && isTableSep(lines[i + 1])) {
        const head = splitRow(line);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push('<div class="table-wrap"><table><thead><tr>' +
          head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) {
            let cells = '';
            for (let k = 0; k < head.length; k++) cells += '<td>' + inline(r[k] == null ? '' : r[k]) + '</td>';
            return '<tr>' + cells + '</tr>';
          }).join('') + '</tbody></table></div>');
        continue;
      }

      if (QUOTE_RE.test(line)) {
        const buf = [];
        while (i < lines.length && QUOTE_RE.test(lines[i])) {
          buf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + render(buf.join('\n')) + '</blockquote>');
        continue;
      }

      if (LIST_RE.test(line)) {
        const r = parseList(lines, i, width(line.match(LIST_RE)[1]));
        if (r.next > i) {
          out.push(r.html);
          i = r.next;
          continue;
        }
      }

      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('\n');
  }

  global.MD = { render: render, inline: inline, esc: esc };
})(window);
