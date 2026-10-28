// お絵かきのツール
import { TILE, newCanvas } from './doc.js?v=20261028-6';
import { floodRegion } from './fill.js?v=20261028-6';

const hexToRgb = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };

/** 左右の端をまたいでも、直前の点に近い側の座標にそろえる */
function near(p, ref, W) {
  let x = p.x;
  while (x - ref.x > W / 2) x -= W;
  while (ref.x - x > W / 2) x += W;
  return { x, y: p.y };
}

/** 角度を 15° ごとにそろえる */
function snapAngle(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const step = Math.PI / 12;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

function bboxOf(points, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** 距離の表示（縮尺が決まっていれば km、なければピクセル） */
export function formatLength(px, kmPerPx) {
  if (kmPerPx) {
    const km = px * kmPerPx;
    return km >= 100 ? `${Math.round(km).toLocaleString('ja-JP')} km` : `${km.toFixed(km >= 10 ? 1 : 2)} km`;
  }
  return `${Math.round(px).toLocaleString('ja-JP')} px`;
}

/** 基準の点 ref を枠の中に置いたときの、ほかの点の画面位置（つながった図形がばらばらに回り込まないように） */
function screenFrom(board, ref) {
  const r = board.toScreen(ref.x, ref.y);
  const s = board.cam.s;
  return (x, y) => ({ x: r.x + (x - ref.x) * s, y: r.y + (y - ref.y) * s });
}

function label(o, text, x, y) {
  o.save();
  o.font = '600 12px "Zen Kaku Gothic New", system-ui, sans-serif';
  const w = o.measureText(text).width + 14;
  o.fillStyle = 'rgba(20,26,46,.85)';
  o.beginPath();
  o.roundRect?.(x - w / 2, y - 26, w, 20, 10);
  if (!o.roundRect) o.rect(x - w / 2, y - 26, w, 20);
  o.fill();
  o.fillStyle = '#eef1f6';
  o.textAlign = 'center';
  o.textBaseline = 'middle';
  o.fillText(text, x, y - 16);
  o.restore();
}

/* ---------- ペン・消しゴム ---------- */

class Brush {
  constructor(app, erase) { this.app = app; this.erase = erase; this.id = erase ? 'eraser' : 'pen'; }

  down(p, e) {
    const { app } = this;
    if (e.altKey && !this.erase && app.toolOn('eyedropper')) { app.tools.eyedropper.pick(p); return; }
    this.layer = app.target(this.erase ? '消しゴム' : 'ペン');
    if (!this.layer) return;
    app.history.begin(this.erase ? '消しゴム' : 'ペン');
    this.last = p;
    this.seg(p, p);
  }

  move(p) {
    if (!this.layer) return;
    p = near(p, this.last, this.app.doc.w);
    this.seg(this.last, p);
    this.last = p;
  }

  up() {
    if (!this.layer) return;
    this.layer = null;
    this.app.history.commit();
    this.app.edited();
  }

  cancel() {
    if (!this.layer) return;
    this.layer = null;
    this.app.history.abort();
  }

  seg(a, b) {
    const { app } = this;
    const size = app.size;
    app.doc.paint(this.layer, bboxOf([a, b], size / 2 + 2), (ctx) => {
      ctx.globalCompositeOperation = this.erase ? 'destination-out' : 'source-over';
      ctx.strokeStyle = this.erase ? '#000' : app.color;
      ctx.lineWidth = size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x + (a.x === b.x && a.y === b.y ? 0.01 : 0), b.y);
      ctx.stroke();
    });
    app.board.request();
  }

  overlay(o, board) {
    // マウスのときだけ、ペン先の大きさを円で表示
    if (!board.hover || this.layer) return;
    const s = board.toScreen(board.hover.x, board.hover.y);
    const r = Math.max(2, (this.app.size / 2) * board.cam.s);
    o.save();
    o.beginPath();
    o.arc(s.x, s.y, r, 0, Math.PI * 2);
    o.strokeStyle = 'rgba(0,0,0,.6)';
    o.lineWidth = 3;
    o.stroke();
    o.strokeStyle = '#fff';
    o.lineWidth = 1.2;
    o.stroke();
    o.restore();
  }
}

/* ---------- 定規（直線・折れ線） ---------- */

class Ruler {
  constructor(app) { this.app = app; this.id = 'line'; this.points = []; this.drag = null; this.lastTap = 0; }

  get poly() { return this.app.opts.poly; }
  get active() { return this.points.length > 0 || !!this.drag; }

  snapped(p, from, e) {
    p = near(p, from, this.app.doc.w);
    return this.app.opts.snap || e?.shiftKey ? snapAngle(from, p) : p;
  }

  down(p, e) {
    if (!this.poly) { this.drag = { a: p, b: p }; return; }
    const from = this.points.at(-1);
    this.drag = { a: from || p, b: from ? this.snapped(p, from, e) : p };
  }

  move(p, e) {
    if (!this.drag) return;
    this.drag.b = this.poly && !this.points.length ? p : this.snapped(p, this.drag.a, e);
    this.app.board.drawOverlay();
  }

  up(p, e) {
    if (!this.drag) return;
    const { a } = this.drag;
    const b = this.poly && !this.points.length ? p : this.snapped(p, a, e);
    this.drag = null;
    if (!this.poly) {
      if (Math.hypot(b.x - a.x, b.y - a.y) * this.app.board.cam.s < 3) { this.app.board.drawOverlay(); return; }
      this.commit([a, b]);
      return;
    }
    // 折れ線：タップで点を足す。同じ所をすばやく 2 回タップで確定
    const now = performance.now();
    const lastPt = this.points.at(-1);
    if (lastPt && now - this.lastTap < 350 && Math.hypot(b.x - lastPt.x, b.y - lastPt.y) * this.app.board.cam.s < 24) {
      this.finish();
      return;
    }
    this.lastTap = now;
    if (!lastPt || Math.hypot(b.x - lastPt.x, b.y - lastPt.y) * this.app.board.cam.s >= 3) this.points.push(this.points.length ? b : p);
    this.app.refreshOptions();
    this.app.board.drawOverlay();
  }

  hover(p, e) {
    if (this.poly && this.points.length) { this.preview = this.snapped(p, this.points.at(-1), e); }
  }

  cancel() { this.drag = null; this.app.board.drawOverlay(); }

  /** 折れ線を確定（点が 2 つ以上あれば描く） */
  finish() {
    const pts = this.points;
    this.points = [];
    this.preview = null;
    if (pts.length >= 2) this.commit(pts);
    this.app.refreshOptions();
    this.app.board.drawOverlay();
  }

  undoPoint() {
    this.points.pop();
    this.app.refreshOptions();
    this.app.board.drawOverlay();
  }

  discard() { this.points = []; this.drag = null; this.preview = null; this.app.refreshOptions(); this.app.board.drawOverlay(); }

  deactivate() { if (this.points.length >= 2) this.finish(); else this.discard(); }

  commit(pts) {
    const { app } = this;
    const layer = app.target('定規');
    if (!layer) return;
    app.history.begin('定規');
    app.doc.paint(layer, bboxOf(pts, app.size / 2 + 2), (ctx) => {
      ctx.strokeStyle = app.color;
      ctx.lineWidth = app.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (const q of pts.slice(1)) ctx.lineTo(q.x, q.y);
      ctx.stroke();
    });
    app.history.commit();
    app.edited();
    app.board.request();
  }

  length(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return d;
  }

  overlay(o, board) {
    const pts = [...this.points];
    if (this.drag) { if (!pts.length) pts.push(this.drag.a); pts.push(this.drag.b); }
    else if (this.preview && pts.length) pts.push(this.preview);
    if (!pts.length) return;
    const { app } = this;
    board.withMapTransform(o, () => {
      o.strokeStyle = app.color;
      o.lineWidth = app.size;
      o.lineCap = 'round';
      o.lineJoin = 'round';
      o.globalAlpha = 0.85;
      o.beginPath();
      o.moveTo(pts[0].x, pts[0].y);
      for (const q of pts.slice(1)) o.lineTo(q.x, q.y);
      o.stroke();
    });
    // 点と長さ
    const scr = screenFrom(board, pts[0]);
    o.save();
    for (const q of this.points) {
      const s = scr(q.x, q.y);
      o.beginPath(); o.arc(s.x, s.y, 4.5, 0, Math.PI * 2);
      o.fillStyle = '#fff'; o.fill(); o.strokeStyle = '#141a2e'; o.lineWidth = 1.5; o.stroke();
    }
    o.restore();
    if (pts.length >= 2) {
      const end = scr(pts.at(-1).x, pts.at(-1).y);
      label(o, formatLength(this.length(pts), app.kmPerPx), end.x, end.y - 6);
    }
  }
}

/* ---------- 図形 ---------- */

const HANDLE = 14;  // つまみをつかめる範囲（画面 px）

class Shapes {
  constructor(app) { this.app = app; this.id = 'shape'; this.shape = null; this.op = null; }

  get pending() { return !!this.shape && !this.op; }

  /** 正方形・正円にそろえた枠 */
  box(s) {
    let { x0, y0, x1, y1 } = s;
    if (s.lock && !isSeg(s)) {
      const w = x1 - x0, h = y1 - y0;
      const k = s.type === 'triangle' ? 2 / Math.sqrt(3) : 1;  // 正三角形
      const size = Math.max(Math.abs(w), Math.abs(h) * k);
      x1 = x0 + Math.sign(w || 1) * size;
      y1 = y0 + Math.sign(h || 1) * size / k;
    }
    return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), ax: x0, ay: y0, bx: x1, by: y1 };
  }

  down(p) {
    const { board } = this.app;
    if (this.shape) {
      // つまみ・図形の中なら調整。外なら確定
      const b = this.box(this.shape);
      const hit = this.hitHandle(p);
      if (hit) { this.op = { kind: 'resize', which: hit }; return; }
      const inside = isSeg(this.shape)
        ? distToSeg(p, { x: this.shape.x0, y: this.shape.y0 }, { x: this.shape.x1, y: this.shape.y1 }) * board.cam.s < 16
        : p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
      if (inside) { this.op = { kind: 'move', from: p, orig: { ...this.shape } }; return; }
      this.commit();
      this.skipUp = true;
      return;
    }
    const o = this.app.opts;
    this.shape = { type: o.shape, style: o.style, lock: o.lock, both: o.arrowBoth, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    this.op = { kind: 'create' };
  }

  move(p) {
    if (!this.shape || !this.op) return;
    const s = this.shape;
    const W = this.app.doc.w;
    if (this.op.kind === 'create') { const q = near(p, { x: s.x0 }, W); s.x1 = q.x; s.y1 = p.y; }
    if (this.op.kind === 'move') {
      const q = near(p, this.op.from, W);
      const dx = q.x - this.op.from.x, dy = q.y - this.op.from.y;
      Object.assign(s, { x0: this.op.orig.x0 + dx, x1: this.op.orig.x1 + dx, y0: this.op.orig.y0 + dy, y1: this.op.orig.y1 + dy });
    }
    if (this.op.kind === 'resize') {
      const q = near(p, { x: (s.x0 + s.x1) / 2 }, W);
      const w = this.op.which;
      if (isSeg(s)) {
        if (w === 'a') { s.x0 = q.x; s.y0 = q.y; } else { s.x1 = q.x; s.y1 = q.y; }
      } else {
        // 向かい合う角を固定して動かす
        const b = this.box(s);
        const fx = w.includes('l') ? b.x1 : b.x0, fy = w.includes('t') ? b.y1 : b.y0;
        Object.assign(s, { x0: fx, y0: fy, x1: q.x, y1: q.y });
      }
    }
    this.app.board.drawOverlay();
  }

  up() {
    if (this.skipUp) { this.skipUp = false; return; }
    if (!this.shape || !this.op) return;
    const kind = this.op.kind;
    this.op = null;
    if (kind === 'create') {
      const s = this.shape;
      if (Math.hypot(s.x1 - s.x0, s.y1 - s.y0) * this.app.board.cam.s < 4) { this.shape = null; }
      else if (s.lock && !isSeg(s)) { const b = this.box(s); Object.assign(s, { x0: b.ax, y0: b.ay, x1: b.bx, y1: b.by, lock: false }); }
    }
    this.app.refreshOptions();
    this.app.board.drawOverlay();
  }

  cancel() {
    if (this.op?.kind === 'create') this.shape = null;
    else if (this.op?.kind === 'move') Object.assign(this.shape, this.op.orig);
    this.op = null;
    this.app.refreshOptions();
    this.app.board.drawOverlay();
  }

  discard() { this.shape = null; this.op = null; this.app.refreshOptions(); this.app.board.drawOverlay(); }

  deactivate() { if (this.shape) this.commit(); }

  handles() {
    const s = this.shape;
    if (isSeg(s)) return { a: { x: s.x0, y: s.y0 }, b: { x: s.x1, y: s.y1 } };
    const b = this.box(s);
    return { tl: { x: b.x0, y: b.y0 }, tr: { x: b.x1, y: b.y0 }, bl: { x: b.x0, y: b.y1 }, br: { x: b.x1, y: b.y1 } };
  }

  hitHandle(p) {
    const s = this.app.board.cam.s;
    for (const [k, h] of Object.entries(this.handles())) {
      const q = near(p, h, this.app.doc.w);
      if (Math.hypot(q.x - h.x, q.y - h.y) * s < HANDLE) return k;
    }
    return null;
  }

  /** 図形の形を ctx に描く（地図の座標） */
  trace(ctx, s, size) {
    const { app } = this;
    const b = this.box(s);
    const color = app.color;
    ctx.lineWidth = size;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    if (s.type === 'line') {
      ctx.beginPath();
      ctx.moveTo(s.x0, s.y0);
      ctx.lineTo(s.x1, s.y1);
      ctx.stroke();
      return;
    }
    if (s.type === 'arrow') {
      const head = Math.max(size * 4, 16);
      const drawHead = (fx, fy, tx, ty) => {
        const ang = Math.atan2(ty - fy, tx - fx);
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - head * Math.cos(ang - 0.45), ty - head * Math.sin(ang - 0.45));
        ctx.lineTo(tx - head * Math.cos(ang + 0.45), ty - head * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
        ctx.stroke();
      };
      const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0) || 1;
      const ux = (s.x1 - s.x0) / len, uy = (s.y1 - s.y0) / len;
      const back = head * 0.8;
      ctx.beginPath();
      ctx.moveTo(s.x0 + (s.both ? ux * back : 0), s.y0 + (s.both ? uy * back : 0));
      ctx.lineTo(s.x1 - ux * back, s.y1 - uy * back);
      ctx.stroke();
      drawHead(s.x0, s.y0, s.x1, s.y1);
      if (s.both) drawHead(s.x1, s.y1, s.x0, s.y0);
      return;
    }
    ctx.beginPath();
    if (s.type === 'rect') ctx.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    if (s.type === 'ellipse') ctx.ellipse((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.x1 - b.x0) / 2, (b.y1 - b.y0) / 2, 0, 0, Math.PI * 2);
    if (s.type === 'triangle') { ctx.moveTo((b.x0 + b.x1) / 2, b.y0); ctx.lineTo(b.x1, b.y1); ctx.lineTo(b.x0, b.y1); ctx.closePath(); }
    if (s.style !== 'stroke') {
      ctx.fillStyle = s.style === 'both' ? rgba(color, 0.35) : color;
      ctx.fill();
    }
    if (s.style !== 'fill') ctx.stroke();
  }

  commit() {
    const s = this.shape;
    this.shape = null;
    this.op = null;
    if (!s) return;
    const { app } = this;
    const layer = app.target('図形');
    if (layer) {
      const b = this.box(s);
      const pad = app.size + Math.max(app.size * 4, 16);
      app.history.begin('図形');
      app.doc.paint(layer, { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad }, (ctx) => this.trace(ctx, s, app.size));
      app.history.commit();
      app.edited();
    }
    app.refreshOptions();
    app.board.request();
  }

  overlay(o, board) {
    if (!this.shape) return;
    const s = this.shape;
    board.withMapTransform(o, () => {
      o.globalAlpha = 0.9;
      this.trace(o, s, this.app.size);
    });
    if (this.op?.kind === 'create') return;
    // 調整用の枠とつまみ
    const hs = Object.values(this.handles());
    const scr = screenFrom(board, hs[0]);
    o.save();
    if (!isSeg(s)) {
      const b = this.box(s);
      const p0 = scr(b.x0, b.y0), p1 = scr(b.x1, b.y1);
      o.setLineDash([5, 4]);
      o.strokeStyle = 'rgba(255,255,255,.9)';
      o.lineWidth = 1;
      o.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
      o.setLineDash([]);
    }
    for (const h of hs) {
      const q = scr(h.x, h.y);
      o.beginPath();
      o.arc(q.x, q.y, 7, 0, Math.PI * 2);
      o.fillStyle = '#fff';
      o.fill();
      o.strokeStyle = '#c9a24a';
      o.lineWidth = 2.5;
      o.stroke();
    }
    o.restore();
  }
}

