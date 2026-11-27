'use strict';
// 画「AI 群聊」的图标：浅色圆角方块上三个交叠的圆（橙 = Claude、蓝 = Gemini、绿 = GPT），
// 和群聊页面左上角的标记是同一个图形。不依赖任何绘图库：自己算每个像素，再存成 PNG。
//
//   node app/make-icon.js            生成 app/AppIcon.icns
//   node app/make-icon.js 预览.png    另外存一张 512 的预览图
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// ---------- 图形（以 1024 的画布为准；苹果的图标网格：824 的圆角方块居中，四周留 100） ----------

const C = 512;      // 中心
const HALF = 412;   // 圆角方块的半边长
const RADIUS = 185.4; // 圆角半径（苹果模板里的数）
const POWER = 5;    // 超椭圆的指数，只用来算投影的大致形状

const CIRCLES = [
  { x: 512, y: 418, r: 136, color: [201, 100, 60], alpha: 1 },     // Claude
  { x: 394, y: 606, r: 136, color: [61, 123, 234], alpha: 0.9 },   // Gemini
  { x: 630, y: 606, r: 136, color: [18, 149, 111], alpha: 0.9 },   // GPT
];
const TOP = [255, 255, 255];
const BOTTOM = [233, 231, 222];

// 到圆角方块的"归一化半径"：小于 1 在里面，等于 1 在边上。
function squircle(x, y) {
  const a = Math.abs(x - C) / HALF;
  const b = Math.abs(y - C) / HALF;
  return Math.pow(Math.pow(a, POWER) + Math.pow(b, POWER), 1 / POWER);
}

// 苹果的"连续圆角"：每个角由三段贝塞尔曲线拼成（下面这组系数是公开流传的那一套）。
// 轮廓必须和苹果的模板一致：实测 macOS 26 会检查图标的外形，对不上的（比如用超椭圆近似的）
// 会被系统缩小、再垫上一块灰色底板。
// 这里把一个角的边界预先算成一张表：离上边 v 像素处，边界离侧边多远。
const REACH = 1.528665 * RADIUS; // 圆角从离角这么远的地方开始弯
const STEP = 0.05;
const CORNER = (() => {
  const r = RADIUS;
  const segs = [
    [[1.528665, 0], [1.08849296, 0], [0.86840694, 0], [0.63149379, 0.07491139]],
    [[0.63149379, 0.07491139], [0.37282383, 0.16905956], [0.16905956, 0.37282383], [0.07491139, 0.63149379]],
    [[0.07491139, 0.63149379], [0, 0.86840694], [0, 1.08849296], [0, 1.528665]],
  ];
  const pts = [];
  for (const [p0, p1, p2, p3] of segs) {
    for (let i = 0; i <= 4000; i++) {
      const t = i / 4000, m = 1 - t;
      const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
      pts.push([(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0]) * r, (a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]) * r]);
    }
  }
  const n = Math.ceil(REACH / STEP) + 1;
  const table = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const v = i * STEP;
    while (k < pts.length - 2 && pts[k + 1][1] < v) k++;
    const [u0, v0] = pts[k], [u1, v1] = pts[k + 1];
    table[i] = v1 > v0 ? u0 + (u1 - u0) * Math.min(1, Math.max(0, (v - v0) / (v1 - v0))) : Math.min(u0, u1);
  }
  return table;
})();

// 点 (x, y) 离圆角方块的边缘大约多远：正数在里面，负数在外面。
function depth(x, y) {
  const u = HALF - Math.abs(x - C); // 离侧边多远（往里为正）
  const v = HALF - Math.abs(y - C); // 离上下边多远
  if (u < 0 || v < 0) return Math.min(u, v);
  if (u >= REACH) return v;
  if (v >= REACH) return u;
  const du = u - CORNER[Math.round(v / STEP)]; // 水平方向上离边界多远
  const dv = v - CORNER[Math.round(u / STEP)]; // 垂直方向上离边界多远
  if (du <= 0 || dv <= 0) return Math.min(du, dv);
  return (du * dv) / Math.sqrt(du * du + dv * dv);
}

