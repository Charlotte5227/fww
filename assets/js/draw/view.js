// お絵かきページの表示（平面）：移動・拡大・左右のループと、ツールへの入力の受け渡し

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Board {
  /**
   * @param {HTMLElement} el
   * @param {import('./doc.js').Doc} doc
   * @param {{ padding: () => {top:number,bottom:number}, onTool: object, onView?: Function }} opts
   */
  constructor(el, doc, opts) {
    this.el = el;
    this.doc = doc;
    this.opts = opts;
    this.canvas = el.querySelector('#paint');
    this.overlay = el.querySelector('#overlay');
    this.ctx = this.canvas.getContext('2d');
    this.octx = this.overlay.getContext('2d');
    this.cam = { x: doc.w / 2, y: doc.h / 2, s: 0.2 };  // 画面中央に来る地図の位置と、倍率（画面 px / 地図 px）
    this.size = { w: 1, h: 1, dpr: 1 };
    this.dirty = true;
    this.handMode = false;  // 「移動」ツール中
    this.spaceDown = false;
    this.hover = null;      // マウスの位置（ペン先の円の表示用）
    this.background = '#1a2038';

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.fit();
    this.initInput();
    const loop = () => {
      if (this.dirty) { this.dirty = false; this.draw(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  request() { this.dirty = true; }

  resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = { w: Math.max(1, r.width), h: Math.max(1, r.height), dpr };
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.round(this.size.w * dpr);
      c.height = Math.round(this.size.h * dpr);
    }
    this.clampCam();
    this.request();
  }

  /** 上下の操作パネルを避けて、地図全体が収まる倍率 */
  fitScale() {
    const pad = this.opts.padding?.() || { top: 110, bottom: 160 };
    const availH = Math.max(80, this.size.h - pad.top - pad.bottom);
    return Math.min((this.size.w - 24) / this.doc.w, availH / this.doc.h);
  }

  fit() {
    const pad = this.opts.padding?.() || { top: 110, bottom: 160 };
    this.cam.s = this.fitScale();
    this.cam.x = this.doc.w / 2;
    // 上下の操作パネルの間の中央に地図が来るように
    this.cam.y = this.doc.h / 2 - ((pad.top - pad.bottom) / 2) / this.cam.s;
    this.request();
  }

  clampCam() {
    const s = this.cam.s;
    const fit = this.fitScale();
    this.cam.s = clamp(s, fit * 0.5, 24);
    const halfH = this.size.h / 2 / this.cam.s;
    const m = this.doc.h / 2 + halfH;  // 地図が画面外に出きらない範囲
    this.cam.y = clamp(this.cam.y, this.doc.h / 2 - m + 40 / this.cam.s, this.doc.h / 2 + m - 40 / this.cam.s);
    this.cam.x = ((this.cam.x % this.doc.w) + this.doc.w) % this.doc.w;
  }

  /** 画面上の点 → 地図の座標（x は左右につながったまま、範囲外の値もありうる） */
  toMap(cx, cy) {
    const r = this.el.getBoundingClientRect();
    return {
      x: this.cam.x + (cx - r.left - this.size.w / 2) / this.cam.s,
      y: this.cam.y + (cy - r.top - this.size.h / 2) / this.cam.s,
    };
  }

  /** 地図の座標 → 画面（CSS px）。左右は枠の中に来る位置に回り込ませる */
  toScreen(x, y) {
    const W = this.doc.w;
    let dx = (((x - this.cam.x + W / 2) % W) + W) % W - W / 2;
    if (!Number.isFinite(dx)) dx = x - this.cam.x;
    return { x: dx * this.cam.s + this.size.w / 2, y: (y - this.cam.y) * this.cam.s + this.size.h / 2 };
  }

  /**
   * 地図を表示する枠（画面の CSS px）。閲覧ページの平面表示と同じく、枠の大きさは元の画像と同じで、
   * 左右に動かすと枠の中で地図が回り込む。枠は常に画面の左右中央。
   */
  frame() {
    const { w, h } = this.size;
    const s = this.cam.s;
    const fw = this.doc.w * s;
    const top = h / 2 - this.cam.y * s;
    return {
      x0: Math.max(0, w / 2 - fw / 2), x1: Math.min(w, w / 2 + fw / 2),
      y0: Math.max(0, top), y1: Math.min(h, top + this.doc.h * s),
    };
  }

  /** 今画面に見えている地図の範囲 */
  visibleRect() {
    const { w, h } = this.size;
    const s = this.cam.s;
    return { x: this.cam.x - w / 2 / s, y: this.cam.y - h / 2 / s, w: w / s, h: h / s };
  }

  zoomAt(factor, cx, cy) {
    const before = this.toMap(cx, cy);
    this.cam.s = clamp(this.cam.s * factor, this.fitScale() * 0.5, 24);
    const after = this.toMap(cx, cy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCam();
    this.request();
    this.opts.onView?.();
  }

  panBy(dx, dy) {
    this.cam.x -= dx / this.cam.s;
    this.cam.y -= dy / this.cam.s;
    this.clampCam();
    this.request();
    this.opts.onView?.();
  }

  draw() {
    const { w, dpr } = this.size;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const f = this.frame();
    if (f.x1 > f.x0 && f.y1 > f.y0) {
      const S = this.cam.s * dpr;
      // 枠の左右の端を実ピクセルにそろえ、枠の中だけを描く（左右は最大でも 2 つに分かれるだけ）
      const px0 = Math.round(f.x0 * dpr), px1 = Math.round(f.x1 * dpr);
      const py0 = Math.round(f.y0 * dpr), py1 = Math.round(f.y1 * dpr);
      const rx = this.cam.x + (px0 - (w * dpr) / 2) / S;
      const ry = this.cam.y + (py0 - (this.size.h * dpr) / 2) / S;
      ctx.save();
      ctx.beginPath();
      ctx.rect(px0, py0, px1 - px0, py1 - py0);
      ctx.clip();
      ctx.translate(px0, py0);
      this.doc.render(ctx, rx, ry, (px1 - px0) / S, (py1 - py0) / S, S, { smooth: this.cam.s < 2 });
      ctx.restore();
    }
    this.drawOverlay();
  }

  drawOverlay() {
    const { dpr } = this.size;
    const o = this.octx;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.overlay.width, this.overlay.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.opts.onTool?.overlay?.(o, this);
  }

  /** 地図の座標で描く関数を、枠の中に（左右の回り込みも含めて）描く */
  withMapTransform(o, fn) {
    const { dpr } = this.size;
    const s = this.cam.s;
    const W = this.doc.w;
    const f = this.frame();
    if (f.x1 <= f.x0) return;
    const left = this.cam.x - (this.size.w / 2 - f.x0) / s;   // 枠の左端の地図座標
    const right = left + (f.x1 - f.x0) / s;
    o.save();
    o.beginPath();
    o.rect(f.x0, 0, f.x1 - f.x0, this.size.h);  // 上下は枠の外にはみ出しても見えるようにする（つまみ・長さの表示）
    o.clip();
    for (let k = Math.floor(left / W) - 1; k <= Math.floor(right / W) + 1; k++) {
      o.save();
      o.setTransform(s * dpr, 0, 0, s * dpr, (k * W - this.cam.x) * s * dpr + (this.size.w / 2) * dpr, (-this.cam.y) * s * dpr + (this.size.h / 2) * dpr);
      fn(o, k * W);
      o.restore();
    }
    o.restore();
  }

  /* ---------- 入力 ---------- */

  initInput() {
    const el = this.el;
    el.style.touchAction = 'none';
    const pts = new Map();
    let mode = null;   // 'tool' | 'pan' | 'pinch'
    let last = null;
    let pinch = null;
    const tool = () => this.opts.onTool;

    const center = () => {
      const a = [...pts.values()];
      return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
    };

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      this.opts.onInteract?.();
      if (pts.size === 2) {
        // 2 本指：描いている途中ならやめて、移動・拡大にする
        if (mode === 'tool') tool()?.cancel?.(this);
        mode = 'pinch';
        pinch = center();
        return;
      }
      if (pts.size > 2) return;
      last = { x: e.clientX, y: e.clientY };
      // 枠の左右の外側をつかんだときは、描かずに移動にする
      const f = this.frame();
      const lx = e.clientX - el.getBoundingClientRect().left;
      const outside = lx < f.x0 || lx > f.x1;
      const wantsPan = this.handMode || this.spaceDown || e.button === 1 || e.button === 2 || outside;
      if (wantsPan) { mode = 'pan'; el.classList.add('is-panning'); return; }
      mode = 'tool';
      tool()?.down?.(this.toMap(e.clientX, e.clientY), e, this);
    });

    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        this.hover = this.toMap(e.clientX, e.clientY);
        if (!pts.size) { tool()?.hover?.(this.hover, e, this); this.drawOverlay(); }
      }
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      if (mode === 'pinch' && pts.size >= 2) {
        const c = center();
        this.zoomAt(c.d / Math.max(pinch.d, 1), c.x, c.y);
        this.panBy(c.x - pinch.x, c.y - pinch.y);
        pinch = c;
        return;
      }
      if (mode === 'pan') {
        this.panBy(e.clientX - last.x, e.clientY - last.y);
        last = { x: e.clientX, y: e.clientY };
        return;
      }
      if (mode === 'tool') {
        const evs = e.getCoalescedEvents?.() || [e];
        for (const ev of evs) tool()?.move?.(this.toMap(ev.clientX, ev.clientY), ev, this);
      }
    });

    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (mode === 'tool' && e.type === 'pointerup') tool()?.up?.(this.toMap(e.clientX, e.clientY), e, this);
      if (mode === 'tool' && e.type === 'pointercancel') tool()?.cancel?.(this);
      if (pts.size === 0) { mode = null; pinch = null; el.classList.remove('is-panning'); }
      else if (mode === 'pinch' && pts.size === 1) { mode = 'pan-wait'; }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { this.hover = null; this.drawOverlay(); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        // ホイール・トラックパッドのピンチで拡大縮小
        const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018));
        this.zoomAt(f, e.clientX, e.clientY);
      } else {
        this.panBy(-e.deltaX, 0);
      }
    }, { passive: false });
  }
}