/** 矢印・直線（2 点で決まる図形） */
const isSeg = (s) => s.type === 'arrow' || s.type === 'line';

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* ---------- 塗りつぶし ---------- */

class Fill {
  constructor(app) { this.app = app; this.id = 'fill'; }

  down(p) { this.start = p; }

  async up(p) {
    if (!this.start) return;
    const s = this.start;
    this.start = null;
    if (Math.hypot(p.x - s.x, p.y - s.y) * this.app.board.cam.s > 10) return;  // ドラッグは無視
    await this.fill(s);
  }

  cancel() { this.start = null; }

  async fill(p) {
    const { app } = this;
    const { doc } = app;
    if (p.y < 0 || p.y >= doc.h || app.busy) return;
    const layer = app.target('塗りつぶし');
    if (!layer) return;
    app.setBusy('塗っています…');
    await new Promise((r) => setTimeout(r, 16));  // 表示を先に更新
    try {
      const ref = app.opts.fillRef === 'layer' ? doc.layerCanvas(layer) : doc.composite(1);
      const data = ref.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.w, doc.h).data;
      ref.width = ref.height = 0;
      const tol = Math.round((app.opts.tolerance / 100) * 255);
      const region = floodRegion(data, doc.w, doc.h, p.x, p.y, tol);
      if (!region || !region.count) return;
      // このレイヤーだけを見るときは、線のふちの薄い部分まで 1px 広げて塗る
      if (app.opts.fillRef === 'layer') dilate(region, doc.w, doc.h);
      const [r, g, b] = hexToRgb(app.color);
      app.history.begin('塗りつぶし');
      const tmp = newCanvas(TILE, TILE);
      const tctx = tmp.getContext('2d');
      const img = tctx.createImageData(TILE, TILE);
      const touched = [];
      for (let ty = Math.floor(region.y0 / TILE); ty <= Math.floor(region.y1 / TILE); ty++) {
        for (let tx = Math.floor(region.x0 / TILE); tx <= Math.floor(region.x1 / TILE); tx++) {
          const d = img.data;
          d.fill(0);
          let any = false;
          for (let y = 0; y < TILE; y++) {
            const my = ty * TILE + y;
            if (my >= doc.h) break;
            for (let x = 0; x < TILE; x++) {
              const mx = tx * TILE + x;
              if (mx >= doc.w) break;
              if (!region.mask[my * doc.w + mx]) continue;
              const i = (y * TILE + x) * 4;
              d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
              any = true;
            }
          }
          if (!any) continue;
          const k = doc.key(tx, ty);
          doc.onTouch?.(layer, k);
          tctx.putImageData(img, 0, 0);
          doc.tile(layer, tx, ty, true).getContext('2d').drawImage(tmp, 0, 0);
          touched.push(k);
        }
      }
      doc.changed({ tiles: touched, layer });
      app.history.commit();
      app.edited();
      app.board.request();
    } finally {
      app.setBusy(null);
    }
  }
}

