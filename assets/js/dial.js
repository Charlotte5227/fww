// 下部の回転ダイヤル（現在の向きを示し、ドラッグでも回せる）
import { mod360 } from './engine.js?v=20261026-3';

export class Dial {
  constructor(canvas, { span = 120, onDrag } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.span = span;           // ダイヤル全幅で表す角度
    this.angle = 0;
    this.onDrag = onDrag;
    this._queued = false;
    new ResizeObserver(() => this._resize()).observe(canvas);
    this._resize();

    let last = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      last = e.clientX;
      e.stopPropagation();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (last == null) return;
      const dx = e.clientX - last;
      last = e.clientX;
      this.onDrag?.(-dx / this.pxPerDeg, false);
    });
    const end = () => { last = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 30 : 5;
      if (e.key === 'ArrowLeft') { this.onDrag?.(-step, true); e.preventDefault(); }
      if (e.key === 'ArrowRight') { this.onDrag?.(step, true); e.preventDefault(); }
    });
  }

  set(angle) {
    this.angle = angle;
    this.canvas.setAttribute('aria-valuenow', String(Math.round(angle) % 360));
    if (this._queued) return;
    this._queued = true;
    requestAnimationFrame(() => { this._queued = false; this.draw(); });
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pxPerDeg = this.w / this.span;
    this.draw();
  }

  draw() {
    const { ctx, w, h } = this;
    if (!w) return;
    const css = getComputedStyle(document.documentElement);
    const paper = css.getPropertyValue('--paper').trim() || '#eef1f6';
    const mist = css.getPropertyValue('--mist').trim() || '#8c97b3';
    const brass = css.getPropertyValue('--brass-hi').trim() || '#e2c16f';
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const half = this.span / 2 + 6;
    const start = Math.floor((this.angle - half) / 5) * 5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '500 11px "Zen Kaku Gothic New", system-ui, sans-serif';
    for (let t = start; t <= this.angle + half; t += 5) {
      const x = cx + (t - this.angle) * this.pxPerDeg;
      const deg = mod360(t);
      const fade = 1 - Math.min(1, Math.abs(x - cx) / (w / 2));
      const major = deg % 30 === 0;
      const len = deg % 90 === 0 ? 14 : major ? 10 : 5;
      ctx.globalAlpha = 0.15 + 0.85 * fade;
      ctx.strokeStyle = major ? paper : mist;
      ctx.lineWidth = major ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, h - 8);
      ctx.lineTo(x, h - 8 - len);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = paper;
        ctx.fillText(`${Math.round(deg)}°`, x, h - 26);
      }
    }
    ctx.globalAlpha = 1;
    // 中央の針
    ctx.fillStyle = brass;
    ctx.fillRect(cx - 1, 6, 2, h - 12);
    ctx.beginPath();
    ctx.moveTo(cx - 5, 4);
    ctx.lineTo(cx + 5, 4);
    ctx.lineTo(cx, 10);
    ctx.closePath();
    ctx.fill();
  }
}
