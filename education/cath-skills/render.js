#!/usr/bin/env node
'use strict';
/*
 * Renders the cath-skills teaching video.
 *
 *   node render.js --still <seconds> <out.png>     one frame (for review)
 *   node render.js --range <f0> <f1> <out.mp4>     frames [f0, f1) as a video segment
 *   node render.js --all [workers]                 whole video + narration -> build/*.mp4
 *   node render.js --mux                           re-mux existing segments with narration/captions
 *
 * Every scene is a pure function of time; beat start times come from
 * build/timings.json (written by tts.py), so visuals land on the words.
 */
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const W = 1920, H = 1080, FPS = 30;
const HERE = __dirname, BUILD = path.join(HERE, 'build');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const OUT_NAME = 'cath-skills-pharmacoinvasive-pci-lad.mp4';

const FONT_DIR = path.join(HERE, 'node_modules/@fontsource/inter/files');
for (const w of [400, 500, 600, 700, 800]) {
  GlobalFonts.registerFromPath(path.join(FONT_DIR, `inter-latin-${w}-normal.woff2`), 'Inter');
}
const SANS = 'Inter, "DejaVu Sans"';

const C = {
  bg: '#070B16', bgMid: '#111A33', panel: '#111a30', panel2: '#17213d', line: '#26345a',
  text: '#EAF0FF', muted: '#93A3C6', dim: '#56668a',
  red: '#FF5A6E', cyan: '#3DD6F5', amber: '#FFC857', green: '#3DDC97', violet: '#A898FF',
  skin: '#B98E7A', wall: '#8C3346', lumen: '#2B0B15', plaque: '#E8B85C', blood: '#9A2036',
  steel: '#D6DEE8', fluoro: '#b9bec6', vessel: '#1b202b',
};

const STEPS = [
  'THE PATIENT & INDICATION', 'PRE-CATH CHECKLIST', 'ARTERIAL ACCESS', 'DIAGNOSTIC ANGIOGRAM',
  'READING & PLANNING', 'THE PCI', 'FINISHING WELL',
];

// ───────────────────────────── math ─────────────────────────────
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a, b, p) => a + (b - a) * p;
const easeOut = p => 1 - Math.pow(1 - p, 3);
const easeIO = p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const prog = (t, t0, d = 0.6) => clamp((t - t0) / d);
const ep = (t, t0, d = 0.6) => easeOut(prog(t, t0, d));
const eio = (t, t0, d = 0.6) => easeIO(prog(t, t0, d));
const life = (t, tIn, tOut, d = 0.5) => ep(t, tIn, d) * (tOut == null ? 1 : 1 - ep(t, tOut, d));
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const bump = (x, c, h) => { const u = (x - c) / h; return Math.abs(u) >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * u)); };
const gauss = (x, m, s) => Math.exp(-((x - m) ** 2) / (2 * s * s));