function smooth(e0, e1, v) {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// 把一个颜色按透明度叠到 px 上（px 是预乘过透明度的 [r,g,b,a]，颜色 0–255，透明度 0–1）。
function over(px, color, alpha) {
  px[0] = color[0] * alpha + px[0] * (1 - alpha);
  px[1] = color[1] * alpha + px[1] * (1 - alpha);
  px[2] = color[2] * alpha + px[2] * (1 - alpha);
  px[3] = alpha + px[3] * (1 - alpha);
}

const BLACK = [0, 0, 0];

function sample(x, y, px) {
  px[0] = px[1] = px[2] = px[3] = 0;
  // 方块下面的一圈柔和投影（下移 10，边缘虚化）
  const d = (squircle(x, y - 10) - 1) * HALF; // 离下移后的边缘大约多少像素，负数在里面
  const shadow = 0.3 * (1 - smooth(-10, 10, d));
  if (shadow > 0.001) over(px, BLACK, shadow);

  const edge = depth(x, y);
  if (edge < 0) return;
  const t = (y - (C - HALF)) / (2 * HALF);
  over(px, [
    TOP[0] + (BOTTOM[0] - TOP[0]) * t,
    TOP[1] + (BOTTOM[1] - TOP[1]) * t,
    TOP[2] + (BOTTOM[2] - TOP[2]) * t,
  ], 1);
  // 贴边一圈很淡的描边：浅色图标放在浅色背景上也有轮廓
  if (edge < 2.5) over(px, BLACK, 0.1 * (1 - edge / 2.5));

  for (const c of CIRCLES) {
    const dx = x - c.x;
    const dy = y - c.y;
    if (dx * dx + dy * dy <= c.r * c.r) over(px, c.color, c.alpha);
  }
}

// ---------- 画成 n×n 的图 ----------

function render(n) {
  const ss = n >= 256 ? 4 : 8; // 每个像素取 ss×ss 个点求平均（抗锯齿）；小图取得更密
  const scale = 1024 / n;
  const out = Buffer.alloc(n * n * 4);
  const px = [0, 0, 0, 0];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let v = 0; v < ss; v++) {
        for (let u = 0; u < ss; u++) {
          sample((i + (u + 0.5) / ss) * scale, (j + (v + 0.5) / ss) * scale, px);
          r += px[0]; g += px[1]; b += px[2]; a += px[3];
        }
      }
      const k = ss * ss;
      a /= k;
      const o = (j * n + i) * 4;
      if (a > 0) { // 存的时候把预乘还原回去
        out[o] = Math.round(Math.min(255, r / k / a));
        out[o + 1] = Math.round(Math.min(255, g / k / a));
        out[o + 2] = Math.round(Math.min(255, b / k / a));
      }
      out[o + 3] = Math.round(a * 255);
    }
  }
  return out;
}

// ---------- 存成 PNG ----------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(n, rgba) {
  const row = n * 4 + 1;
  const raw = Buffer.alloc(row * n);
  for (let y = 0; y < n; y++) rgba.copy(raw, y * row + 1, y * n * 4, (y + 1) * n * 4);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(n, 0);
  head.writeUInt32BE(n, 4);
  head[8] = 8;  // 每个通道 8 位
  head[9] = 6;  // 红绿蓝 + 透明度
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 合成 .icns ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigroup-icon-'));
const set = path.join(tmp, 'AppIcon.iconset');
fs.mkdirSync(set);
const cache = new Map();
const image = (n) => {
  if (!cache.has(n)) cache.set(n, png(n, render(n)));
  return cache.get(n);
};
for (const base of [16, 32, 128, 256, 512]) {
  fs.writeFileSync(path.join(set, `icon_${base}x${base}.png`), image(base));
  fs.writeFileSync(path.join(set, `icon_${base}x${base}@2x.png`), image(base * 2));
}
const out = path.join(__dirname, 'AppIcon.icns');
execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', out, set]);
if (process.argv[2]) fs.writeFileSync(path.resolve(process.argv[2]), image(512));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('图标已生成：' + out);