function dilate(region, w, h) {
  const { mask } = region;
  const add = [];
  for (let y = Math.max(0, region.y0 - 1); y <= Math.min(h - 1, region.y1 + 1); y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) continue;
      if ((x > 0 ? mask[i - 1] : mask[i + w - 1]) || (x < w - 1 ? mask[i + 1] : mask[i - w + 1])
        || (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w])) add.push(i);
    }
  }
  for (const i of add) mask[i] = 1;
  region.y0 = Math.max(0, region.y0 - 1);
  region.y1 = Math.min(h - 1, region.y1 + 1);
  if (region.x0 > 0) region.x0 -= 1;
  if (region.x1 < w - 1) region.x1 += 1;
}

/* ---------- スポイト・移動 ---------- */

class Eyedropper {
  constructor(app) { this.app = app; this.id = 'eyedropper'; }
  down(p) { this.start = p; }
  up(p) { if (this.start) this.pick(p); this.start = null; }
  cancel() { this.start = null; }
  pick(p) {
    const c = this.app.doc.sample(p.x, p.y);
    if (!c) { this.app.toast('ここには色がありません'); return; }
    const hex = `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    this.app.setColor(hex);
    this.app.toast(`色を取りました（${hex}）`);
    if (this.app.tool === this) this.app.backToPrevTool();
  }
}

class Hand {
  constructor(app) { this.app = app; this.id = 'hand'; }
}

export function createTools(app) {
  return {
    hand: new Hand(app),
    pen: new Brush(app, false),
    eraser: new Brush(app, true),
    line: new Ruler(app),
    shape: new Shapes(app),
    fill: new Fill(app),
    eyedropper: new Eyedropper(app),
  };
}