function hex(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(a, b, k) {
  const A = hex(a), B = hex(b);
  return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], clamp(k)))).join(',')})`;
}
function rgba(c, a) { const [r, g, b] = hex(c); return `rgba(${r},${g},${b},${a})`; }

// ─────────────────────────── primitives ───────────────────────────
function alpha(ctx, a, fn) {
  if (a <= 0.002) return;
  ctx.save(); ctx.globalAlpha *= Math.min(1, a); fn(); ctx.restore();
}
function fadeUp(ctx, t, t0, fn, d = 0.55, dy = 16) {
  const p = ep(t, t0, d);
  if (p <= 0.002) return;
  ctx.save(); ctx.globalAlpha *= p; ctx.translate(0, (1 - p) * dy); fn(p); ctx.restore();
}
function rrect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function panel(ctx, x, y, w, h, o = {}) {
  rrect(ctx, x, y, w, h, o.r ?? 22);
  ctx.fillStyle = o.fill ?? C.panel; ctx.fill();
  if (o.stroke !== false) { ctx.lineWidth = o.lw ?? 2; ctx.strokeStyle = o.stroke ?? C.line; ctx.stroke(); }
}
function setFont(ctx, size, w = 400) { ctx.font = `${w} ${size}px ${SANS}`; }
function wrapLines(ctx, s, maxW) {
  const out = [];
  for (const para of String(s).split('\n')) {
    let cur = '';
    for (const word of para.split(' ')) {
      const test = cur ? cur + ' ' + word : word;
      if (cur && ctx.measureText(test).width > maxW) { out.push(cur); cur = word; } else cur = test;
    }
    out.push(cur);
  }
  return out;
}
/** Text; returns width (single line) or total height (when maxW wraps). */
function txt(ctx, s, x, y, o = {}) {
  const size = o.size ?? 30;
  ctx.save();
  if (o.a != null) ctx.globalAlpha *= o.a;
  setFont(ctx, size, o.w ?? 400);
  ctx.fillStyle = o.color ?? C.text;
  ctx.textAlign = o.align ?? 'left';
  ctx.textBaseline = o.base ?? 'alphabetic';
  if (o.spacing) { try { ctx.letterSpacing = `${o.spacing}px`; } catch (e) { /* optional */ } }
  let ret;
  if (o.maxW) {
    const lh = size * (o.lh ?? 1.3);
    const lines = wrapLines(ctx, s, o.maxW);
    lines.forEach((l, i) => ctx.fillText(l, x, y + i * lh));
    ret = lines.length * lh;
  } else {
    ctx.fillText(s, x, y);
    ret = ctx.measureText(s).width;
  }
  ctx.restore();
  return ret;
}
function measure(ctx, s, size, w = 400) { ctx.save(); setFont(ctx, size, w); const m = ctx.measureText(s).width; ctx.restore(); return m; }
/** Rounded label; (x, y) is left edge / vertical centre. Returns width. */
function pill(ctx, x, y, s, o = {}) {
  const size = o.size ?? 26, padX = o.padX ?? 20, h = o.h ?? size * 1.75;
  const color = o.color ?? C.cyan;
  const w = measure(ctx, s, size, o.w ?? 600) + padX * 2;
  const x0 = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
  rrect(ctx, x0, y - h / 2, w, h, h / 2);
  ctx.fillStyle = o.fill ?? rgba(color, 0.14); ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = rgba(color, o.strokeA ?? 0.7); ctx.stroke();
  txt(ctx, s, x0 + padX, y + 1, { size, w: o.w ?? 600, color: o.textColor ?? color, base: 'middle' });
  return w;
}
function pillRow(ctx, t, items, x, y, t0, stagger, o = {}) {
  let cx = x;
  const gap = o.gap ?? 16;
  const total = items.reduce((s, it) => s + measure(ctx, it, o.size ?? 26, 600) + 2 * (o.padX ?? 20) + gap, -gap);
  if (o.align === 'center') cx = x - total / 2;
  items.forEach((it, i) => {
    const w = measure(ctx, it, o.size ?? 26, 600) + 2 * (o.padX ?? 20);
    const px = cx;
    fadeUp(ctx, t, t0 + i * stagger, () => pill(ctx, px, y, it, { ...o, align: 'left', color: (o.colors && o.colors[i]) || o.color }));
    cx += w + gap;
  });
}
function checkMark(ctx, x, y, s, p, color = C.green, lw = 5) {
  if (p <= 0) return;
  const pts = [[x - s * 0.5, y], [x - s * 0.12, y + s * 0.38], [x + s * 0.55, y - s * 0.42]];
  const l1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  const l2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]);
  const L = (l1 + l2) * p;
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(...pts[0]);
  if (L <= l1) ctx.lineTo(lerp(pts[0][0], pts[1][0], L / l1), lerp(pts[0][1], pts[1][1], L / l1));
  else { ctx.lineTo(...pts[1]); const k = (L - l1) / l2; ctx.lineTo(lerp(pts[1][0], pts[2][0], k), lerp(pts[1][1], pts[2][1], k)); }
  ctx.stroke(); ctx.restore();
}
function crossMark(ctx, x, y, s, color = C.red, lw = 5) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x - s / 2, y - s / 2); ctx.lineTo(x + s / 2, y + s / 2);
  ctx.moveTo(x + s / 2, y - s / 2); ctx.lineTo(x - s / 2, y + s / 2); ctx.stroke(); ctx.restore();
}
function checkbox(ctx, x, y, p, color = C.green) {
  rrect(ctx, x - 17, y - 17, 34, 34, 8);
  ctx.fillStyle = mix(C.panel2, color, 0.25 * p); ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = mix(C.dim, color, p); ctx.stroke();
  checkMark(ctx, x + 1, y, 22, p, color, 4.5);
}
function arrow(ctx, x1, y1, x2, y2, o = {}) {
  const p = o.p ?? 1;
  if (p <= 0) return;
  const ex = lerp(x1, x2, p), ey = lerp(y1, y2, p);
  const color = o.color ?? C.muted, head = o.head ?? 14;
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = o.lw ?? 3; ctx.lineCap = 'round';
  if (o.dash) ctx.setLineDash(o.dash);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]);
  const a = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath(); ctx.moveTo(ex, ey);
  ctx.lineTo(ex - head * Math.cos(a - 0.45), ey - head * Math.sin(a - 0.45));
  ctx.lineTo(ex - head * Math.cos(a + 0.45), ey - head * Math.sin(a + 0.45));
  ctx.closePath(); ctx.fill(); ctx.restore();
}
function circle(ctx, x, y, r, fill, stroke, lw = 2) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke(); }
}
function glow(ctx, color, blur, fn) { ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur; fn(); ctx.restore(); }

/** Fill the band between two y(x) curves over [xa, xb]. */
function fillBand(ctx, xa, xb, top, bot, fill) {
  if (xb <= xa) return;
  ctx.beginPath();
  for (let x = xa; x <= xb; x += 4) ctx.lineTo(x, top(x));
  ctx.lineTo(xb, top(xb)); ctx.lineTo(xb, bot(xb));
  for (let x = xb; x >= xa; x -= 4) ctx.lineTo(x, bot(x));
  ctx.lineTo(xa, bot(xa)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
}

// Catmull-Rom sampled path
function spline(pts, per = 18, closed = false) {
  const P = closed ? [pts[pts.length - 1], ...pts, pts[0], pts[1]] : [pts[0], ...pts, pts[pts.length - 1]];
  const out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let k = 0; k < per; k++) {
      const u = k / per, u2 = u * u, u3 = u2 * u;
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * u + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * u + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3),
      ]);
    }
  }
  out.push(closed ? out[0] : pts[pts.length - 1]);
  return out;
}
function cumLen(sp) { const L = [0]; for (let i = 1; i < sp.length; i++) L.push(L[i - 1] + Math.hypot(sp[i][0] - sp[i - 1][0], sp[i][1] - sp[i - 1][1])); return L; }
function pointAt(sp, L, d) {
  if (d <= 0) return sp[0];
  for (let i = 1; i < sp.length; i++) if (L[i] >= d) { const k = (d - L[i - 1]) / (L[i] - L[i - 1] || 1); return [lerp(sp[i - 1][0], sp[i][0], k), lerp(sp[i - 1][1], sp[i][1], k)]; }
  return sp[sp.length - 1];
}
/** Stroke a sampled path up to fraction p, with per-point width and normal offset. */
function tube(ctx, sp, o = {}) {
  const L = o.L ?? cumLen(sp), total = L[L.length - 1], maxL = (o.p ?? 1) * total, n = sp.length - 1;
  if (maxL <= 0) return;
  const wf = o.wfn ?? (f => lerp(o.w0 ?? 10, o.w1 ?? (o.w0 ?? 10), f));
  const of = o.ofn;
  ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = o.color ?? C.vessel;
  const pt = (i) => {
    if (!of) return sp[i];
    const a = sp[Math.max(0, i - 1)], b = sp[Math.min(n, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1, off = of(L[i] / total);
    return [sp[i][0] - (dy / m) * off, sp[i][1] + (dx / m) * off];
  };
  for (let i = 1; i <= n; i++) {
    if (L[i - 1] >= maxL) break;
    let b = pt(i);
    const a = pt(i - 1);
    if (L[i] > maxL) { const k = (maxL - L[i - 1]) / (L[i] - L[i - 1]); b = [lerp(a[0], b[0], k), lerp(a[1], b[1], k)]; }
    ctx.lineWidth = wf(L[i] / total);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  }
  ctx.restore();
}
function strokePath(ctx, sp, p = 1, L) {
  L = L ?? cumLen(sp);
  const maxL = p * L[L.length - 1];
  ctx.beginPath(); ctx.moveTo(sp[0][0], sp[0][1]);
  for (let i = 1; i < sp.length; i++) {
    if (L[i] > maxL) { const k = (maxL - L[i - 1]) / (L[i] - L[i - 1] || 1); ctx.lineTo(lerp(sp[i - 1][0], sp[i][0], k), lerp(sp[i - 1][1], sp[i][1], k)); break; }
    ctx.lineTo(sp[i][0], sp[i][1]);
  }
  ctx.stroke();
}

// ─────────────────────────── background ───────────────────────────
let BG = null;
function background() {
  if (BG) return BG;
  BG = createCanvas(W, H);
  const g = BG.getContext('2d');
  const grad = g.createRadialGradient(W * 0.5, H * 0.42, 50, W * 0.5, H * 0.5, W * 0.75);
  grad.addColorStop(0, C.bgMid); grad.addColorStop(1, C.bg);
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(140,170,255,0.035)'; g.lineWidth = 1;
  for (let x = 0; x <= W; x += 64) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke(); }
  for (let y = 0; y <= H; y += 64) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(W, y + 0.5); g.stroke(); }
  return BG;
}
let NOISE = null;
function noise() {
  if (NOISE) return NOISE;
  NOISE = createCanvas(640, 480);
  const g = NOISE.getContext('2d');
  const img = g.createImageData(640, 480);
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (rnd() - 0.5) * 120;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 26;
  }
  g.putImageData(img, 0, 0);
  return NOISE;
}

// ─────────────────────────── chrome ───────────────────────────
function header(ctx, step, a) {
  alpha(ctx, a, () => {
    if (step >= 1 && step <= 7) {
      pill(ctx, 80, 74, `STEP ${step}  ·  ${STEPS[step - 1]}`, { size: 24, color: C.amber, h: 48, padX: 22 });
    } else if (step === 8) {
      pill(ctx, 80, 74, 'BUILDING YOUR SKILLS', { size: 24, color: C.green, h: 48, padX: 22 });
    }
    txt(ctx, 'CATH LAB SKILLS', W - 80, 82, { size: 22, w: 700, color: C.dim, align: 'right', spacing: 3 });
  });
}
function footer(ctx, step, T, total) {
  const x0 = 80, x1 = W - 80, y = 1036, gap = 10, n = 7;
  const w = (x1 - x0 - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const done = step === 9 || (step >= 1 && i + 1 < step) || step === 8;
    const cur = step === i + 1;
    rrect(ctx, x0 + i * (w + gap), y - 3, w, 6, 3);
    ctx.fillStyle = cur ? C.amber : done ? rgba(C.amber, 0.45) : 'rgba(140,160,210,0.16)';
    ctx.fill();
  }
  rrect(ctx, x0, y + 14, (x1 - x0) * clamp(T / total), 2, 1);
  ctx.fillStyle = 'rgba(200,215,255,0.35)'; ctx.fill();
}

// ═════════════════════════════ SCENES ═════════════════════════════
const SCENES = {};

// ─── title ───
function heartArt(ctx, cx, cy, s, t) {
  const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2 * 1.1)), 12);
  ctx.save(); ctx.translate(cx, cy); ctx.scale(s * (1 + 0.012 * beat), s * (1 + 0.012 * beat));
  const P = (pts) => spline(pts, 16);
  alpha(ctx, ep(t, 0.1, 1.2), () => {
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#2a3558'; ctx.lineWidth = 46; strokePath(ctx, P([[-40, -160], [-48, -250], [0, -318], [85, -330], [145, -292], [158, -215]]));
    ctx.strokeStyle = '#22305a'; ctx.lineWidth = 36; strokePath(ctx, P([[25, -150], [65, -225], [130, -250]]));
    const body = spline([[-150, -120], [-40, -172], [90, -165], [175, -80], [210, 40], [185, 170], [120, 252], [20, 228], [-110, 172], [-200, 70], [-215, -40]], 16, true);
    ctx.beginPath(); body.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath();
    const g = ctx.createLinearGradient(-200, -170, 200, 250); g.addColorStop(0, '#3b1726'); g.addColorStop(1, '#1d0c17');
    ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#6d2c40'; ctx.stroke();
  });
  const vessels = [
    { pts: [[-70, -150], [-150, -112], [-200, -10], [-200, 100], [-150, 190], [-60, 228]], w: [11, 6], d: 0.2 },
    { pts: [[-5, -150], [25, -125], [55, -40], [90, 60], [120, 160], [126, 246], [100, 278]], w: [12, 5], d: 0.0 },
    { pts: [[25, -125], [100, -142], [170, -92], [206, 0]], w: [10, 6], d: 0.5 },
    { pts: [[50, -50], [120, -40], [182, 2]], w: [6, 3], d: 0.9 },
    { pts: [[86, 50], [150, 72], [196, 112]], w: [6, 3], d: 1.2 },
  ];
  glow(ctx, rgba(C.red, 0.8), 18, () => {
    for (const v of vessels) tube(ctx, P(v.pts), { w0: v.w[0], w1: v.w[1], color: C.red, p: ep(t, 0.6 + v.d, 2.4) });
  });
  ctx.restore();
}
SCENES.title = (ctx, S) => {
  const { t } = S;
  heartArt(ctx, 1400, 590, 1.3, t);
  fadeUp(ctx, t, 0.3, () => txt(ctx, 'CATH LAB SKILLS', 140, 330, { size: 30, w: 700, color: C.amber, spacing: 6 }));
  fadeUp(ctx, t, 0.7, () => {
    txt(ctx, 'One real case,', 134, 440, { size: 94, w: 800 });
    txt(ctx, 'step by step.', 134, 546, { size: 94, w: 800, color: C.cyan });
  });
  fadeUp(ctx, t, S.B('t2'), () => {
    txt(ctx, 'Pharmaco-invasive PCI to the LAD', 140, 646, { size: 42, w: 600 });
    txt(ctx, 'approach  ·  angiogram  ·  hardware  ·  complications', 140, 700, { size: 28, color: C.muted });
  });
  pillRow(ctx, t, ['De-identified case', 'Educational only', 'Learn under supervision'], 140, 800, S.B('t3'), 0.6,
    { size: 24, colors: [C.green, C.amber, C.violet] });
};

// ─── roadmap ───
const STEP_LABELS = [['Patient &', 'indication'], ['Pre-cath', 'checklist'], ['Arterial', 'access'], ['Diagnostic', 'angiogram'], ['Reading &', 'planning'], ['The PCI', ''], ['Finishing', 'well']];
SCENES.roadmap = (ctx, S) => {
  const { t } = S;
  fadeUp(ctx, t, 0.2, () => {
    txt(ctx, 'A 7-step approach to every cath case', W / 2, 250, { size: 60, w: 800, align: 'center' });
    txt(ctx, 'Every case is a chain of decisions', W / 2, 310, { size: 30, color: C.muted, align: 'center' });
  });
  const y = 560, xs = [...Array(7)].map((_, i) => 260 + i * 233.3);
  const act = [S.at('r2', 0), S.at('r2', 0.33), S.at('r2', 0.64), S.at('r3', 0), S.at('r3', 0.45), S.at('r4', 0), S.at('r4', 0.3)];
  ctx.save(); ctx.lineCap = 'round';
  ctx.strokeStyle = C.line; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(xs[0], y); ctx.lineTo(lerp(xs[0], xs[6], ep(t, 0.6, 1.8)), y); ctx.stroke();
  let lastX = xs[0], any = false;
  act.forEach((a, i) => { const k = ep(t, a, 0.6); if (k > 0) { any = true; lastX = lerp(i ? xs[i - 1] : xs[0], xs[i], k); } });
  if (any) { ctx.strokeStyle = C.cyan; ctx.beginPath(); ctx.moveTo(xs[0], y); ctx.lineTo(lastX, y); ctx.stroke(); }
  ctx.restore();
  xs.forEach((x, i) => {
    const k = ep(t, act[i], 0.5);
    fadeUp(ctx, t, 0.8 + i * 0.12, () => {
      if (k > 0) glow(ctx, rgba(C.cyan, 0.7 * k), 30, () => circle(ctx, x, y, 52, mix(C.panel2, C.cyan, k)));
      circle(ctx, x, y, 52, mix(C.panel2, C.cyan, k), mix(C.line, C.cyan, k), 3);
      txt(ctx, String(i + 1), x, y + 2, { size: 44, w: 800, align: 'center', base: 'middle', color: mix(C.muted, C.bg, k) });
      STEP_LABELS[i].forEach((l, j) => txt(ctx, l, x, y + 110 + j * 38, { size: 30, w: 600, align: 'center', color: mix(C.dim, C.text, 0.35 + 0.65 * k) }));
    });
  });
  fadeUp(ctx, t, S.B('r5'), () => {
    panel(ctx, W / 2 - 430, 800, 860, 110, { fill: rgba(C.green, 0.08), stroke: rgba(C.green, 0.6) });
    ladderIcon(ctx, W / 2 - 360, 855, 0.55, C.green);
    txt(ctx, 'Then: a plan to build these skills yourself', W / 2 - 300, 866, { size: 34, w: 600, color: C.green });
  });
};
function ladderIcon(ctx, x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.strokeStyle = color; ctx.lineWidth = 7; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-28, 60); ctx.lineTo(-18, -60); ctx.moveTo(28, 60); ctx.lineTo(38, -60);
  for (let i = 0; i < 4; i++) { const yy = 40 - i * 30; ctx.moveTo(-26 + i * 2.5, yy); ctx.lineTo(30 + i * 2.5, yy); }
  ctx.stroke(); ctx.restore();
}

// ─── case ───
function ecgWave(ph, st, lead) {
  const g = (m, s, a) => a * gauss(ph, m, s);
  const r = [0.35, 0.6, 0.95, 1.1][lead], sd = [0.9, 0.75, 0.45, 0.3][lead];
  let v = g(0.12, 0.022, 0.12) + g(0.245, 0.008, -0.08) + g(0.27, 0.011, r) + g(0.297, 0.011, -sd);
  v += st * smooth(0.29, 0.33, ph) * (1 - smooth(0.52, 0.64, ph));
  v += g(0.47, 0.05, 0.22 + st * 0.35);
  return v;
}
function ecgPanel(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t, x0 = 800, y0 = 170;
    panel(ctx, x0, y0, 1040, 730, { fill: '#0c1428' });
    txt(ctx, '12-lead ECG — precordial leads', x0 + 30, y0 + 52, { size: 26, w: 600, color: C.muted });
    ctx.save(); ctx.strokeStyle = 'rgba(255,90,110,0.07)'; ctx.lineWidth = 1;
    for (let x = x0 + 20; x < x0 + 1030; x += 25) { ctx.beginPath(); ctx.moveTo(x, y0 + 80); ctx.lineTo(x, y0 + 710); ctx.stroke(); }
    for (let y = y0 + 80; y < y0 + 715; y += 25) { ctx.beginPath(); ctx.moveTo(x0 + 20, y); ctx.lineTo(x0 + 1030, y); ctx.stroke(); }
    ctx.restore();
    const tx0 = x0 + 110, tw = 890, secs = 3.0, bl = 0.8;
    const elapsed = t - S.at('c1', 0.1), sweep = elapsed * 320;
    const cursor = tx0 + (sweep % tw);
    const firstPass = sweep < tw;
    const sts = [0.28, 0.5, 0.55, 0.38];
    for (let L = 0; L < 4; L++) {
      const by = y0 + 190 + L * 150;
      txt(ctx, `V${L + 1}`, x0 + 40, by + 8, { size: 28, w: 700, color: C.muted });
      ctx.save(); ctx.strokeStyle = C.green; ctx.lineWidth = 3; ctx.lineJoin = 'round';
      const seg = (xa, xb) => {
        if (xb <= xa) return;
        ctx.beginPath();
        for (let x = xa; x <= xb; x += 2) {
          const tt = ((x - tx0) / tw) * secs, ph = (tt % bl) / bl;
          const yy = by - ecgWave(ph, sts[L], L) * 70;
          x === xa ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
        }
        ctx.stroke();
      };
      if (elapsed > 0) {
        if (firstPass) seg(tx0, cursor);
        else { seg(tx0, cursor); seg(cursor + 34, tx0 + tw); }
      }
      ctx.restore();
    }
    // ST highlight
    const hk = life(t, S.at('c2', 0.1), null);
    if (hk > 0) {
      alpha(ctx, hk, () => {
        for (let L = 0; L < 4; L++) {
          const by = y0 + 190 + L * 150;
          for (const b of [1, 2]) {
            const xa = tx0 + ((b * bl + 0.3 * bl) / secs) * tw, xb = tx0 + ((b * bl + 0.62 * bl) / secs) * tw;
            rrect(ctx, xa - 6, by - 78, xb - xa + 12, 70, 10); ctx.lineWidth = 3; ctx.strokeStyle = rgba(C.amber, 0.9); ctx.stroke();
          }
        }
        pill(ctx, x0 + 520, y0 + 690, 'ST ↑ in V1–V4  →  LAD territory', { size: 28, color: C.amber, align: 'center' });
      });
    }
  });
}
function flowNode(ctx, cx, cy, w, h, lines, color, a, o = {}) {
  alpha(ctx, a, () => {
    panel(ctx, cx - w / 2, cy - h / 2, w, h, { fill: o.fill ?? rgba(color, 0.1), stroke: rgba(color, 0.75), r: 16 });
    const size = o.size ?? 26;
    lines.forEach((l, i) => txt(ctx, l, cx, cy + (i - (lines.length - 1) / 2) * size * 1.3 + 2, { size, w: i === 0 ? 700 : 500, align: 'center', base: 'middle', color: i === 0 ? C.text : C.muted }));
  });
}
function flowChart(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t, c4 = S.B('c4'), c5 = S.B('c5'), c6 = S.B('c6');
    const X = 1110, XR = 1620;
    flowNode(ctx, X, 230, 440, 76, ['STEMI diagnosed'], C.cyan, ep(t, c4));
    arrow(ctx, X, 270, X, 318, { p: ep(t, c4 + 0.5), color: C.muted });
    flowNode(ctx, X, 370, 440, 100, ['Primary PCI possible', 'within ~120 min?'], C.cyan, ep(t, c4 + 0.8));
    arrow(ctx, X + 222, 370, XR - 160, 370, { p: ep(t, c4 + 1.4), color: C.dim });
    txt(ctx, 'yes', X + 290, 356, { size: 22, color: C.dim, a: ep(t, c4 + 1.4) });
    flowNode(ctx, XR, 370, 310, 76, ['Primary PCI'], C.dim, ep(t, c4 + 1.6) * 0.8);
    arrow(ctx, X, 422, X, 478, { p: ep(t, S.at('c4', 0.6)), color: C.muted });
    txt(ctx, 'no', X + 14, 456, { size: 22, color: C.muted, a: ep(t, S.at('c4', 0.6)) });
    flowNode(ctx, X, 525, 440, 80, ['Fibrinolysis', 'pharmaco-invasive strategy'], C.violet, ep(t, S.at('c4', 0.7)));
    arrow(ctx, X, 567, X, 620, { p: ep(t, c5), color: C.muted });
    flowNode(ctx, X, 672, 440, 100, ['At 60–90 min: ST resolution', '≥ 50% and stable?'], C.cyan, ep(t, c5 + 0.3));
    arrow(ctx, X + 222, 672, XR - 160, 672, { p: ep(t, S.at('c5', 0.3)), color: C.red, lw: 4 });
    txt(ctx, 'no', X + 256, 656, { size: 22, color: C.red, a: ep(t, S.at('c5', 0.3)) });
    flowNode(ctx, XR, 672, 310, 100, ['Rescue PCI', 'immediately'], C.red, ep(t, S.at('c5', 0.55)));
    txt(ctx, 'also for shock, arrhythmia,', XR, 750, { size: 21, color: C.red, align: 'center', a: ep(t, S.at('c5', 0.6)) });
    txt(ctx, 'ongoing ischemia', XR, 778, { size: 21, color: C.red, align: 'center', a: ep(t, S.at('c5', 0.6)) });
    arrow(ctx, X, 724, X, 778, { p: ep(t, c6), color: C.green, lw: 4 });
    txt(ctx, 'yes', X + 14, 760, { size: 22, color: C.green, a: ep(t, c6) });
    flowNode(ctx, X, 835, 520, 100, ['Angiography ± PCI of culprit', 'routinely within 2–24 h'], C.green, ep(t, c6 + 0.3));
    fadeUp(ctx, t, S.at('c6', 0.65), () => pill(ctx, X + 290, 835, '← our case', { size: 26, color: C.green }));
  });
}
SCENES.case = (ctx, S) => {
  const { t } = S;
  fadeUp(ctx, t, 0.3, () => {
    panel(ctx, 80, 170, 680, 730);
    txt(ctx, 'THE PATIENT', 116, 228, { size: 24, w: 700, color: C.amber, spacing: 3 });
  });
  const rows = [
    ['Woman, in her 60s', C.text, S.at('c1', 0.2)],
    ['Type 2 diabetes', C.text, S.at('c1', 0.35)],
    ['Acute anterior wall STEMI', C.red, S.at('c1', 0.55)],
    ['Echo: EF 47% — mild LV dysfunction', C.text, S.at('c3', 0.1)],
    ['Mild mitral regurgitation', C.text, S.at('c3', 0.6)],
    ['Thrombolysed → pharmaco-invasive', C.violet, S.at('c4', 0.1)],
    ['Plan: angiography ± PCI in 2–24 h', C.green, S.at('c6', 0.4)],
  ];
  rows.forEach(([s, col, t0], i) => fadeUp(ctx, t, t0, () => {
    circle(ctx, 124, 300 + i * 84, 9, col);
    txt(ctx, s, 150, 310 + i * 84, { size: 31, w: 600, color: col === C.text ? C.text : col });
  }));
  ecgPanel(ctx, S, life(t, S.at('c1', 0.05), S.B('c4') - 0.2));
  flowChart(ctx, S, ep(t, S.B('c4')));
};

// ─── checklist ───
SCENES.checklist = (ctx, S) => {
  const { t } = S;
  fadeUp(ctx, t, 0.3, () => {
    txt(ctx, 'Most complications are prevented', 110, 230, { size: 56, w: 800 });
    txt(ctx, 'before the needle touches the skin.', 110, 296, { size: 56, w: 800, color: C.cyan });
  });
  const cards = [
    { title: 'Consent & kidneys', color: C.cyan, beat: 'k2', items: [['Informed consent', ''], ['Renal function', 'diabetic → contrast kidney injury risk'], ['Plan hydration', 'keep contrast to a minimum']], fr: [0.05, 0.2, 0.62] },
    { title: 'Bleeding & allergy', color: C.amber, beat: 'k3', items: [['Hb · platelets · coagulation', 'especially after a lytic'], ['Contrast allergy?', ''], ['Antiplatelet & anticoagulant', 'doses + timing documented']], fr: [0.05, 0.4, 0.6] },
    { title: 'Ready to start', color: C.green, beat: 'k4', items: [['Radial pulse felt', ''], ['Bail-out kit located', ''], ['Team time-out', '']], fr: [0.05, 0.3, 0.7] },
  ];
  cards.forEach((c, ci) => {
    const x = 110 + ci * 580, y = 380, b = c.beat;
    fadeUp(ctx, t, S.B(b) - 0.2, () => {
      panel(ctx, x, y, 540, 540, { stroke: rgba(c.color, 0.55) });
      rrect(ctx, x, y, 540, 8, 4); ctx.fillStyle = c.color; ctx.fill();
      txt(ctx, c.title, x + 36, y + 72, { size: 34, w: 700, color: c.color });
      c.items.forEach(([main, sub], i) => {
        const iy = y + 160 + i * 124, k = ep(t, S.at(b, c.fr[i]) + 0.3, 0.5);
        alpha(ctx, 0.35 + 0.65 * ep(t, S.at(b, c.fr[i]), 0.4), () => {
          checkbox(ctx, x + 56, iy, k, c.color);
          txt(ctx, main, x + 96, iy + 10, { size: 30, w: 600 });
          if (sub) txt(ctx, sub, x + 96, iy + 50, { size: 24, color: C.muted });
        });
      });
    });
  });
};

// ─── access ───
function forearm(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t;
    panel(ctx, 80, 170, 800, 760, { fill: '#0d1529' });
    txt(ctx, 'Right forearm, palm up', 116, 226, { size: 26, w: 600, color: C.muted });
    // palm up: the thumb and the radial artery run along the lateral (thumb) side
    ctx.save(); rrect(ctx, 80, 170, 800, 760, 22); ctx.clip();
    ctx.save(); ctx.lineCap = 'round';
    ctx.strokeStyle = C.skin; ctx.lineWidth = 190; ctx.beginPath(); ctx.moveTo(190, 540); ctx.lineTo(600, 548); ctx.stroke();
    ctx.fillStyle = C.skin;
    ctx.beginPath(); ctx.ellipse(700, 548, 105, 118, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(722, 690, 78, 30, 0.35, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.ellipse(800, 474 + i * 46, 58, 20, 0.03, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    txt(ctx, 'thumb side', 250, 690, { size: 22, w: 600, color: C.muted });
    const pulse = 0.5 + 0.5 * Math.sin(t * 7);
    const art = spline([[190, 600], [400, 606], [560, 612], [640, 626], [690, 640]], 16);
    glow(ctx, rgba(C.red, 0.4 + 0.4 * pulse), 14, () => tube(ctx, art, { w0: 9, w1: 7, color: C.red }));
    circle(ctx, 645, 646, 16, rgba('#f3e6d6', 0.9), '#7d5a4b', 2);
    ctx.save(); ctx.strokeStyle = '#f3e6d6'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(636, 660); ctx.lineTo(575, 772); ctx.stroke(); ctx.restore();
    txt(ctx, 'radial styloid', 560, 800, { size: 24, w: 600, align: 'center', color: '#f3e6d6' });
    const k = ep(t, S.at('a3', 0.05));
    alpha(ctx, k, () => {
      const px = 560, py = 612;
      for (let r = 0; r < 3; r++) { const rr = 14 + ((t * 26 + r * 14) % 42); circle(ctx, px, py, rr, null, rgba(C.cyan, 1 - rr / 56), 3); }
      circle(ctx, px, py, 7, C.cyan);
      ctx.save(); ctx.strokeStyle = '#1c2233'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(px, 566); ctx.lineTo(px, 578); ctx.lineTo(645, 578); ctx.lineTo(645, 566); ctx.stroke(); ctx.restore();
      txt(ctx, '1–2 cm', 602, 556, { size: 24, w: 800, align: 'center', color: '#1c2233' });
      arrow(ctx, 470, 380, px - 6, py - 22, { color: C.cyan, p: 1 });
      txt(ctx, 'Puncture 1–2 cm above the radial styloid:', 116, 282, { size: 26, w: 600 });
      txt(ctx, 'the artery is superficial and easy to compress', 116, 318, { size: 26, w: 600 });
      txt(ctx, 'small amount of local anaesthetic first', 116, 356, { size: 23, color: C.muted });
    });
    ctx.restore();
  });
}
function seldinger(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t;
    const X0 = 920, Y0 = 170, PW = 920, PH = 760;
    panel(ctx, X0, Y0, PW, PH, { fill: '#0d1529' });
    txt(ctx, 'Side view: Seldinger technique', X0 + 36, Y0 + 56, { size: 26, w: 600, color: C.muted });
    ctx.save(); rrect(ctx, X0, Y0, PW, PH, 22); ctx.clip();
    const skinY = 380, cy = 600;
    ctx.fillStyle = '#2a1c26'; ctx.fillRect(X0, skinY, PW, PH);
    ctx.fillStyle = '#c99b84'; ctx.fillRect(X0, skinY, PW, 16);
    txt(ctx, 'skin', X0 + PW - 30, skinY - 12, { size: 22, color: C.muted, align: 'right' });
    // spasm narrows the artery around the sheath
    const sp = life(t, S.at('a6', 0.05), S.at('a6', 0.85), 0.8);
    const rOuter = 46, rLum = 36;
    const rAt = x => { const sq = sp * 0.34 * smooth(1420, 1520, x); return [rOuter * (1 - sq), rLum * (1 - sq)]; };
    ctx.beginPath();
    for (let x = X0; x <= X0 + PW; x += 6) ctx.lineTo(x, cy - rAt(x)[0]);
    for (let x = X0 + PW; x >= X0; x -= 6) ctx.lineTo(x, cy + rAt(x)[0]);
    ctx.closePath(); ctx.fillStyle = '#c04a5c'; ctx.fill();
    ctx.beginPath();
    for (let x = X0; x <= X0 + PW; x += 6) ctx.lineTo(x, cy - rAt(x)[1]);
    for (let x = X0 + PW; x >= X0; x -= 6) ctx.lineTo(x, cy + rAt(x)[1]);
    ctx.closePath(); ctx.fillStyle = C.blood; ctx.fill();
    ctx.strokeStyle = 'rgba(255,170,180,0.35)'; ctx.lineWidth = 3;
    for (let i = 0; i < 9; i++) {
      const x = X0 + ((t * 160 + i * 110) % (PW + 60)) - 30, yy = cy + ((i * 37) % 44) - 22;
      ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + 34, yy); ctx.stroke();
    }
    txt(ctx, 'radial artery', X0 + 30, cy + 90, { size: 22, color: C.muted });
    // geometry of the needle track
    const ang = 35 * Math.PI / 180, d = [Math.cos(ang), Math.sin(ang)];
    const E = [1180, skinY + 8];
    const tipDepth = (cy - E[1]) / d[1];
    const nIn = ep(t, S.at('a3', 0.45), Math.max(1.5, S.D('a3') * 0.35));
    const nOut = ep(t, S.at('a4', 0.42), 1.2);
    const tipL = lerp(-90, tipDepth, nIn) - nOut * 640;
    const tip = [E[0] + d[0] * tipL, E[1] + d[1] * tipL];
    const back = [tip[0] - d[0] * 520, tip[1] - d[1] * 520];
    // wire / sheath track: along the needle line, then a smooth turn into the lumen
    const along = L => [E[0] + d[0] * L, E[1] + d[1] * L];
    const bend = (startL, endX) => {
      const p0 = along((cy - 30 - E[1]) / d[1]), c = along(tipDepth);
      const pts = [along(startL), p0];
      for (let i = 1; i <= 12; i++) { const u = i / 12; pts.push([lerp(lerp(p0[0], c[0], u), lerp(c[0], c[0] + 120, u), u), lerp(lerp(p0[1], c[1], u), lerp(c[1], cy, u), u)]); }
      pts.push([endX, cy]);
      return pts;
    };
    // sheath (after the needle comes out)
    const sheathK = ep(t, S.at('a4', 0.6), 1.8);
    const sheathPath = bend(-140, 1720);
    const sheathL = cumLen(sheathPath);
    if (sheathK > 0) {
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#8193c0'; ctx.lineWidth = 24; strokePath(ctx, sheathPath, lerp(0.03, 1, sheathK), sheathL); ctx.restore();
      const h0 = sheathPath[0];
      ctx.save(); ctx.translate(h0[0], h0[1]); ctx.rotate(ang); rrect(ctx, -60, -22, 64, 44, 8); ctx.fillStyle = '#5d6f9d'; ctx.fill(); ctx.restore();
      ctx.save(); ctx.strokeStyle = '#5d6f9d'; ctx.lineWidth = 8; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(h0[0] - 20, h0[1] - 6); ctx.quadraticCurveTo(h0[0] - 14, h0[1] - 40, X0 + 152, Y0 + 92); ctx.stroke(); ctx.restore();
      txt(ctx, '6F sheath', 1240, 340, { size: 24, w: 700, color: '#b8c6ee', a: sheathK });
    }
    // wire
    const wK = ep(t, S.B('a4'), Math.max(1.2, S.D('a4') * 0.35));
    if (wK > 0) {
      ctx.save(); ctx.strokeStyle = '#e8f6ff'; ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; strokePath(ctx, bend(-230, 1820), wK); ctx.restore();
    }
    // needle
    if (nOut < 1) {
      alpha(ctx, 1 - nOut, () => {
        ctx.save(); ctx.lineCap = 'butt'; ctx.strokeStyle = C.steel; ctx.lineWidth = 8;
        ctx.beginPath(); ctx.moveTo(back[0], back[1]); ctx.lineTo(tip[0], tip[1]); ctx.stroke(); ctx.restore();
        ctx.save(); ctx.translate(back[0], back[1]); ctx.rotate(ang);
        rrect(ctx, -70, -18, 74, 36, 7);
        const flash = smooth(0.82, 0.95, nIn) * (1 - nOut);
        ctx.fillStyle = mix('#dfe6ee', '#d0243d', flash); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#8a97a8'; ctx.stroke();
        ctx.restore();
        if (smooth(0.82, 0.95, nIn) > 0.5 && nOut < 0.2) {
          pill(ctx, back[0] + 150, back[1] - 14, 'flashback', { size: 22, color: C.red, align: 'center' });
        }
      });
      // angle arc
      alpha(ctx, ep(t, S.at('a3', 0.55)) * (1 - ep(t, S.B('a4'))), () => {
        ctx.save(); ctx.strokeStyle = C.amber; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(E[0], E[1], 110, Math.PI, Math.PI + ang); ctx.stroke(); ctx.restore();
        txt(ctx, '30–45°', E[0] - 250, E[1] - 22, { size: 28, w: 700, color: C.amber });
      });
    }
    // drugs through the side port
    const dk = ep(t, S.at('a5', 0.02));
    if (dk > 0) {
      alpha(ctx, dk * (1 - ep(t, S.B('a6'), 0.5) * 0.6), () => {
        // horizontal syringe feeding the side port (tip at the right)
        const sx = X0 + 150, sy = Y0 + 92;
        const push = 50 * prog(t, S.at('a5', 0.1), S.D('a5') * 0.7);
        ctx.save();
        rrect(ctx, sx - 90, sy - 16, 80, 32, 7); ctx.fillStyle = rgba('#dfe9ff', 0.15); ctx.fill(); ctx.strokeStyle = '#dfe9ff'; ctx.lineWidth = 3; ctx.stroke();
        ctx.fillStyle = rgba(C.cyan, 0.55); ctx.fillRect(sx - 86 + push, sy - 12, 72 - push, 24);
        ctx.fillStyle = '#dfe9ff'; ctx.fillRect(sx - 10, sy - 4, 12, 8);
        ctx.fillRect(sx - 130 + push, sy - 3, 44, 6); ctx.fillRect(sx - 136 + push, sy - 16, 8, 32);
        ctx.restore();
      });
    }
    ctx.restore();
    // captions below art (inside panel)
    const lines = [
      { s: 'Needle in → flashback', b: 'a3', f: 0.5, c: C.amber },
      { s: 'Wire in gently → needle out → sheath over the wire', b: 'a4', f: 0.1, c: C.text },
      { s: 'Spasmolytic cocktail + heparin via the side port', b: 'a5', f: 0.05, c: C.cyan },
    ];
    let shown = null;
    for (const l of lines) if (t >= S.at(l.b, l.f)) shown = l;
    if (shown && t < S.B('a6')) fadeUp(ctx, t, S.at(shown.b, shown.f), () => txt(ctx, shown.s, X0 + 36, Y0 + PH - 110, { size: 28, w: 600, color: shown.c }));
    fadeUp(ctx, t, S.at('a5', 0.35), () => {
      if (t < S.B('a6')) {
        pill(ctx, X0 + 36, Y0 + PH - 50, 'Heparin 2,500 IU — diagnostic note', { size: 22, color: C.cyan });
        pill(ctx, X0 + 470, Y0 + PH - 50, 'protects against radial occlusion', { size: 22, color: C.green });
      }
    });
    fadeUp(ctx, t, S.at('a6', 0.05), () => {
      txt(ctx, 'Spasm? Stop · more vasodilator · never pull hard', X0 + 36, Y0 + PH - 110, { size: 28, w: 700, color: C.amber });
      pill(ctx, X0 + 36, Y0 + PH - 50, 'sticky catheter or forearm pain = think spasm', { size: 22, color: C.amber });
    });
  });
}
SCENES.access = (ctx, S) => {
  const { t } = S;
  const introA = 1 - ep(t, S.B('a3') - 0.1, 0.6);
  alpha(ctx, introA, () => {
    fadeUp(ctx, t, 0.4, () => {
      panel(ctx, 260, 190, 1400, 470, { fill: '#0d1529' });
      txt(ctx, 'How the note opens', 310, 254, { size: 26, w: 600, color: C.muted });
      txt(ctx, '↓SAP  ↓LA,  (R) radial artery punctured,', 310, 340, { size: 50, w: 700, color: C.amber });
      txt(ctx, 'secured using 6F sheath', 310, 404, { size: 50, w: 700, color: C.amber });
    });
    const ex = [
      ['↓SAP', 'under strict aseptic precautions', S.at('a1', 0.3)],
      ['↓LA', 'under local anaesthesia', S.at('a1', 0.48)],
      ['6F', 'six French sheath: takes 6F catheters (1 Fr = ⅓ mm)', S.at('a1', 0.7)],
    ];
    ex.forEach(([k, v, t0], i) => fadeUp(ctx, t, t0, () => {
      txt(ctx, k, 330, 490 + i * 56, { size: 32, w: 800, color: C.amber });
      txt(ctx, '=  ' + v, 470, 490 + i * 56, { size: 32, w: 500 });
    }));
    fadeUp(ctx, t, S.at('a2', 0.02), () => txt(ctx, 'Why radial?', 260, 750, { size: 40, w: 800 }));
    pillRow(ctx, t, ['Less bleeding', 'Fewer access-site complications', 'Guideline default in ACS'], 260, 830, S.at('a2', 0.2), S.D('a2') * 0.22, { size: 28, colors: [C.green, C.green, C.cyan] });
  });
  const k = ep(t, S.B('a3') + 0.2, 0.7);
  forearm(ctx, S, k);
  seldinger(ctx, S, k);
};

// ─── diagnostic ───
function bodySchematic(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t;
    panel(ctx, 80, 170, 820, 790, { fill: '#0d1529' });
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    rrect(ctx, 330, 250, 470, 690, 140); ctx.fillStyle = '#141e39'; ctx.fill();
    ctx.strokeStyle = '#141e39'; ctx.lineWidth = 110; ctx.beginPath(); ctx.moveTo(360, 320); ctx.lineTo(250, 560); ctx.lineTo(190, 760); ctx.lineTo(160, 905); ctx.stroke();
    ctx.strokeStyle = '#2d3d68'; ctx.lineWidth = 40;
    strokePath(ctx, spline([[585, 640], [583, 470], [610, 395], [690, 378], [735, 440], [738, 930]], 14));
    ctx.lineWidth = 16;
    strokePath(ctx, spline([[612, 398], [560, 340], [470, 326], [380, 330], [300, 390], [240, 560], [196, 740], [168, 900]], 14));
    ctx.restore();
    // heart
    ctx.save(); ctx.beginPath(); ctx.ellipse(640, 700, 120, 95, -0.5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,90,110,0.13)'; ctx.fill(); ctx.restore();
    ctx.save(); ctx.strokeStyle = rgba(C.red, 0.8); ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(600, 628); ctx.lineTo(650, 640); ctx.moveTo(570, 628); ctx.lineTo(530, 648); ctx.stroke(); ctx.restore();
    const labels = [['radial', 90, 850, 0.02], ['brachial', 100, 650, 0.25], ['subclavian', 330, 300, 0.55], ['ascending aorta', 640, 520, 0.85], ['coronary ostia', 680, 610, 0.97]];
    const path = spline([[165, 895], [196, 740], [240, 560], [300, 390], [380, 330], [470, 326], [560, 340], [606, 402], [590, 470], [586, 600]], 14);
    const L = cumLen(path);
    const p = ep(t, S.at('d2', 0.02), Math.max(2, S.D('d2') * 0.9));
    const p0 = ep(t, S.at('d1', 0.3), 0.8) * 0.04;
    const pp = Math.max(p0, p);
    glow(ctx, rgba(C.cyan, 0.9), 12, () => { ctx.save(); ctx.strokeStyle = C.cyan; ctx.lineWidth = 6; ctx.lineCap = 'round'; strokePath(ctx, path, pp, L); ctx.restore(); });
    const tipPt = pointAt(path, L, pp * L[L.length - 1]);
    if (pp > 0) circle(ctx, tipPt[0], tipPt[1], 9, '#ffffff');
    labels.forEach(([s, x, y, th]) => alpha(ctx, ep(t, S.at('d2', 0.02) + th * S.D('d2') * 0.9, 0.4), () => txt(ctx, s, x, y, { size: 24, w: 600, color: C.muted })));
    fadeUp(ctx, t, S.at('d1', 0.2), () => pill(ctx, 120, 930 - 40, 'right radial · 6F sheath', { size: 22, color: C.cyan }));
  });
}
function aorticPressure(ph, damp) {
  let ao;
  if (ph < 0.1) ao = 80 + 60 * Math.sin((ph / 0.1) * Math.PI / 2);
  else if (ph < 0.35) ao = 140 - 32 * Math.pow((ph - 0.1) / 0.25, 1.2);
  else if (ph < 0.46) ao = 108 - 5 * Math.sin(((ph - 0.35) / 0.11) * Math.PI) + 3 * smooth(0.4, 0.46, ph);
  else ao = 111 - 31 * ((ph - 0.46) / 0.54);
  let v;
  if (ph < 0.12) v = 22 + 94 * Math.sin((ph / 0.12) * Math.PI / 2);
  else if (ph < 0.38) v = 116 - 96 * smooth(0.12, 0.38, ph);
  else v = 20 + 12 * ((ph - 0.38) / 0.62);
  return lerp(ao, v, damp);
}
function pressurePanel(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t, x0 = 960, y0 = 440, w = 880, h = 480;
    panel(ctx, x0, y0, w, h, { fill: '#0b1326' });
    txt(ctx, 'Pressure: check before every injection', x0 + 30, y0 + 50, { size: 26, w: 600, color: C.muted });
    const px0 = x0 + 100, pw = w - 140, py = v => y0 + h - 60 - ((v - 0) / 160) * (h - 140);
    ctx.save(); ctx.setLineDash([6, 8]); ctx.strokeStyle = 'rgba(150,170,220,0.25)'; ctx.lineWidth = 1.5;
    for (const v of [80, 140]) { ctx.beginPath(); ctx.moveTo(px0, py(v)); ctx.lineTo(px0 + pw, py(v)); ctx.stroke(); txt(ctx, String(v), px0 - 16, py(v) + 8, { size: 22, color: C.muted, align: 'right' }); }
    ctx.restore();
    const damp = eio(t, S.at('d3', 0.45), 1.6);
    const scroll = t * 0.9;
    ctx.save(); ctx.strokeStyle = mix(C.green, C.amber, damp); ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.beginPath();
    for (let i = 0; i <= pw; i += 3) {
      const tt = (i / pw) * 3 + scroll, ph = tt % 1;
      const localDamp = damp * smooth(0.0, 0.3, i / pw);
      const y = py(aorticPressure(ph, localDamp));
      i ? ctx.lineTo(px0 + i, y) : ctx.moveTo(px0 + i, y);
    }
    ctx.stroke(); ctx.restore();
    txt(ctx, '140 / 80 mmHg', x0 + w - 30, y0 + 96, { size: 28, w: 700, color: C.green, align: 'right', a: 1 - damp });
    alpha(ctx, damp, () => {
      txt(ctx, 'damped / ventricularized', x0 + w - 30, y0 + 96, { size: 28, w: 700, color: C.amber, align: 'right' });
      pill(ctx, x0 + w / 2, y0 + h - 22, 'pull back: wedged, or an ostial lesion', { size: 22, color: C.amber, align: 'center' });
    });
  });
}
function viewMap(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t, cx = 540, cy = 570, sc = 6.5;
    panel(ctx, 80, 170, 960, 790, { fill: '#0d1529' });
    txt(ctx, 'C-arm view map', 116, 226, { size: 26, w: 600, color: C.muted });
    ctx.save(); ctx.strokeStyle = 'rgba(150,170,220,0.35)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(150, cy); ctx.lineTo(1000, cy); ctx.moveTo(cx, 280); ctx.lineTo(cx, 880); ctx.stroke();
    ctx.setLineDash([4, 8]); ctx.strokeStyle = 'rgba(150,170,220,0.15)';
    for (const r of [20, 40]) { ctx.beginPath(); ctx.moveTo(cx - r * sc, 290); ctx.lineTo(cx - r * sc, 870); ctx.moveTo(cx + r * sc, 290); ctx.lineTo(cx + r * sc, 870); ctx.moveTo(160, cy - r * sc); ctx.lineTo(990, cy - r * sc); ctx.moveTo(160, cy + r * sc); ctx.lineTo(990, cy + r * sc); ctx.stroke(); }
    ctx.restore();
    txt(ctx, '← RAO', 160, cy + 44, { size: 26, w: 700, color: C.muted });
    txt(ctx, 'LAO →', 1000, cy + 44, { size: 26, w: 700, color: C.muted, align: 'right' });
    txt(ctx, 'CRANIAL ↑', cx + 14, 290, { size: 22, w: 700, color: C.muted });
    txt(ctx, 'CAUDAL ↓', cx + 14, 900, { size: 22, w: 700, color: C.muted });
    // [lao, cranial, label, colour, time, label dx, label dy, align]
    const pts = [
      [45, -30, 'LAO caudal ("spider")', C.violet, S.at('d5', 0.08), 16, 46, 'right'],
      [-30, -25, 'RAO caudal', C.violet, S.at('d5', 0.26), -22, 9, 'right'],
      [0, 35, 'AP cranial', C.red, S.at('d5', 0.5), 22, 9, 'left'],
      [-30, 30, 'RAO cranial', C.red, S.at('d5', 0.62), -22, 9, 'right'],
      [40, 28, 'LAO cranial', C.red, S.at('d5', 0.86), 22, 9, 'left'],
      [40, 0, 'LAO', C.amber, S.at('d6', 0.05), 22, -14, 'left'],
      [-30, 0, 'RAO', C.amber, S.at('d6', 0.1), -22, -14, 'right'],
      [30, 14, 'LAO cranial (crux)', C.amber, S.at('d6', 0.17), 22, 9, 'left'],
    ];
    for (const [lao, cra, lab, col, t0, dx, dy, al] of pts) {
      fadeUp(ctx, t, t0, () => {
        const x = cx + lao * sc, y = cy - cra * sc;
        glow(ctx, col, 16, () => circle(ctx, x, y, 12, col));
        txt(ctx, lab, x + dx, y + dy, { size: 25, w: 600, color: col, align: al });
      }, 0.45, 8);
    }
  });
}
function eccentricGraphic(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t, x0 = 1100, y0 = 170;
    panel(ctx, x0, y0, 740, 790, { fill: '#0d1529' });
    txt(ctx, 'Why several views?', x0 + 36, y0 + 60, { size: 34, w: 700 });
    txt(ctx, 'An eccentric lesion, in cross-section', x0 + 36, y0 + 102, { size: 24, color: C.muted });
    const cx = x0 + 330, cy = y0 + 430;
    circle(ctx, cx, cy, 150, '#8C3346');
    circle(ctx, cx, cy, 130, C.plaque);
    ctx.save(); ctx.beginPath(); ctx.ellipse(cx, cy + 70, 100, 26, 0, 0, Math.PI * 2); ctx.fillStyle = C.blood; ctx.fill(); ctx.restore();
    txt(ctx, 'plaque', cx, cy - 30, { size: 26, w: 600, color: '#3b2a10', align: 'center' });
    txt(ctx, 'lumen', cx, cy + 80, { size: 22, w: 600, color: '#ffd7dd', align: 'center' });
    const k1 = ep(t, S.at('d4', 0.2)), k2 = ep(t, S.at('d4', 0.5));
    alpha(ctx, k1, () => {
      arrow(ctx, cx, y0 + 150, cx, y0 + 250, { color: C.green, lw: 5, head: 18 });
      txt(ctx, 'view 1', cx + 20, y0 + 180, { size: 24, w: 700, color: C.green });
      rrect(ctx, cx - 100, y0 + 680, 200, 18, 6); ctx.fillStyle = C.green; ctx.fill();
      txt(ctx, 'lumen looks wide → "mild"', cx, y0 + 735, { size: 25, w: 600, color: C.green, align: 'center' });
    });
    alpha(ctx, k2, () => {
      arrow(ctx, x0 + 700, cy + 70, x0 + 520, cy + 70, { color: C.red, lw: 5, head: 18 });
      txt(ctx, 'view 2', x0 + 610, cy + 50, { size: 24, w: 700, color: C.red, align: 'center' });
      rrect(ctx, cx - 200, cy + 44, 18, 52, 6); ctx.fillStyle = C.red; ctx.fill();
      txt(ctx, 'lumen looks narrow', cx - 191, cy + 150, { size: 24, w: 700, color: C.red, align: 'center' });
      txt(ctx, '→ "critical"', cx - 191, cy + 180, { size: 24, w: 700, color: C.red, align: 'center' });
    });
  });
}
function viewCards(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t, x0 = 1100;
    const cards = [
      ['Left main & circumflex', 'LAO caudal (spider) · RAO caudal', C.violet, S.at('d5', 0.05)],
      ['LAD', 'AP cranial · RAO cranial (septals vs diagonals) · LAO cranial', C.red, S.at('d5', 0.45)],
      ['Right coronary', 'LAO · RAO · LAO cranial (crux)', C.amber, S.at('d6', 0.03)],
    ];
    cards.forEach(([h, b, col, t0], i) => fadeUp(ctx, t, t0, () => {
      const y = 170 + i * 190;
      panel(ctx, x0, y, 740, 170, { stroke: rgba(col, 0.6) });
      rrect(ctx, x0, y, 8, 170, 4); ctx.fillStyle = col; ctx.fill();
      txt(ctx, h, x0 + 36, y + 54, { size: 32, w: 700, color: col });
      txt(ctx, b, x0 + 36, y + 98, { size: 26, maxW: 670, color: C.text });
    }));
    fadeUp(ctx, t, S.at('d6', 0.62), () => {
      const y = 760;
      panel(ctx, x0, y, 740, 200, { stroke: rgba(C.cyan, 0.6) });
      txt(ctx, 'Contrast used', x0 + 36, y + 54, { size: 28, w: 700, color: C.cyan });
      const fill = ep(t, S.at('d6', 0.66), 1.4);
      rrect(ctx, x0 + 36, y + 84, 668, 30, 15); ctx.fillStyle = 'rgba(120,140,190,0.2)'; ctx.fill();
      rrect(ctx, x0 + 36, y + 84, 668 * 0.25 * fill, 30, 15); ctx.fillStyle = C.cyan; ctx.fill();
      txt(ctx, 'Iohexol 50 mL — diabetic: keep it low', x0 + 36, y + 160, { size: 26, w: 600 });
    });
  });
}
SCENES.diagnostic = (ctx, S) => {
  const { t } = S;
  const out = S.B('d4') - 0.1;
  bodySchematic(ctx, S, life(t, 0.3, out));
  alpha(ctx, life(t, S.at('d1', 0.25), out), () => {
    fadeUp(ctx, t, S.at('d1', 0.25), () => {
      panel(ctx, 960, 170, 880, 230, { stroke: rgba(C.cyan, 0.6) });
      txt(ctx, '5F Tiger (TIG) catheter', 1000, 232, { size: 36, w: 700, color: C.cyan });
      txt(ctx, 'one catheter engages both the left and the right coronary from the right radial', 1000, 284, { size: 26, maxW: 800, color: C.text });
    });
  });
  pressurePanel(ctx, S, life(t, S.B('d3') - 0.1, out));
  viewMap(ctx, S, ep(t, S.B('d4') + 0.2, 0.7));
  eccentricGraphic(ctx, S, life(t, S.B('d4') + 0.3, S.B('d5') - 0.2));
  viewCards(ctx, S, ep(t, S.B('d5') - 0.1));
};

// ─── reading (angiogram) ───
const TREE = (() => {
  const v = (pts, w0, w1, sys, delay) => ({ sp: spline(pts, 14), w0, w1, sys, delay });
  const T = {
    LM: v([[606, 262], [650, 278], [695, 300]], 18, 16, 'LM', 0),
    LAD_p: v([[695, 300], [735, 352], [768, 404]], 16, 14, 'LAD', 0.25),
    LAD_m: v([[768, 404], [805, 470], [838, 532], [868, 590]], 14, 11, 'LAD', 0.55),
    LAD_d: v([[868, 590], [900, 660], [940, 760], [975, 850], [992, 905], [972, 948], [925, 958], [880, 945]], 11, 5, 'LAD', 0.95),
    S1: v([[768, 404], [735, 452], [700, 496]], 7, 4, 'LAD', 0.7),
    S2: v([[838, 532], [800, 585], [766, 628]], 7, 4, 'LAD', 1.0),
    S3: v([[905, 670], [872, 716], [845, 748]], 5, 3, 'LAD', 1.3),
    D1: v([[785, 432], [860, 470], [940, 520], [1010, 590]], 9, 5, 'LAD', 0.8),
    D2: v([[885, 625], [950, 668], [1020, 730]], 8, 4, 'LAD', 1.2),
    LCX: v([[695, 300], [790, 300], [900, 322], [1010, 380], [1090, 480], [1118, 590]], 14, 9, 'LCX', 0.3),
    OM1: v([[940, 336], [1000, 420], [1040, 520], [1060, 620]], 10, 6, 'LCX', 0.7),
    LPLB: v([[1118, 590], [1120, 680], [1098, 770]], 8, 5, 'LCX', 1.0),
    RCA: v([[515, 262], [450, 300], [375, 400], [338, 520], [340, 640], [380, 740], [455, 810]], 16, 11, 'RCA', 0.1),
    PDA: v([[455, 810], [540, 860], [640, 900], [730, 925]], 8, 4, 'RCA', 0.9),
    AM: v([[344, 560], [290, 610], [250, 660]], 7, 4, 'RCA', 0.6),
  };
  for (const k in T) T[k].L = cumLen(T[k].sp);
  return T;
})();
const SYS_COLOR = { LM: C.cyan, LAD: C.red, LCX: C.violet, RCA: C.amber };
function angioTree(ctx, S, o) {
  const t = S.t;
  const fillStart = o.fillStart;
  for (const [key, v] of Object.entries(TREE)) {
    const hl = o.hl[v.sys] ?? 0;
    if (hl > 0) {
      alpha(ctx, hl, () => tube(ctx, v.sp, { L: v.L, w0: v.w0 + 16, w1: v.w1 + 14, color: rgba(SYS_COLOR[v.sys], 0.5) }));
    }
  }
  for (const [key, v] of Object.entries(TREE)) {
    const p = ep(t, fillStart + v.delay, 1.3);
    let color = C.vessel;
    let wfn = null, ofn = null;
    if (o.timi1 && (key === 'LAD_d' || key === 'S3' || key === 'D2')) color = mix(C.vessel, C.fluoro, 0.62);
    if (key === 'LAD_m' && o.lesion) {
      const f0 = 0.68;
      wfn = f => lerp(v.w0, v.w1, f) * (1 - 0.86 * gauss(f, f0, 0.06));
      ofn = f => 5 * gauss(f, f0, 0.06);
    }
    tube(ctx, v.sp, { L: v.L, w0: v.w0, w1: v.w1, color, p, wfn, ofn });
  }
}
function fluoroPanel(ctx, S, fn) {
  const x0 = 80, y0 = 170, w = 1180, h = 800;
  ctx.save();
  rrect(ctx, x0, y0, w, h, 22); ctx.clip();
  const g = ctx.createRadialGradient(x0 + w * 0.55, y0 + h * 0.5, 80, x0 + w * 0.5, y0 + h * 0.5, w * 0.72);
  g.addColorStop(0, '#cdd1d7'); g.addColorStop(0.7, '#a7adb6'); g.addColorStop(1, '#5d636d');
  ctx.fillStyle = g; ctx.fillRect(x0, y0, w, h);
  // faint heart shadow + aortic root
  ctx.beginPath(); ctx.ellipse(x0 + 690, y0 + 460, 470, 380, -0.35, 0, Math.PI * 2); ctx.fillStyle = 'rgba(80,86,98,0.13)'; ctx.fill();
  ctx.beginPath(); ctx.ellipse(560, 250, 58, 40, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(70,76,88,0.22)'; ctx.fill();
  fn();
  const n = noise(), off = Math.floor(S.t * 30) % 7;
  ctx.drawImage(n, x0 - off * 9, y0 - off * 5, 1300, 975);
  ctx.restore();
  rrect(ctx, x0, y0, w, h, 22); ctx.lineWidth = 2; ctx.strokeStyle = C.line; ctx.stroke();
}
function label(ctx, x, y, lx, ly, s, col, a, o = {}) {
  alpha(ctx, a, () => {
    ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx, ly); ctx.stroke(); ctx.restore();
    circle(ctx, x, y, 6, col);
    pill(ctx, lx, ly, s, { size: o.size ?? 24, color: col, fill: 'rgba(10,15,30,0.86)', align: o.align ?? 'left', textColor: o.textColor ?? col });
  });
}
function timiPanel(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t, x0 = 80, y0 = 170;
    panel(ctx, x0, y0, 1180, 800, { fill: '#0c1428' });
    txt(ctx, 'TIMI flow grades', x0 + 40, y0 + 64, { size: 40, w: 800 });
    const rows = [
      ['TIMI 0', 'no flow beyond the lesion', 0, S.at('f5', 0.14)],
      ['TIMI 1', 'passes the lesion, distal bed does not fill', 1, S.at('f5', 0.3)],
      ['TIMI 2', 'distal bed fills, but slowly', 2, S.at('f5', 0.58)],
      ['TIMI 3', 'normal, brisk flow', 3, S.at('f5', 0.8)],
    ];
    rows.forEach(([name, desc, g, t0], i) => fadeUp(ctx, t, t0, () => {
      const y = y0 + 180 + i * 160, vx0 = x0 + 300, vx1 = x0 + 1130, lx = vx0 + 250;
      txt(ctx, name, x0 + 40, y + 4, { size: 34, w: 800, color: [C.red, C.amber, C.violet, C.green][g] });
      txt(ctx, desc, x0 + 40, y + 44, { size: 21, color: C.muted, maxW: 240 });
      const r = 22;
      const top = x => y - r + 19 * bump(x, lx, 60), bot = x => y + r - 4 * bump(x, lx, 60);
      ctx.beginPath(); for (let x = vx0; x <= vx1; x += 5) ctx.lineTo(x, top(x) - 8); for (let x = vx1; x >= vx0; x -= 5) ctx.lineTo(x, bot(x) + 8); ctx.closePath(); ctx.fillStyle = '#6c2a3a'; ctx.fill();
      ctx.beginPath(); for (let x = vx0; x <= vx1; x += 5) ctx.lineTo(x, top(x)); for (let x = vx1; x >= vx0; x -= 5) ctx.lineTo(x, bot(x)); ctx.closePath(); ctx.fillStyle = '#22101a'; ctx.fill();
      const cyc = ((t - t0) % 3.2) / 3.2;
      const reach = [lx - 20, lx + 140, vx1, vx1][g];
      const speed = [0.25, 0.55, 0.95, 0.28][g];
      const front = lerp(vx0, reach, clamp(cyc / speed));
      const fade = 1 - smooth(0.8, 1, cyc);
      fillBand(ctx, vx0, Math.min(front, lx), top, bot, rgba(C.cyan, 0.95 * fade));
      if (front > lx) {
        let fillStyle = rgba(C.cyan, (g === 2 ? 0.75 : 0.95) * fade);
        if (g === 1) { fillStyle = ctx.createLinearGradient(lx, 0, lx + 140, 0); fillStyle.addColorStop(0, rgba(C.cyan, 0.5 * fade)); fillStyle.addColorStop(1, rgba(C.cyan, 0)); }
        fillBand(ctx, lx, front, top, bot, fillStyle);
      }
    }));
  });
}
function segmentPanel(ctx, S, a) {
  alpha(ctx, a, () => {
    const t = S.t, x0 = 80, y0 = 170;
    panel(ctx, x0, y0, 1180, 800, { fill: '#0c1428' });
    txt(ctx, 'Name the segment — SYNTAX definitions', x0 + 40, y0 + 64, { size: 36, w: 800 });
    const ox = x0 + 90, ax = x0 + 1110, vy = y0 + 330, s1 = ox + 270, apexHalf = s1 + (ax - s1) / 2, s2 = s1 + 190;
    ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = '#5a6d9c'; ctx.lineWidth = 22; ctx.beginPath(); ctx.moveTo(ox, vy); ctx.lineTo(ax, vy); ctx.stroke();
    ctx.lineWidth = 9; for (const sx of [s1, s2, s2 + 170]) { ctx.beginPath(); ctx.moveTo(sx, vy); ctx.lineTo(sx - 30, vy + 90); ctx.stroke(); }
    ctx.restore();
    txt(ctx, 'ostium', ox, vy - 30, { size: 22, color: C.muted, align: 'center' });
    txt(ctx, 'apex', ax, vy - 30, { size: 22, color: C.muted, align: 'center' });
    [['S1', s1], ['S2', s2], ['S3', s2 + 170]].forEach(([n, sx]) => txt(ctx, n, sx - 36, vy + 124, { size: 22, w: 700, color: C.muted, align: 'center' }));
    const seg = (xa, xb, row, name, sub, col, t0) => fadeUp(ctx, t, t0, () => {
      const y = vy + 180 + row * 0;
      ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(xa + 4, y - 16); ctx.lineTo(xa + 4, y); ctx.lineTo(xb - 4, y); ctx.lineTo(xb - 4, y - 16); ctx.stroke(); ctx.restore();
      txt(ctx, name, (xa + xb) / 2, y + 42, { size: 26, w: 700, color: col, align: 'center' });
      txt(ctx, sub, (xa + xb) / 2, y + 76, { size: 20, color: C.muted, align: 'center' });
    });
    seg(ox, s1, 0, 'Seg 6 · proximal', 'ostium → 1st septal (incl.)', C.cyan, S.at('f9', 0.33));
    seg(s1, apexHalf, 0, 'Seg 7 · mid', 'after 1st septal → ~halfway to apex', C.red, S.at('f9', 0.45));
    seg(apexHalf, ax, 0, 'Seg 8 · distal', '', C.violet, S.at('f9', 0.52));
    fadeUp(ctx, t, S.at('f9', 0.05), () => {
      glow(ctx, C.red, 20, () => circle(ctx, s2 + 6, vy, 18, C.red));
      txt(ctx, 'lesion at S2', s2 + 6, vy - 40, { size: 24, w: 700, color: C.red, align: 'center' });
    });
    fadeUp(ctx, t, S.at('f9', 0.08), () => {
      panel(ctx, x0 + 60, y0 + 640, 520, 110, { stroke: rgba(C.green, 0.7), fill: rgba(C.green, 0.08) });
      checkMark(ctx, x0 + 108, y0 + 695, 30, 1, C.green, 6);
      txt(ctx, 'Angiogram report', x0 + 150, y0 + 684, { size: 24, w: 700, color: C.green });
      txt(ctx, '“mid LAD, at the 2nd septal”', x0 + 150, y0 + 722, { size: 24, color: C.text });
    });
    fadeUp(ctx, t, S.at('f9', 0.2), () => {
      panel(ctx, x0 + 610, y0 + 640, 510, 110, { stroke: rgba(C.amber, 0.7), fill: rgba(C.amber, 0.08) });
      crossMark(ctx, x0 + 658, y0 + 695, 24, C.amber, 6);
      txt(ctx, 'PCI note', x0 + 700, y0 + 684, { size: 24, w: 700, color: C.amber });
      txt(ctx, '“proximal LAD” → reconcile', x0 + 700, y0 + 722, { size: 24, color: C.text });
    });
  });
}
function reportLines(ctx, S) {
  const t = S.t, x0 = 1300, w = 540;
  fadeUp(ctx, t, 0.4, () => {
    panel(ctx, x0, 170, w, 800);
    txt(ctx, 'YOUR READ, IN ORDER', x0 + 30, 222, { size: 22, w: 700, color: C.amber, spacing: 2 });
  });
  const L = [
    ['LM', 'normal → LAD + LCx', C.cyan, S.at('f2', 0.1)],
    ['LAD', 'type III — wraps the apex', C.red, S.at('f3', 0.1)],
    ['', 'ostium: minimal plaque', C.muted, S.at('f4', 0.05)],
    ['', 'proximal: normal', C.muted, S.at('f4', 0.18)],
    ['', 'mid: 99% discrete, eccentric, astride S2 → TIMI 1', C.red, S.at('f4', 0.35)],
    ['LCx', 'co-dominant · OM1 major · L-PLB — normal', C.violet, S.at('f6', 0.1)],
    ['RCA', 'co-dominant · proximal 20–30% · TIMI 3 · R-PDA normal', C.amber, S.at('f7', 0.1)],
  ];
  let y = 290;
  for (const [k, s, col, t0] of L) {
    const hgt = (() => { ctx.save(); setFont(ctx, 24, 500); const n = wrapLines(ctx, s, k ? w - 130 : w - 130).length; ctx.restore(); return n * 31; })();
    const yy = y;
    fadeUp(ctx, t, t0, () => {
      if (k) txt(ctx, k, x0 + 30, yy, { size: 26, w: 800, color: col });
      txt(ctx, s, x0 + 100, yy, { size: 24, w: 500, color: col === C.muted ? C.muted : C.text, maxW: w - 130, lh: 1.28 });
    });
    y += hgt + (k ? 18 : 10);
  }
  fadeUp(ctx, t, S.at('f8', 0.05), () => {
    const yy = 740;
    panel(ctx, x0 + 20, yy, w - 40, 210, { fill: rgba(C.green, 0.1), stroke: rgba(C.green, 0.7) });
    txt(ctx, 'Diagnosis', x0 + 50, yy + 46, { size: 24, w: 700, color: C.green });
    txt(ctx, 'Co-dominant system · single-vessel disease (LAD)', x0 + 50, yy + 84, { size: 24, w: 600, maxW: w - 100 });
    txt(ctx, 'Culprit matches ECG territory', x0 + 50, yy + 150, { size: 22, color: C.muted });
    txt(ctx, 'Plan: PCI to LAD', x0 + 50, yy + 188, { size: 26, w: 800, color: C.green });
  });
}
SCENES.reading = (ctx, S) => {
  const { t } = S;
  const f5 = S.B('f5'), f6 = S.B('f6'), f9 = S.B('f9');
  const angioA = ep(t, 0.2) * (1 - 0.9 * life(t, f5 - 0.1, f6 - 0.3)) * (1 - 0.9 * ep(t, f9 - 0.1));
  const hl = {
    LM: life(t, S.at('f2', 0), S.B('f3')),
    LAD: life(t, S.B('f3'), f5 - 0.2) + life(t, S.at('f8', 0.05), f9 - 0.2),
    LCX: life(t, f6, S.B('f7')),
    RCA: life(t, S.B('f7'), S.B('f8')),
  };
  alpha(ctx, angioA, () => fluoroPanel(ctx, S, () => {
    angioTree(ctx, S, { fillStart: 0.6, hl, lesion: true, timi1: true });
    label(ctx, 640, 272, 560, 205, 'LM', C.cyan, life(t, S.at('f2', 0.1), S.B('f3')));
    label(ctx, 870, 700, 1000, 830, 'type III LAD wraps the apex', C.red, life(t, S.at('f3', 0.3), S.B('f4')));
    label(ctx, 842, 536, 915, 432, '99% · astride S2 · TIMI 1', C.red, life(t, S.at('f4', 0.35), f5 - 0.2), { size: 22 });
    label(ctx, 800, 590, 640, 640, 'S2', C.red, life(t, S.at('f4', 0.45), f5 - 0.2));
    label(ctx, 718, 318, 820, 250, 'ostium: minimal plaque · proximal: normal', C.cyan, life(t, S.at('f4', 0.05), S.at('f4', 0.34)), { size: 22 });
    label(ctx, 1040, 520, 1100, 440, 'OM1', C.violet, life(t, S.at('f6', 0.3), S.B('f7')));
    label(ctx, 1110, 700, 1150, 780, 'L-PLB', C.violet, life(t, S.at('f6', 0.55), S.B('f7')), { align: 'center' });
    label(ctx, 375, 400, 180, 360, '20–30%', C.amber, life(t, S.at('f7', 0.25), S.B('f8')));
    label(ctx, 620, 894, 520, 930, 'R-PDA', C.amber, life(t, S.at('f7', 0.6), S.B('f8')), { align: 'right' });
    label(ctx, 842, 536, 945, 432, 'culprit', C.green, life(t, S.at('f8', 0.3), f9 - 0.2));
  }));
  fadeUp(ctx, t, S.at('f1', 0.35), () => {
    if (t < S.B('f2') + 0.5) pill(ctx, 670, 925, 'LM → LAD → LCx → RCA, every time', { size: 26, color: C.cyan, align: 'center', fill: 'rgba(10,15,30,0.86)' });
  });
  timiPanel(ctx, S, life(t, f5 - 0.1, f6 - 0.3));
  segmentPanel(ctx, S, ep(t, f9 - 0.1));
  reportLines(ctx, S);
};

// ─── hardware ───
function deviceIcon(ctx, kind, x, y, col) {
  ctx.save(); ctx.translate(x, y); ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (kind === 'sheath') {
    ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(50, 0); ctx.stroke();
    rrect(ctx, -46, -14, 36, 28, 6); ctx.fill();
    ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-30, -14); ctx.quadraticCurveTo(-40, -36, -20, -40); ctx.stroke();
  } else if (kind === 'guide') {
    ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(-48, 34); ctx.lineTo(-10, -20); ctx.quadraticCurveTo(10, -44, 30, -26); ctx.quadraticCurveTo(46, -12, 40, 8); ctx.lineTo(52, 14); ctx.stroke();
  } else if (kind === 'wire') {
    ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-50, 10); ctx.bezierCurveTo(-10, 10, 20, 12, 40, 4); ctx.quadraticCurveTo(52, 0, 50, -12); ctx.stroke();
  } else if (kind === 'balloon' || kind === 'nc') {
    ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-54, 0); ctx.lineTo(54, 0); ctx.stroke();
    rrect(ctx, -32, -14, 64, 28, kind === 'nc' ? 6 : 14); ctx.globalAlpha *= 0.85; ctx.fill(); ctx.globalAlpha /= 0.85;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(-26, -3, 5, 6); ctx.fillRect(21, -3, 5, 6);
  } else if (kind === 'stent') {
    ctx.lineWidth = 2.5; ctx.beginPath();
    for (let i = 0; i < 7; i++) { const x0 = -42 + i * 14; ctx.moveTo(x0, -16); ctx.lineTo(x0 + 7, -8); ctx.lineTo(x0, 0); ctx.lineTo(x0 + 7, 8); ctx.lineTo(x0, 16); }
    ctx.moveTo(-42, -16); ctx.lineTo(48, -16); ctx.moveTo(-42, 16); ctx.lineTo(48, 16); ctx.stroke();
  }
  ctx.restore();
}
const DEVICES = [
  ['sheath', '6F sheath', 'right radial access', C.muted, 'h1'],
  ['guide', '6F EBU 3.5 guide', 'extra back-up support for the left system', C.cyan, 'h2'],
  ['wire', '0.014″ BMW wire', 'workhorse: soft tip, steerable', C.green, 'h3'],
  ['balloon', '2.0 × 10 mm balloon', 'semi-compliant · pre-dilation, undersized', C.violet, 'h4'],
  ['stent', '2.5 × 24 mm DES', 'Yukon Choice Flex · drug-eluting stent', C.red, 'h5'],
  ['nc', '2.5 × 10 mm NC balloon', 'non-compliant · post-dilation, inside the stent', C.amber, 'h6'],
];
function hwDetail(ctx, S, key, a) {
  alpha(ctx, a, () => {
    const t = S.t, x0 = 1060, y0 = 170, w = 780, h = 800;
    panel(ctx, x0, y0, w, h, { fill: '#0c1428' });
    const cx = x0 + w / 2;
    if (key === 'h1') {
      txt(ctx, 'For every device, know:', x0 + 50, y0 + 120, { size: 40, w: 800 });
      ['what it is', 'its size', 'why it was chosen', 'what you would switch to'].forEach((s, i) =>
        fadeUp(ctx, t, S.at('h1', 0.2 + i * 0.15), () => { checkMark(ctx, x0 + 80, y0 + 226 + i * 90, 30, 1, C.green, 6); txt(ctx, s, x0 + 130, y0 + 238 + i * 90, { size: 34, w: 600 }); }));
    } else if (key === 'h2') {
      txt(ctx, 'EBU: braces on the opposite wall', x0 + 40, y0 + 64, { size: 32, w: 700, color: C.cyan });
      const ax = x0 + 250, ay = y0 + 140, aw = 300;
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // ascending aorta: two walls, left-main ostium on the right wall, cusps at the bottom
      ctx.strokeStyle = '#3a4a78'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax, ay + 520); ctx.quadraticCurveTo(ax + aw / 4, ay + 590, ax + aw / 2, ay + 540); ctx.quadraticCurveTo(ax + 3 * aw / 4, ay + 590, ax + aw, ay + 520);
      ctx.lineTo(ax + aw, ay + 420); ctx.moveTo(ax + aw, ay + 340); ctx.lineTo(ax + aw, ay); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax + aw, ay + 340); ctx.lineTo(ax + aw + 150, ay + 310); ctx.moveTo(ax + aw, ay + 420); ctx.lineTo(ax + aw + 150, ay + 390); ctx.stroke();
      ctx.restore();
      txt(ctx, 'left main', ax + aw + 90, ay + 290, { size: 22, color: C.muted, align: 'center' });
      txt(ctx, 'aortic valve', ax + aw / 2, ay + 620, { size: 22, color: C.muted, align: 'center' });
      txt(ctx, 'from the arm ↓', ax + 150, ay - 14, { size: 22, color: C.muted, align: 'center' });
      const k = ep(t, S.at('h2', 0.1), 1.8);
      const cath = spline([[ax + 150, ay + 10], [ax + 110, ay + 120], [ax + 30, ay + 280], [ax + 18, ay + 420], [ax + 70, ay + 490], [ax + 190, ay + 450], [ax + 270, ay + 395], [ax + aw + 14, ay + 380]], 16);
      glow(ctx, rgba(C.cyan, 0.7), 12, () => { ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = C.cyan; ctx.lineWidth = 12; strokePath(ctx, cath, k); ctx.restore(); });
      alpha(ctx, ep(t, S.at('h2', 0.35)), () => {
        for (let i = 0; i < 3; i++) arrow(ctx, ax + 100, ay + 300 + i * 50, ax + 36, ay + 300 + i * 50, { color: C.amber, lw: 4, head: 12 });
        txt(ctx, 'wall contact', ax - 24, ay + 340, { size: 24, w: 700, color: C.amber, align: 'right' });
        txt(ctx, '= back-up support', ax - 24, ay + 372, { size: 24, w: 700, color: C.amber, align: 'right' });
      });
      alpha(ctx, ep(t, S.at('h2', 0.72)), () => pill(ctx, cx, y0 + h - 50, 'curve size ~ aortic root: small root ↓ · dilated root ↑', { size: 22, color: C.cyan, align: 'center' }));
    } else if (key === 'h3') {
      txt(ctx, 'Workhorse wire', x0 + 40, y0 + 64, { size: 32, w: 700, color: C.green });
      const k = ep(t, S.at('h3', 0.05), 1.6);
      ctx.save(); ctx.strokeStyle = '#e8f6ff'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      strokePath(ctx, spline([[x0 + 60, y0 + 420], [x0 + 400, y0 + 420], [x0 + 620, y0 + 410], [x0 + 680, y0 + 380], [x0 + 690, y0 + 345]], 16), k);
      ctx.restore();
      alpha(ctx, ep(t, S.at('h3', 0.2)), () => {
        rrect(ctx, x0 + 120, y0 + 392, 90, 56, 12); ctx.fillStyle = '#51607f'; ctx.fill();
        txt(ctx, 'torque device', x0 + 165, y0 + 490, { size: 22, color: C.muted, align: 'center' });
        ctx.save(); ctx.strokeStyle = C.amber; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x0 + 165, y0 + 420, 60, -2.4, -0.8); ctx.stroke(); ctx.restore();
        txt(ctx, 'soft, shaped tip', x0 + 690, y0 + 310, { size: 24, w: 700, color: C.green, align: 'right' });
      });
      ['0.014″ diameter', 'soft tip · good torque control', 'first choice for a non-occlusive lesion'].forEach((s, i) =>
        fadeUp(ctx, t, S.at('h3', 0.35 + i * 0.18), () => pill(ctx, x0 + 60, y0 + 590 + i * 64, s, { size: 24, color: C.green })));
    } else if (key === 'h4' || key === 'h5') {
      const stent = key === 'h5';
      txt(ctx, stent ? 'Sizing the stent' : 'Pre-dilation: deliberately undersized', x0 + 40, y0 + 64, { size: 32, w: 700, color: stent ? C.red : C.violet });
      const vy = y0 + 360, R = 70, lx0 = x0 + 80, lx1 = x0 + w - 80, lc = x0 + w / 2;
      const top = x => vy - R + 1.5 * R * bump(x, lc, 110), bot = x => vy + R - 0.25 * R * bump(x, lc, 110);
      ctx.beginPath(); for (let x = lx0; x <= lx1; x += 4) ctx.lineTo(x, vy - R - 18); for (let x = lx1; x >= lx0; x -= 4) ctx.lineTo(x, vy + R + 18); ctx.closePath(); ctx.fillStyle = C.wall; ctx.fill();
      ctx.beginPath(); for (let x = lx0; x <= lx1; x += 4) ctx.lineTo(x, vy - R); for (let x = lx1; x >= lx0; x -= 4) ctx.lineTo(x, vy + R); ctx.closePath(); ctx.fillStyle = C.plaque; ctx.fill();
      ctx.beginPath(); for (let x = lx0; x <= lx1; x += 4) ctx.lineTo(x, top(x)); for (let x = lx1; x >= lx0; x -= 4) ctx.lineTo(x, bot(x)); ctx.closePath(); ctx.fillStyle = C.lumen; ctx.fill();
      if (!stent) {
        const k = ep(t, S.at('h4', 0.3), 1.2);
        const rb = lerp(8, 0.8 * R, k);
        ctx.beginPath(); for (let x = lc - 80; x <= lc + 80; x += 4) ctx.lineTo(x, Math.max(vy - rb, top(x) + 2)); for (let x = lc + 80; x >= lc - 80; x -= 4) ctx.lineTo(x, Math.min(vy + rb, bot(x) - 2)); ctx.closePath();
        ctx.fillStyle = rgba(C.violet, 0.8); ctx.fill();
        pill(ctx, cx, y0 + 560, 'balloon : artery ≈ 0.8 : 1', { size: 26, color: C.violet, align: 'center' });
        txt(ctx, 'opens the lesion · makes room for the stent', cx, y0 + 640, { size: 26, color: C.muted, align: 'center' });
      } else {
        const k1 = ep(t, S.at('h5', 0.3)), k2 = ep(t, S.at('h5', 0.55));
        alpha(ctx, k1, () => {
          ctx.save(); ctx.strokeStyle = C.cyan; ctx.lineWidth = 3; ctx.setLineDash([8, 6]);
          ctx.beginPath(); ctx.moveTo(lx1 - 50, vy - R); ctx.lineTo(lx1 - 50, vy + R); ctx.stroke(); ctx.restore();
          arrow(ctx, lx1 - 50, vy, lx1 - 50, vy - R + 4, { color: C.cyan, lw: 3, head: 10 });
          arrow(ctx, lx1 - 50, vy, lx1 - 50, vy + R - 4, { color: C.cyan, lw: 3, head: 10 });
          txt(ctx, 'Ø = distal reference', lx1 - 40, vy + R + 104, { size: 24, w: 700, color: C.cyan, align: 'right' });
        });
        alpha(ctx, k2, () => {
          const s0 = lc - 190, s1 = lc + 190;
          ctx.save(); ctx.strokeStyle = C.green; ctx.lineWidth = 4;
          for (const [a0, a1] of [[s0, lc - 110], [lc + 110, s1]]) { rrect(ctx, a0, vy - R - 30, a1 - a0, 2 * R + 60, 10); ctx.stroke(); }
          ctx.restore();
          ctx.save(); ctx.strokeStyle = C.red; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(s0, vy - R - 56); ctx.lineTo(s1, vy - R - 56); ctx.moveTo(s0, vy - R - 68); ctx.lineTo(s0, vy - R - 44); ctx.moveTo(s1, vy - R - 68); ctx.lineTo(s1, vy - R - 44); ctx.stroke(); ctx.restore();
          txt(ctx, 'length: healthy → healthy', lc, vy - R - 80, { size: 24, w: 700, color: C.red, align: 'center' });
          txt(ctx, 'landing zones', lc - 150, vy + R + 64, { size: 22, w: 600, color: C.green, align: 'center' });
        });
        fadeUp(ctx, t, S.at('h5', 0.8), () => pill(ctx, cx, y0 + 700, 'goal: no disease left at the stent edges', { size: 24, color: C.red, align: 'center' }));
      }
    } else if (key === 'h6') {
      txt(ctx, 'Compliance: size vs pressure', x0 + 40, y0 + 64, { size: 32, w: 700, color: C.amber });
      const gx = x0 + 110, gy = y0 + 600, gw = 580, gh = 420;
      ctx.save(); ctx.strokeStyle = C.muted; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(gx, gy - gh); ctx.lineTo(gx, gy); ctx.lineTo(gx + gw, gy); ctx.stroke(); ctx.restore();
      txt(ctx, 'pressure (atm) →', gx + gw, gy + 44, { size: 22, color: C.muted, align: 'right' });
      ctx.save(); ctx.translate(gx - 30, gy - gh / 2); ctx.rotate(-Math.PI / 2); txt(ctx, 'balloon diameter →', 0, 0, { size: 22, color: C.muted, align: 'center' }); ctx.restore();
      const k = ep(t, S.at('h6', 0.2), 2.0);
      ctx.save(); ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.strokeStyle = C.violet; ctx.beginPath(); ctx.moveTo(gx, gy - 90); ctx.lineTo(gx + gw * k, gy - 90 - 250 * k); ctx.stroke();
      ctx.strokeStyle = C.amber; ctx.beginPath(); ctx.moveTo(gx, gy - 150); ctx.lineTo(gx + gw * k, gy - 150 - 45 * k); ctx.stroke(); ctx.restore();
      alpha(ctx, k, () => {
        txt(ctx, 'semi-compliant: grows', gx + gw - 10, gy - 360, { size: 24, w: 700, color: C.violet, align: 'right' });
        txt(ctx, 'non-compliant: barely grows', gx + gw - 10, gy - 150 - 45 * k + 44, { size: 24, w: 700, color: C.amber, align: 'right' });
      });
      fadeUp(ctx, t, S.at('h6', 0.7), () => pill(ctx, cx, y0 + 700, 'high force, less overstretch · shorter than the stent, inside it', { size: 22, color: C.amber, align: 'center' }));
    } else if (key === 'h7') {
      txt(ctx, 'Intravascular imaging (IVUS / OCT)', x0 + 40, y0 + 64, { size: 32, w: 700, color: C.cyan });
      const icx = x0 + 300, icy = y0 + 400;
      circle(ctx, icx, icy, 200, '#2a2f3d');
      ctx.save(); ctx.setLineDash([10, 8]); circle(ctx, icx, icy, 180, null, C.cyan, 3); ctx.restore();
      circle(ctx, icx, icy, 176, '#8a7a55'); circle(ctx, icx + 18, icy + 8, 118, '#0b0e15');
      ctx.save(); ctx.strokeStyle = C.red; ctx.lineWidth = 3; ctx.setLineDash([4, 6]); ctx.beginPath(); ctx.arc(icx + 18, icy + 8, 112, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      circle(ctx, icx + 18, icy + 8, 16, '#e8eef8');
      const sweepA = (t * 2.2) % (Math.PI * 2);
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(icx + 18, icy + 8); ctx.lineTo(icx + 18 + Math.cos(sweepA) * 190, icy + 8 + Math.sin(sweepA) * 190); ctx.stroke(); ctx.restore();
      [['vessel (EEM) size', C.cyan, 0.1], ['lumen / stent area', C.red, 0.3], ['expansion & apposition', C.green, 0.5]].forEach(([s, col, f], i) =>
        fadeUp(ctx, t, S.at('h7', f), () => pill(ctx, x0 + 540, y0 + 300 + i * 80, s, { size: 22, color: col })));
      fadeUp(ctx, t, S.at('h7', 0.7), () => txt(ctx, 'favoured especially for complex lesions', cx, y0 + 700, { size: 26, color: C.muted, align: 'center' }));
    } else if (key === 'h8') {
      txt(ctx, 'Anticoagulation for PCI', x0 + 40, y0 + 64, { size: 32, w: 700, color: C.cyan });
      const gcx = cx, gcy = y0 + 440, r = 210;
      const angOf = v => Math.PI + (v / 500) * Math.PI;
      ctx.save(); ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(120,140,190,0.25)'; ctx.lineWidth = 34; ctx.beginPath(); ctx.arc(gcx, gcy, r, Math.PI, 2 * Math.PI); ctx.stroke();
      ctx.strokeStyle = C.green; ctx.beginPath(); ctx.arc(gcx, gcy, r, angOf(250), angOf(350)); ctx.stroke();
      ctx.restore();
      for (const v of [0, 100, 200, 300, 400, 500]) { const a = angOf(v); txt(ctx, String(v), gcx + Math.cos(a) * (r + 50), gcy + Math.sin(a) * (r + 50) + 8, { size: 20, color: C.muted, align: 'center' }); }
      const val = lerp(120, 300, ep(t, S.at('h8', 0.45), 1.6));
      const a = angOf(val);
      ctx.save(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(gcx, gcy); ctx.lineTo(gcx + Math.cos(a) * (r - 30), gcy + Math.sin(a) * (r - 30)); ctx.stroke(); ctx.restore();
      circle(ctx, gcx, gcy, 12, '#ffffff');
      txt(ctx, `ACT ${Math.round(val)} s`, gcx, gcy + 70, { size: 36, w: 800, align: 'center' });
      txt(ctx, 'illustrative', gcx, gcy + 146, { size: 20, color: C.dim, align: 'center' });
      txt(ctx, 'target ≈ 250–350 s', gcx, gcy + 112, { size: 24, w: 600, color: C.green, align: 'center' });
      fadeUp(ctx, t, S.at('h8', 0.2), () => pill(ctx, cx, y0 + 660, 'UFH 70–100 IU/kg (no GP IIb/IIIa)', { size: 24, color: C.cyan, align: 'center' }));
      fadeUp(ctx, t, S.at('h8', 0.75), () => pill(ctx, cx, y0 + 730, 'adjust for the lytic-phase anticoagulant — per protocol', { size: 22, color: C.amber, align: 'center' }));
    }
  });
}
SCENES.hardware = (ctx, S) => {
  const { t } = S;
  const keys = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'];
  DEVICES.forEach(([kind, name, role, col, beat], i) => {
    const y = 170 + i * 134;
    const next = keys[keys.indexOf(beat) + 1];
    const activeK = life(t, S.B(beat), next ? S.B(next) : null, 0.4);
    fadeUp(ctx, t, S.B(beat) - 0.1, () => {
      panel(ctx, 80, y, 940, 118, { fill: mix(C.panel, col, 0.08 * activeK), stroke: activeK > 0.05 ? rgba(col, 0.3 + 0.6 * activeK) : C.line });
      deviceIcon(ctx, kind, 160, y + 59, col);
      txt(ctx, name, 250, y + 50, { size: 32, w: 700, color: activeK > 0.5 ? col : C.text });
      txt(ctx, role, 250, y + 90, { size: 24, color: C.muted });
    });
  });
  keys.forEach((k, i) => hwDetail(ctx, S, k, life(t, S.B(k) - 0.15, keys[i + 1] ? S.B(keys[i + 1]) - 0.2 : null, 0.45)));
};

// ─── pci (the showpiece) ───
const PV = { x0: 40, x1: 1880, cy: 440, R: 64, wallT: 22, Lc: 980, Lh: 120 };
function pciState(S) {
  const t = S.t;
  const st = {};
  st.guideX = lerp(-260, 150, eio(t, S.at('p1', 0.05), 2.2));
  // lesion severity (top/bottom plaque as fraction of 2R)
  const preK = [prog(t, S.at('p4', 0.3), 0.01), 0, 0];
  const inflWin = (b, f0, f1, n) => { const T0 = S.at(b, f0), T1 = S.at(b, f1), d = (T1 - T0) / n; return [...Array(n)].map((_, i) => [T0 + i * d, T0 + (i + 1) * d]); };
  const preWins = inflWin('p4', 0.28, 0.92, 3);
  const depWins = inflWin('p6', 0.12, 0.88, 2);
  const ncWins = inflWin('p7', 0.3, 0.9, 1);
  void preK;
  const inflate = (w) => { const [a, b] = w, d = b - a; if (t < a || t > b) return 0; const u = (t - a) / d; return u < 0.3 ? easeOut(u / 0.3) : u < 0.72 ? 1 : 1 - easeIO((u - 0.72) / 0.28); };
  const done = (w) => clamp((t - w[0]) / ((w[1] - w[0]) * 0.72));
  let sevT = 0.85;
  preWins.forEach((w, i) => { sevT -= [0.12, 0.08, 0.05][i] * easeOut(done(w)); });
  const stentExp = Math.max(easeOut(clamp(done(depWins[0]) / 0.9)), 0);
  const stentExp2 = easeOut(done(depWins[1]));
  const ncExp = easeOut(done(ncWins[0]));
  sevT = lerp(sevT, 0.08, stentExp);
  sevT = lerp(sevT, 0.04, stentExp2);
  let preInfl = 0;
  if (t < S.B('p5')) preWins.forEach(w => { preInfl = Math.max(preInfl, inflate(w)); });
  st.sevT = Math.max(0.1, sevT - 0.3 * preInfl);
  st.sevB = lerp(0.1, 0.0, stentExp);
  st.remodel = stentExp;
  // stent geometry
  st.stentOn = t >= S.B('p5');
  st.stentX0 = PV.Lc - 200; st.stentX1 = PV.Lc + 200;
  const travel = eio(t, S.B('p5'), Math.max(2, S.D('p5') * 0.45));
  st.stentShift = lerp(-1100, 0, travel);
  st.stentR = x => {
    const crimp = 12;
    const exp1 = PV.R * (0.86 + 0.06 * stentExp2) - PV.R * 0.1 * bump(x, PV.Lc, 170) * (1 - ncExp * (Math.abs(x - PV.Lc) < 90 ? 1 : 0.5));
    return lerp(crimp, exp1 + ncExp * PV.R * 0.1 * bump(x, PV.Lc, 110), stentExp);
  };
  // balloons
  st.balloons = [];
  const preOn = t >= S.at('p4', 0.02) && t < S.B('p5');
  if (preOn) {
    const inX = eio(t, S.at('p4', 0.02), Math.max(1.5, S.D('p4') * 0.2));
    const out = ep(t, S.at('p4', 0.93), 0.8);
    const cxb = lerp(-600, PV.Lc, inX) - out * 1200;
    let infl = 0, idx = -1;
    preWins.forEach((w, i) => { const v = inflate(w); if (v > infl) { infl = v; idx = i; } });
    st.balloons.push({ cx: cxb, half: 84, rMax: PV.R * 0.78, infl, col: C.violet, markers: true });
    st.gauge = { on: true, atm: [8, 10, 10][Math.max(0, idx)] * infl, target: idx >= 0 ? [8, 10, 10][idx] : null, secs: idx >= 0 ? [10, 10, 8][idx] : null, label: '2.0 × 10 mm balloon', n: idx + 1, of: 3 };
  }
  if (st.stentOn && t < S.B('p7')) {
    let infl = 0, idx = -1;
    depWins.forEach((w, i) => { const v = inflate(w); if (v > infl) { infl = v; idx = i; } });
    const out = ep(t, S.at('p6', 0.92), 0.7);
    st.balloons.push({ cx: PV.Lc + st.stentShift - out * 1300, half: 205, rMax: PV.R * (idx === 1 ? 0.98 : 0.92), infl, col: rgba('#b0c4ff', 0.55), stentBalloon: true, markers: true });
    if (t >= S.B('p6')) st.gauge = { on: true, atm: [14, 16][Math.max(0, idx)] * infl, target: idx >= 0 ? [14, 16][idx] : null, secs: idx >= 0 ? [10, 12][idx] : null, label: '2.5 × 24 mm DES', n: idx + 1, of: 2 };
  }
  if (t >= S.B('p7') && t < S.B('p8') + 0.8) {
    const inX = eio(t, S.at('p7', 0.02), Math.max(1.4, S.D('p7') * 0.24));
    const out = ep(t, S.at('p7', 0.93), 0.8);
    const infl = inflate(ncWins[0]);
    st.balloons.push({ cx: lerp(-500, PV.Lc, inX) - out * 1300, half: 84, rMax: PV.R * 1.0, infl, col: rgba(C.amber, 0.75), markers: true, nc: true });
    if (t < S.B('p8')) st.gauge = { on: true, atm: 14 * infl, target: t >= ncWins[0][0] ? 14 : null, secs: t >= ncWins[0][0] ? 12 : null, label: '2.5 × 10 mm NC', n: 1, of: 1 };
  }
  // wire
  st.wireTip = lerp(st.guideX, 1780, eio(t, S.at('p3', 0.1), Math.max(2.5, S.D('p3') * 0.5)));
  st.wireOn = t >= S.at('p3', 0.08);
  // contrast
  const inj1 = S.at('p1', 0.78), inj2 = S.B('p2');
  st.contrast = null;
  if (t >= inj1 && t < S.B('p3') + 0.6) {
    const front = lerp(st.guideX, 1880, clamp((t - inj1) / 2.2));
    st.contrast = { front, a: 0.85 * (1 - ep(t, S.B('p3'), 0.6)), distal: 0.22 };
    void inj2;
  }
  if (t >= S.at('p5', 0.62) && t < S.B('p6')) {
    const k = life(t, S.at('p5', 0.62), S.at('p5', 0.62) + 1.4, 0.3);
    st.contrast = { front: 1880, a: 0.55 * k, distal: 0.4 };
  }
  st.brisk = ep(t, S.B('p8'), 0.8);
  return st;
}
function drawVessel(ctx, S, st) {
  const { x0, x1, cy, R, wallT, Lc, Lh } = PV;
  const lumTop = x => cy - R + st.sevT * 2 * R * bump(x, Lc, Lh);
  const lumBot = x => cy + R - st.sevB * 2 * R * bump(x, Lc + 30, Lh * 0.8);
  const wallIn = x => cy - R - st.remodel * 0.28 * R * bump(x, Lc, Lh);
  const band = (f1, f2, fill) => { ctx.beginPath(); for (let x = x0; x <= x1; x += 4) ctx.lineTo(x, f1(x)); for (let x = x1; x >= x0; x -= 4) ctx.lineTo(x, f2(x)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
  // septal branch (straddled by the lesion)
  const sb = spline([[Lc + 60, cy + R - 10], [Lc + 110, cy + R + 90], [Lc + 170, cy + R + 190]], 12);
  ctx.save(); ctx.lineCap = 'round';
  ctx.strokeStyle = C.wall; ctx.lineWidth = 58; strokePath(ctx, sb);
  ctx.strokeStyle = C.lumen; ctx.lineWidth = 30; strokePath(ctx, sb);
  ctx.restore();
  band(x => wallIn(x) - wallT, x => cy + R + wallT, C.wall);
  band(wallIn, x => cy + R, C.plaque);
  // plaque cap texture
  ctx.save(); ctx.strokeStyle = 'rgba(120,80,20,0.35)'; ctx.lineWidth = 2;
  for (let x = Lc - Lh + 20; x < Lc + Lh - 20; x += 26) { const yy = (wallIn(x) + lumTop(x)) / 2; if (lumTop(x) - wallIn(x) > 10) { ctx.beginPath(); ctx.arc(x, yy, 4, 0, Math.PI * 2); ctx.stroke(); } }
  ctx.restore();
  band(lumTop, lumBot, C.lumen);
  // septal ostium opening into the lumen
  ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = C.lumen; ctx.lineWidth = 30; ctx.beginPath(); ctx.moveTo(Lc + 52, cy + R - 26); ctx.lineTo(Lc + 84, cy + R + 40); ctx.stroke(); ctx.restore();
  // contrast
  if (st.contrast && st.contrast.a > 0) {
    const { front, a, distal } = st.contrast;
    const xa = Math.max(x0, st.guideX), xf = Math.min(front, x1), split = Lc + 40;
    fillBand(ctx, xa, Math.min(xf, split), lumTop, lumBot, rgba(C.cyan, a));
    if (xf > split) {
      const g = ctx.createLinearGradient(split, 0, xf, 0);
      g.addColorStop(0, rgba(C.cyan, a * Math.max(distal, 0.6))); g.addColorStop(0.25, rgba(C.cyan, a * distal)); g.addColorStop(1, rgba(C.cyan, a * distal * 0.6));
      fillBand(ctx, split, xf, lumTop, lumBot, g);
    }
  }
  if (st.brisk > 0) {
    alpha(ctx, st.brisk, () => {
      fillBand(ctx, x0, x1, lumTop, lumBot, rgba(C.cyan, 0.42));
      ctx.save(); ctx.lineCap = 'round'; ctx.strokeStyle = rgba(C.cyan, 0.5); ctx.lineWidth = 22; strokePath(ctx, sb); ctx.restore();
      ctx.save(); ctx.strokeStyle = 'rgba(220,250,255,0.75)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      for (let i = 0; i < 26; i++) {
        const x = x0 + ((S.t * 900 + i * 173) % (x1 - x0)), yy = cy + ((i * 29) % 90) - 45;
        ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + 40, yy); ctx.stroke();
      }
      ctx.restore();
    });
  }
  return { lumTop, lumBot };
}
function drawBalloon(ctx, b, lum) {
  const { cy } = PV;
  const xa = b.cx - b.half, xb = b.cx + b.half, cone = 22;
  const r = x => {
    const taper = x < xa + cone ? (x - xa) / cone : x > xb - cone ? (xb - x) / cone : 1;
    return lerp(9, b.rMax, b.infl) * clamp(taper, 0.12, 1);
  };
  ctx.save(); ctx.lineWidth = 5; ctx.strokeStyle = '#d7dff0'; ctx.beginPath(); ctx.moveTo(-100, cy); ctx.lineTo(xa, cy); ctx.stroke(); ctx.restore();
  ctx.beginPath();
  for (let x = xa; x <= xb; x += 3) ctx.lineTo(x, Math.max(cy - r(x), lum.lumTop(x) + 2));
  for (let x = xb; x >= xa; x -= 3) ctx.lineTo(x, Math.min(cy + r(x), lum.lumBot(x) - 2));
  ctx.closePath(); ctx.fillStyle = b.col; ctx.fill();
  if (b.markers) { ctx.fillStyle = '#ffffff'; ctx.fillRect(xa + cone - 4, cy - 5, 7, 10); ctx.fillRect(xb - cone - 3, cy - 5, 7, 10); }
}
function drawStent(ctx, st, lum, shift) {
  const { cy } = PV;
  const xa = st.stentX0 + shift, xb = st.stentX1 + shift;
  const ring = 34;
  ctx.save(); ctx.strokeStyle = '#e4ebf7'; ctx.lineWidth = 3.2; ctx.lineJoin = 'round';
  for (let x = xa; x < xb - 2; x += ring) {
    ctx.beginPath();
    const steps = 8;
    for (let k = 0; k <= steps; k++) {
      const xx = x + (k % 2 ? ring * 0.5 : 0);
      const rr = Math.min(st.stentR(x - shift), PV.R * 1.05);
      const top = Math.max(cy - rr, lum.lumTop(xx) + 1), bot = Math.min(cy + rr, lum.lumBot(xx) - 1);
      const yy = lerp(top, bot, k / steps);
      k ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    }
    ctx.stroke();
  }
  ctx.beginPath();
  for (const sgn of [-1, 1]) {
    ctx.moveTo(xa, cy + sgn * Math.min(st.stentR(xa - shift), PV.R));
    for (let x = xa; x <= xb; x += 6) { const rr = Math.min(st.stentR(x - shift), PV.R * 1.05); const y = sgn < 0 ? Math.max(cy - rr, lum.lumTop(x) + 1) : Math.min(cy + rr, lum.lumBot(x) - 1); ctx.lineTo(x, y); }
  }
  ctx.globalAlpha *= 0.6; ctx.stroke();
  ctx.restore();
}
function gaugeDial(ctx, g, x, y, a) {
  alpha(ctx, a, () => {
    const r = 92;
    const angOf = v => Math.PI * 0.75 + (v / 20) * Math.PI * 1.5;
    circle(ctx, x, y, r + 18, '#0b1326', C.line, 2);
    ctx.save(); ctx.strokeStyle = 'rgba(140,160,210,0.35)'; ctx.lineWidth = 2;
    for (let v = 0; v <= 20; v += 2) { const a2 = angOf(v); ctx.beginPath(); ctx.moveTo(x + Math.cos(a2) * (r - 10), y + Math.sin(a2) * (r - 10)); ctx.lineTo(x + Math.cos(a2) * r, y + Math.sin(a2) * r); ctx.stroke(); }
    ctx.lineWidth = 10; ctx.strokeStyle = C.amber; ctx.beginPath(); ctx.arc(x, y, r - 22, angOf(0), angOf(Math.max(0.01, g.atm))); ctx.stroke();
    ctx.restore();
    txt(ctx, `${g.atm.toFixed(0)}`, x, y + 12, { size: 50, w: 800, align: 'center' });
    txt(ctx, 'atm', x, y + 48, { size: 20, color: C.muted, align: 'center' });
    if (g.target) txt(ctx, `inflation ${g.n}/${g.of}: ${g.target} atm × ${g.secs} s`, x - r - 40, y - 34, { size: 26, w: 700, color: C.amber, align: 'right' });
    txt(ctx, g.label, x - r - 40, y + 6, { size: 24, color: C.muted, align: 'right' });
  });
}
const PCI_STEPS = ['Engage', 'Check angio', 'Wire', 'Pre-dilate', 'Stent', 'Post-dilate', 'Final check'];
const PCI_BEAT_STEP = { p1: 0, p2: 1, p3: 2, p4: 3, p5: 4, p6: 4, p7: 5, p8: 6, p9: 6 };
const PCI_CAPTION = {
  p1: 'Engage the LCA with a 6F EBU 3.5 · coaxial · pressure not damped',
  p2: 'Check angiogram: critical lesion · choose a working view',
  p3: '0.014″ BMW: shape the tip · torque across · park distally',
  p4: '2.0 × 10 mm balloon: 8, 10, 10 atm for 10, 10, 8 s',
  p5: '2.5 × 24 mm DES: markers across the lesion · healthy landing zones',
  p6: 'Deploy: 14, then 16 atm for 10 and 12 s',
  p7: '2.5 × 10 mm NC balloon: 14 atm for 12 s, inside the stent',
  p8: 'TIMI 3 · no flap · no dissection · no thrombus',
  p9: 'Successful PCI to the LAD with a 2.5 × 24 mm DES',
};
SCENES.pci = (ctx, S) => {
  const { t } = S;
  const st = pciState(S);
  alpha(ctx, ep(t, 0.2, 0.6), () => {
    ctx.save(); rrect(ctx, 40, 150, 1840, 590, 24); ctx.clip();
    ctx.fillStyle = '#0a1122'; ctx.fillRect(40, 150, 1840, 590);
    const lum = drawVessel(ctx, S, st);
    // guide catheter
    ctx.save(); ctx.lineCap = 'butt'; ctx.strokeStyle = '#7f92c2'; ctx.lineWidth = 34; ctx.beginPath(); ctx.moveTo(-100, PV.cy); ctx.lineTo(st.guideX, PV.cy); ctx.stroke();
    ctx.strokeStyle = '#0a1122'; ctx.lineWidth = 18; ctx.beginPath(); ctx.moveTo(-100, PV.cy); ctx.lineTo(st.guideX - 4, PV.cy); ctx.stroke(); ctx.restore();
    txt(ctx, 'guide', Math.max(90, st.guideX - 60), PV.cy - 34, { size: 20, color: C.muted, align: 'center', a: ep(t, 0.6) });
    // wire
    if (st.wireOn) {
      ctx.save(); ctx.strokeStyle = '#eaf6ff'; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(-100, PV.cy); ctx.lineTo(st.wireTip - 18, PV.cy); ctx.quadraticCurveTo(st.wireTip, PV.cy, st.wireTip + 4, PV.cy - 16); ctx.stroke(); ctx.restore();
    }
    if (st.stentOn) {
      const sb = st.balloons.find(b => b.stentBalloon);
      if (sb) drawBalloon(ctx, sb, lum);
      drawStent(ctx, st, lum, sb ? sb.cx - PV.Lc : 0);
    }
    st.balloons.filter(b => !b.stentBalloon).forEach(b => drawBalloon(ctx, b, lum));
    ctx.restore();
    rrect(ctx, 40, 150, 1840, 590, 24); ctx.lineWidth = 2; ctx.strokeStyle = C.line; ctx.stroke();
  });
  // annotations on the vessel
  label(ctx, PV.Lc, PV.cy - PV.R + 14, 470, 250, 'critical lesion', C.red, life(t, S.at('p2', 0.05), S.B('p3')));
  label(ctx, PV.Lc + 120, PV.cy + PV.R + 110, PV.Lc + 330, 690, 'septal branch (S2)', C.muted, life(t, S.at('p2', 0.25), S.B('p3')) + life(t, S.at('p8', 0.62), null));
  fadeUp(ctx, t, S.at('p2', 0.5), () => { if (t < S.B('p3')) pill(ctx, 1380, 205, 'working view: no overlap · no foreshortening', { size: 24, color: C.cyan, align: 'center', fill: 'rgba(10,15,30,0.86)' }); });
  alpha(ctx, life(t, S.at('p3', 0.55), S.B('p4')), () => {
    label(ctx, 1784, PV.cy - 16, 1700, 205, 'keep the tip in view', C.amber, 1, { align: 'right' });
  });
  alpha(ctx, life(t, S.at('p5', 0.3), S.B('p6')), () => {
    for (const [a0, a1] of [[PV.Lc - 200, PV.Lc - PV.Lh + 10], [PV.Lc + PV.Lh - 10, PV.Lc + 200]]) {
      rrect(ctx, a0, PV.cy - PV.R - 40, a1 - a0, 2 * PV.R + 80, 10); ctx.lineWidth = 4; ctx.strokeStyle = C.green; ctx.stroke();
    }
    pill(ctx, PV.Lc, 205, 'healthy landing zone · lesion · healthy landing zone', { size: 24, color: C.green, align: 'center', fill: 'rgba(10,15,30,0.86)' });
  });
  // final checks
  const checks = ['TIMI 3 flow', 'no flap', 'no dissection', 'no thrombus', 'stent edges', 'septal branch fills'];
  alpha(ctx, life(t, S.B('p8'), null), () => {
    panel(ctx, 1290, 770, 550, 226, { fill: 'rgba(10,15,30,0.9)', stroke: rgba(C.green, 0.6) });
    txt(ctx, 'in ≥ 2 orthogonal views', 1318, 812, { size: 24, w: 700, color: C.green });
    checks.forEach((c, i) => {
      const k = ep(t, S.at('p8', 0.12 + i * 0.12), 0.4), x = 1318 + (i % 2) * 262, y = 860 + Math.floor(i / 2) * 46;
      checkMark(ctx, x + 12, y - 8, 22, k, C.green, 4); txt(ctx, c, x + 40, y, { size: 23, a: 0.3 + 0.7 * k });
    });
  });
  fadeUp(ctx, t, S.B('p9'), () => {
    panel(ctx, 460, 300, 1000, 230, { fill: 'rgba(10,15,30,0.95)', stroke: rgba(C.green, 0.8) });
    txt(ctx, 'IMPRESSION', 960, 360, { size: 24, w: 700, color: C.green, align: 'center', spacing: 3 });
    txt(ctx, 'Successful PCI to the LAD', 960, 428, { size: 48, w: 800, align: 'center' });
    txt(ctx, 'with a 2.5 × 24 mm drug-eluting stent', 960, 482, { size: 32, color: C.muted, align: 'center' });
  });
  // bottom band: steps, caption, gauge
  const beat = S.current();
  const stepIdx = PCI_BEAT_STEP[beat] ?? 0;
  alpha(ctx, ep(t, 0.3), () => {
    let x = 80;
    PCI_STEPS.forEach((s, i) => {
      const cur = i === stepIdx, done = i < stepIdx;
      const w = pill(ctx, x, 950, `${i + 1}  ${s}`, { size: 22, color: cur ? C.amber : done ? C.green : C.dim, fill: cur ? rgba(C.amber, 0.18) : 'rgba(20,30,55,0.6)', padX: 16 });
      x += w + 12;
    });
    const cap = PCI_CAPTION[beat];
    if (cap) fadeUp(ctx, t, S.B(beat), () => txt(ctx, cap, 80, 870, { size: 34, w: 700 }), 0.4, 10);
  });
  const g = st.gauge;
  if (g) gaugeDial(ctx, g, 1720, 880, 1);
  else if (t < S.B('p3')) {
    alpha(ctx, life(t, S.at('p1', 0.3), S.B('p3')), () => {
      const x0 = 1480, y0 = 800, w = 360;
      txt(ctx, 'guide pressure: not damped', x0 + w, y0 - 14, { size: 22, color: C.green, align: 'right' });
      ctx.save(); ctx.strokeStyle = C.green; ctx.lineWidth = 3; ctx.beginPath();
      for (let i = 0; i <= w; i += 3) { const ph = ((i / w) * 2.5 + t) % 1; const y = y0 + 140 - (aorticPressure(ph, 0) - 60) * 1.3; i ? ctx.lineTo(x0 + i, y) : ctx.moveTo(x0 + i, y); }
      ctx.stroke(); ctx.restore();
    });
  }
};

// ─── complications ───
function compIcon(ctx, kind, x, y, t) {
  ctx.save(); ctx.translate(x, y);
  const vessel = (y0 = 0) => { rrect(ctx, -150, y0 - 26, 300, 52, 26); ctx.fillStyle = C.wall; ctx.fill(); rrect(ctx, -150, y0 - 16, 300, 32, 16); ctx.fillStyle = C.lumen; ctx.fill(); };
  if (kind === 'noreflow') {
    vessel();
    for (let i = 0; i < 5; i++) { const xx = -150 + ((t * 40 + i * 70) % 300); ctx.fillStyle = rgba(C.cyan, 0.5); ctx.fillRect(xx, -6, 16, 12); }
  } else if (kind === 'dissection') {
    vessel();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-10, -16); ctx.bezierCurveTo(20, -4, 40, 10, 70, 16); ctx.stroke();
    ctx.strokeStyle = '#e4ebf7'; ctx.lineWidth = 2; for (let i = -110; i < -20; i += 16) { ctx.beginPath(); ctx.moveTo(i, -14); ctx.lineTo(i + 8, 0); ctx.lineTo(i, 14); ctx.stroke(); }
  } else if (kind === 'perforation') {
    vessel();
    const k = 0.6 + 0.4 * Math.sin(t * 3);
    ctx.beginPath(); ctx.ellipse(40, -44, 34 * k + 10, 18 * k + 6, 0, 0, Math.PI * 2); ctx.fillStyle = rgba(C.cyan, 0.55); ctx.fill();
    rrect(ctx, -30, -16, 110, 32, 12); ctx.fillStyle = rgba(C.violet, 0.8); ctx.fill();
  } else if (kind === 'sidebranch') {
    ctx.strokeStyle = C.wall; ctx.lineWidth = 34; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(80, 48); ctx.stroke();
    ctx.strokeStyle = C.lumen; ctx.lineWidth = 16; ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(80, 48); ctx.stroke();
    vessel();
    ctx.strokeStyle = '#e4ebf7'; ctx.lineWidth = 2; for (let i = -90; i < 90; i += 16) { ctx.beginPath(); ctx.moveTo(i, -14); ctx.lineTo(i + 8, 0); ctx.lineTo(i, 14); ctx.stroke(); }
    ctx.fillStyle = rgba(C.cyan, 0.5); ctx.beginPath(); ctx.moveTo(30, 18); ctx.lineTo(70, 44); ctx.lineTo(62, 52); ctx.lineTo(24, 26); ctx.fill();
  } else if (kind === 'wrist') {
    ctx.strokeStyle = C.skin; ctx.lineWidth = 70; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(-140, 0); ctx.lineTo(130, 0); ctx.stroke();
    rrect(ctx, -30, -46, 70, 92, 12); ctx.fillStyle = rgba(C.cyan, 0.45); ctx.fill(); ctx.strokeStyle = C.cyan; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = C.red; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(-140, -14); ctx.lineTo(130, -14); ctx.stroke();
    for (let i = 0; i < 3; i++) { const xx = -140 + ((t * 80 + i * 90) % 270); arrow(ctx, xx, -14, xx + 22, -14, { color: '#ffd0d6', lw: 3, head: 8 }); }
  }
  ctx.restore();
}
SCENES.complications = (ctx, S) => {
  const { t } = S;
  fadeUp(ctx, t, 0.3, () => {
    txt(ctx, 'Know your first move', 80, 196, { size: 54, w: 800 });
    txt(ctx, 'before the case starts, not during it', 82, 244, { size: 30, color: C.muted });
  });
  const cards = [
    ['noreflow', 'Slow flow / no-reflow', 'Exclude dissection → IC adenosine, verapamil or nitroprusside', C.cyan, 'x2'],
    ['dissection', 'Edge dissection', 'Assess in two views · flow-limiting → another stent', C.violet, 'x3'],
    ['perforation', 'Perforation', 'Balloon at the site now → covered stent or coils · echo for tamponade · pericardiocentesis · heparin reversal = senior call', C.red, 'x4'],
    ['sidebranch', 'Side-branch loss', 'We stented across S2 — confirm it still fills', C.amber, 'x5'],
    ['wrist', 'Wrist', 'Spasm · hematoma · radial occlusion → band with patent hemostasis', C.green, 'x6'],
  ];
  cards.forEach(([kind, title, body, col, b], i) => {
    const cx = 80 + (i % 3) * 600, cy = 290 + Math.floor(i / 3) * 350;
    fadeUp(ctx, t, S.B(b) - 0.1, () => {
      const cur = t < (S.B(b) + S.D(b) + 0.4) ? 1 : 0;
      panel(ctx, cx, cy, 560, 330, { stroke: rgba(col, 0.35 + 0.55 * cur) });
      compIcon(ctx, kind, cx + 280, cy + 78, t);
      txt(ctx, title, cx + 34, cy + 170, { size: 32, w: 700, color: col });
      txt(ctx, body, cx + 34, cy + 212, { size: 23, maxW: 500, color: C.text, lh: 1.32 });
    });
  });
  fadeUp(ctx, t, S.at('x1', 0.4), () => {
    const cx = 80 + 2 * 600, cy = 290 + 350;
    panel(ctx, cx, cy, 560, 330, { fill: rgba(C.amber, 0.08), stroke: rgba(C.amber, 0.6) });
    txt(ctx, 'Before you start', cx + 34, cy + 70, { size: 32, w: 700, color: C.amber });
    ['bail-out kit located', 'drugs drawn up / labelled', 'team knows the plan'].forEach((s, i) => { checkMark(ctx, cx + 50, cy + 128 + i * 60, 24, 1, C.amber, 4); txt(ctx, s, cx + 84, cy + 138 + i * 60, { size: 26 }); });
  });
};

// ─── finish ───
SCENES.finish = (ctx, S) => {
  const { t } = S;
  fadeUp(ctx, t, 0.3, () => {
    panel(ctx, 80, 170, 860, 800);
    txt(ctx, 'AFTER THE CASE', 116, 226, { size: 24, w: 700, color: C.cyan, spacing: 3 });
  });
  const meds = [
    ['DAPT per protocol', 'aspirin + clopidogrel after a lytic', C.cyan, S.at('e1', 0.3)],
    ['High-intensity statin', '', C.text, S.at('e2', 0.02)],
    ['ACE inhibitor', 'diabetes · reduced EF', C.text, S.at('e2', 0.18)],
    ['Beta-blocker', 'where indicated', C.text, S.at('e2', 0.42)],
    ['SGLT2 inhibitor', 'type 2 diabetes', C.text, S.at('e2', 0.56)],
    ['Repeat echo · cardiac rehab', '', C.green, S.at('e2', 0.76)],
  ];
  meds.forEach(([m, sub, col, t0], i) => fadeUp(ctx, t, t0, () => {
    const y = 300 + i * 108;
    rrect(ctx, 116, y - 34, 788, 88, 16); ctx.fillStyle = rgba(col === C.text ? C.muted : col, 0.1); ctx.fill();
    circle(ctx, 150, y + 10, 10, col === C.text ? C.muted : col);
    txt(ctx, m, 180, y + 8, { size: 30, w: 700, color: col });
    if (sub) txt(ctx, sub, 180, y + 42, { size: 22, color: C.muted });
  }));
  fadeUp(ctx, t, S.B('e3') - 0.1, () => {
    panel(ctx, 980, 170, 860, 800);
    txt(ctx, 'DOCUMENTATION', 1016, 226, { size: 24, w: 700, color: C.amber, spacing: 3 });
    txt(ctx, 'In this note', 1016, 290, { size: 28, w: 700, color: C.green });
  });
  const good = ['every device + size', 'every inflation: pressure + time', 'final result: TIMI 3, no flap / dissection / thrombus'];
  good.forEach((s, i) => fadeUp(ctx, t, S.at('e3', 0.3 + i * 0.2), () => { checkMark(ctx, 1036, 338 + i * 52, 24, 1, C.green, 4); txt(ctx, s, 1070, 347 + i * 52, { size: 25 }); }));
  fadeUp(ctx, t, S.B('e4'), () => txt(ctx, 'Add to make it complete', 1016, 530, { size: 28, w: 700, color: C.amber }));
  const add = ['heparin dose + ACT', 'total contrast volume', 'fluoroscopy time + radiation dose', 'TIMI flow & % stenosis, pre and post', 'device lot numbers', 'explicit complications statement'];
  add.forEach((s, i) => fadeUp(ctx, t, S.at('e4', 0.12 + i * 0.13), () => { txt(ctx, '+', 1030, 582 + i * 60, { size: 34, w: 800, color: C.amber, align: 'center' }); txt(ctx, s, 1070, 580 + i * 60, { size: 25 }); }));
};

// ─── learning ───
SCENES.learning = (ctx, S) => {
  const { t } = S;
  const beats = ['l2', 'l3', 'l4', 'l5', 'l6'];
  const rungs = [
    ['Anatomy & views', 'read the film before the report · write findings → compare · 50 films'],
    ['Hardware fluency', 'size · compatibility · why this device · prep balloons, load stents'],
    ['Simulator & bench', 'wire torque · balloon prep · no-reflow & perforation drills'],
    ['Graded hands-on', 'access → diagnostics → wiring & balloons → stenting, supervised'],
    ['Personal case log', 'your private evaluation, and it compounds'],
  ];
  fadeUp(ctx, t, 0.3, () => txt(ctx, 'Climb one rung at a time', 80, 220, { size: 54, w: 800 }));
  // ladder
  const lx = 150, ly0 = 940, step = 150;
  alpha(ctx, ep(t, 0.5, 0.8), () => {
    ctx.save(); ctx.strokeStyle = '#3a4a78'; ctx.lineWidth = 12; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(lx, ly0 + 20); ctx.lineTo(lx + 20, 280); ctx.moveTo(lx + 180, ly0 + 20); ctx.lineTo(lx + 200, 280); ctx.stroke(); ctx.restore();
  });
  const cur = beats.findIndex((b, i) => t >= S.B(b) - 0.2 && (i === beats.length - 1 || t < S.B(beats[i + 1]) - 0.2));
  beats.forEach((b, i) => {
    const k = ep(t, S.B(b) - 0.2, 0.5);
    const y = ly0 - 60 - i * step;
    const isCur = i === cur;
    alpha(ctx, ep(t, 0.6 + i * 0.1), () => {
      ctx.save(); ctx.lineCap = 'round'; ctx.lineWidth = 12;
      ctx.strokeStyle = k > 0 ? mix('#3a4a78', C.green, k) : '#3a4a78';
      if (isCur) { ctx.shadowColor = C.green; ctx.shadowBlur = 24; }
      ctx.beginPath(); ctx.moveTo(lx + 4 + i * 3.5, y); ctx.lineTo(lx + 184 + i * 3.5, y); ctx.stroke(); ctx.restore();
      txt(ctx, String(i + 1), lx + 94, y - 18, { size: 26, w: 800, color: k > 0 ? C.green : C.dim, align: 'center' });
    });
  });
  beats.forEach((b, i) => fadeUp(ctx, t, S.B(b) - 0.2, () => {
    const y = 300 + i * 96, isCur = i === cur;
    txt(ctx, `${i + 1}  ${rungs[i][0]}`, 480, y, { size: isCur ? 38 : 30, w: 800, color: isCur ? C.green : mix(C.muted, C.text, 0.3) });
    txt(ctx, rungs[i][1], 480, y + 38, { size: 23, color: isCur ? C.text : C.dim });
  }));
  fadeUp(ctx, t, S.at('l6', 0.12), () => {
    const x0 = 480, y0 = 770;
    panel(ctx, x0, y0, 1360, 210, { fill: rgba(C.green, 0.07), stroke: rgba(C.green, 0.6) });
    txt(ctx, 'CASE LOG — one entry per case', x0 + 30, y0 + 46, { size: 22, w: 700, color: C.green, spacing: 2 });
    const rows = [['Before', 'plan + prediction', 0.18], ['After', 'what happened · what surprised you', 0.32], ['Change', 'one thing to do differently', 0.46], ['Track', 'access success · contrast mL · fluoro time', 0.62]];
    rows.forEach(([k, v, f], i) => fadeUp(ctx, t, S.at('l6', f), () => {
      const cx = x0 + 30 + (i % 2) * 660, cy = y0 + 110 + Math.floor(i / 2) * 58;
      txt(ctx, k, cx, cy, { size: 25, w: 800, color: C.amber });
      txt(ctx, v, cx + 120, cy, { size: 25 });
    }));
  });
};

// ─── recap ───
SCENES.recap = (ctx, S) => {
  const { t } = S;
  const labels = ['Patient & indication', 'Pre-cath checklist', 'Access', 'Diagnostic angiogram', 'Reading & planning', 'The PCI', 'Finishing well'];
  const endK = ep(t, S.B('z2') - 0.1, 0.7);
  alpha(ctx, 1 - endK, () => {
    fadeUp(ctx, t, 0.2, () => txt(ctx, 'The seven steps', W / 2, 240, { size: 54, w: 800, align: 'center' }));
    labels.forEach((s, i) => {
      const row = i < 4 ? 0 : 1, col = i < 4 ? i : i - 4;
      const n = row ? 3 : 4, cw = 390, gap = 30;
      const x = W / 2 - (n * cw + (n - 1) * gap) / 2 + col * (cw + gap), y = 360 + row * 200;
      const k = ep(t, S.at('z1', 0.12 + i * 0.12), 0.5);
      fadeUp(ctx, t, S.at('z1', 0.12 + i * 0.12) - 0.3, () => {
        panel(ctx, x, y, cw, 160, { fill: mix(C.panel, C.amber, 0.1 * k), stroke: mix(C.line, C.amber, k) });
        txt(ctx, String(i + 1), x + 34, y + 96, { size: 64, w: 800, color: mix(C.dim, C.amber, k) });
        txt(ctx, s, x + 100, y + 92, { size: 29, w: 700, maxW: 270, lh: 1.15 });
      });
    });
  });
  alpha(ctx, endK, () => {
    txt(ctx, 'Use it on your next case —', W / 2, 460, { size: 64, w: 800, align: 'center' });
    txt(ctx, 'and every case after it.', W / 2, 545, { size: 64, w: 800, align: 'center', color: C.cyan });
    txt(ctx, 'See you in the lab.', W / 2, 650, { size: 40, w: 600, align: 'center', color: C.amber });
    txt(ctx, 'De-identified teaching case · not a substitute for supervised training or your lab’s protocols · narration: synthetic voice', W / 2, 900, { size: 21, color: C.dim, align: 'center' });
  });
};

// ═════════════════════════════ frame ═════════════════════════════
let TIM = null;
function timings() { return TIM || (TIM = JSON.parse(fs.readFileSync(path.join(BUILD, 'timings.json'), 'utf8'))); }
function sceneAt(T) {
  const sc = timings().scenes;
  for (const s of sc) if (T < s.start + s.dur) return s;
  return sc[sc.length - 1];
}
function makeS(scene, T) {
  const t = T - scene.start;
  const b = scene.beats;
  const ids = Object.keys(b);
  const S = {
    t, dur: scene.dur,
    B: id => { if (!b[id]) throw new Error(`no beat ${id} in ${scene.id}`); return b[id].start; },
    D: id => b[id].dur,
    at: (id, f) => b[id].start + f * b[id].dur,
    current: () => { let c = ids[0]; for (const id of ids) if (t >= b[id].start - 0.25) c = id; return c; },
  };
  return S;
}
function renderAt(ctx, T) {
  ctx.globalAlpha = 1;
  ctx.drawImage(background(), 0, 0);
  const scene = sceneAt(T);
  const S = makeS(scene, T);
  const fade = Math.min(ep(S.t, 0, 0.45), 1 - prog(S.t, scene.dur - 0.45, 0.45));
  ctx.save(); ctx.globalAlpha = fade;
  SCENES[scene.id](ctx, S);
  ctx.restore();
  header(ctx, scene.step, 1);
  footer(ctx, scene.step, T, timings().total);
}

// ═════════════════════════════ cli ═════════════════════════════
function ffmpeg(args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: [opts.stdin ? 'pipe' : 'ignore', 'inherit', 'inherit'] });
    p.on('exit', c => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
    if (opts.stdin) opts.stdin(p);
  });
}
async function renderRange(f0, f1, out) {
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  let proc;
  const done = ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-g', '120', out],
  { stdin: p => { proc = p; } });
  const t0 = Date.now();
  for (let f = f0; f < f1; f++) {
    renderAt(ctx, f / FPS);
    const buf = Buffer.from(canvas.data());
    if (!proc.stdin.write(buf)) await new Promise(r => proc.stdin.once('drain', r));
    if ((f - f0) % 300 === 0) process.stderr.write(`[${path.basename(out)}] ${f - f0}/${f1 - f0} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
  proc.stdin.end();
  await done;
}
async function renderAll(workers) {
  const total = timings().total, N = Math.ceil(total * FPS);
  const chunk = Math.ceil(N / workers);
  const segs = [];
  const jobs = [];
  for (let i = 0; i < workers; i++) {
    const a = i * chunk, b = Math.min(N, (i + 1) * chunk);
    if (a >= b) break;
    const out = path.join(BUILD, `seg${i}.mp4`);
    segs.push(out);
    jobs.push(new Promise((res, rej) => {
      const p = spawn(process.execPath, [__filename, '--range', String(a), String(b), out], { stdio: 'inherit' });
      p.on('exit', c => (c === 0 ? res() : rej(new Error(`worker ${i} exited ${c}`))));
    }));
  }
  await Promise.all(jobs);
  fs.writeFileSync(path.join(BUILD, 'segments.txt'), segs.map(s => `file '${s}'`).join('\n') + '\n');
  await mux();
}
async function mux() {
  const out = path.join(BUILD, OUT_NAME);
  // no -shortest: it would also count the caption track and clip the end card
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', path.join(BUILD, 'segments.txt'), '-i', path.join(BUILD, 'narration.wav'), '-i', path.join(BUILD, 'captions.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'copy',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '96k', '-ar', '48000',
    '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-metadata', `title=Cath Lab Skills — pharmaco-invasive PCI to the LAD`,
    '-movflags', '+faststart', out]);
  console.log('wrote', out);
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === '--still') {
    const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
    for (let i = 0; i < rest.length; i += 2) {
      renderAt(ctx, parseFloat(rest[i]));
      fs.writeFileSync(rest[i + 1], canvas.toBuffer('image/png'));
    }
  } else if (mode === '--range') {
    await renderRange(parseInt(rest[0], 10), parseInt(rest[1], 10), rest[2]);
  } else if (mode === '--mux') {
    await mux();
  } else if (mode === '--all') {
    await renderAll(parseInt(rest[0] || String(Math.max(1, os.cpus().length)), 10));
  } else {
    console.log('usage: render.js --still <sec> <out.png> [...] | --range <f0> <f1> <out.mp4> | --all [workers] | --mux');
  }
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
