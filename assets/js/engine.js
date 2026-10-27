// 筒状ビューアの描画エンジン（閲覧サイトと管理サイトのプレビューで共用）
import * as THREE from '../vendor/three.min.js';

const MAX_SIDE = 8192;          // 合成画像の最大辺（px）
const MAX_AREA = 16_000_000;    // iOS Safari の canvas 面積上限に収める
const BASE_FOV = 30;            // 縦方向の視野角（度）
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 6;

const VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;
void main() {
  vUv = uv;
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform sampler2D map;
uniform float shading;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;
void main() {
  vec4 c = texture2D(map, vUv);
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(-vPos);
  vec3 L = normalize(vec3(-0.45, 0.25, 1.0));
  float lam = max(dot(n, L), 0.0);
  float light = mix(1.0, 0.28 + 0.82 * lam, shading);
  float spec = pow(max(dot(reflect(-L, n), V), 0.0), 28.0) * 0.16 * shading;
  if (!gl_FrontFacing) { light *= 0.5; spec = 0.0; }
  gl_FragColor = vec4(c.rgb * light + spec, c.a);
}`;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mod360 = (a) => ((a % 360) + 360) % 360;

/**
 * 画像の読み込み（src ごとにキャッシュ）
 */
class ImageStore {
  constructor() { this.cache = new Map(); this.ready = new Map(); }
  load(src, resolveUrl) {
    if (!src) return Promise.resolve(null);
    if (this.cache.has(src)) return this.cache.get(src);
    const p = (async () => {
      const url = resolveUrl ? await resolveUrl(src) : src;
      const img = new Image();
      if (!/^(blob:|data:)/.test(url)) img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.src = url;
      await img.decode().catch(() => new Promise((ok, ng) => {
        if (img.complete && img.naturalWidth) return ok();
        img.onload = ok; img.onerror = () => ng(new Error(`画像を読み込めませんでした: ${src}`));
      }));
      this.ready.set(src, img);
      return img;
    })();
    this.cache.set(src, p);
    p.catch(() => this.cache.delete(src));
    return p;
  }
  forget(src) { this.cache.delete(src); this.ready.delete(src); }
}

export class Stage {
  /**
   * @param {HTMLElement} el
   * @param {{resolveUrl?:(src:string)=>Promise<string>|string, onAngle?:Function, onMode?:Function,
   *          onState?:Function, onInteract?:Function, onAutoRotate?:Function}} opts
   */
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = opts;
    this.images = new ImageStore();
    this.config = null;
    this.visible = new Map();      // layerId -> boolean
    this.opacity = new Map();      // layerId -> 閲覧者が変更した不透明度（0〜1）
    this.mode = 'cylinder';
    this.angle = 180;              // 正面に来ている画像上の位置（0〜360度＝画像の左端〜右端）
    this.velocity = 0;             // 慣性回転（度/ms）
    this.zoom = 1;
    this.panY = 0;
    this.autoRotate = false;
    this.rotateSpeed = 6;          // 度/秒
    this.shading = 0.55;
    this.flat = { zoom: 1, x: 0, y: 0 };
    this.size = { w: 1, h: 1 };
    this.texAspect = 0;
    this.dirty = true;
    this.loadToken = 0;

    el.classList.add('cv-stage');
    this.bgEl = Object.assign(document.createElement('div'), { className: 'cv-bg' });
    this.glCanvas = Object.assign(document.createElement('canvas'), { className: 'cv-gl' });
    this.flatCanvas = Object.assign(document.createElement('canvas'), { className: 'cv-flat' });
    el.append(this.bgEl, this.glCanvas, this.flatCanvas);
    this.flatCtx = this.flatCanvas.getContext('2d');
    this.composite = document.createElement('canvas');
    this.compositeCtx = this.composite.getContext('2d');

    this._initGL();
    this._initInput();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(el);
    this._resize();
    this._last = performance.now();
    this._raf = requestAnimationFrame((t) => this._tick(t));
    this._applyMode();
  }

  /* ---------- 公開 API ---------- */

  /** 設定を読み込み、画像を合成して表示する */
  async load(config, { keepView = false, syncVisible = !keepView } = {}) {
    const token = ++this.loadToken;
    this.config = config;
    const disp = config.display || {};
    this.shading = disp.shading ?? 0.55;
    this.rotateSpeed = disp.rotateSpeed ?? 6;
    if (this.material) this.material.uniforms.shading.value = this.shading;
    if (!keepView) {
      this.angle = mod360(disp.startAngle ?? 180);
      this.visible.clear();
      this.opacity.clear();
      this.zoom = 1; this.panY = 0; this.flat = { zoom: 1, x: 0, y: 0 };
    }
    for (const l of config.layers || []) {
      if (syncVisible || !this.visible.has(l.id)) this.visible.set(l.id, l.visible !== false);
    }
    this.setBackground(config.background || {});
    this._emitState('loading');
    const all = [config.base?.src, ...(config.layers || []).map((l) => l.src)].filter(Boolean);
    const results = await Promise.allSettled(all.map((s) => this.images.load(s, this.opts.resolveUrl)));
    if (token !== this.loadToken) return;
    const failed = results.map((r, i) => (r.status === 'rejected' ? all[i] : null)).filter(Boolean);
    this._compose();
    this._emitState(this.composite.width ? 'ready' : 'empty', { failed });
  }

  setLayerVisible(id, on) {
    this.visible.set(id, !!on);
    this._scheduleCompose();
  }
  isLayerVisible(id) { return this.visible.get(id) !== false; }

  /** 閲覧側での不透明度の変更（null で管理ページの設定値に戻す） */
  setLayerOpacity(id, value) {
    if (value == null) this.opacity.delete(id);
    else this.opacity.set(id, clamp(Number(value), 0, 1));
    this._scheduleCompose();
  }
  getLayerOpacity(id) {
    if (this.opacity.has(id)) return this.opacity.get(id);
    const l = (this.config?.layers || []).find((x) => x.id === id);
    return clamp(l?.opacity ?? 1, 0, 1);
  }

  /** スライダー操作などで連続して呼ばれても、合成は 1 フレームに 1 回だけ行う */
  _scheduleCompose() {
    if (this._composeQueued) return;
    this._composeQueued = true;
    requestAnimationFrame(() => { this._composeQueued = false; this._compose(); });
  }

  setMode(mode) {
    if (mode !== 'cylinder' && mode !== 'flat') return;
    if (!this.gl && mode === 'cylinder') mode = 'flat';
    this.mode = mode;
    this._applyMode();
    this.opts.onMode?.(mode);
  }

  setAutoRotate(on) {
    this.autoRotate = !!on;
    this.opts.onAutoRotate?.(this.autoRotate);
  }

  setAngle(deg) { this.angle = mod360(deg); this.velocity = 0; this.dirty = true; this.opts.onAngle?.(this.angle); }
  rotateBy(deg) { this.setAngle(this.angle + deg); }

  /** 回転の勢いを与える（ボタン操作用） */
  nudge(deg) { this.velocity = (deg * -Math.log(0.0035)) / 1000; }

  setBackground({ src, color, fit } = {}) {
    const s = this.bgEl.style;
    s.backgroundColor = color || '';
    s.backgroundImage = '';
    if (src) {
      Promise.resolve(this.opts.resolveUrl ? this.opts.resolveUrl(src) : src).then((url) => {
        s.backgroundImage = `url("${url}")`;
      });
    }
    s.backgroundSize = fit === 'contain' ? 'contain' : fit === 'tile' ? 'auto' : 'cover';
    s.backgroundRepeat = fit === 'tile' ? 'repeat' : 'no-repeat';
  }

  resetView() {
    this.zoom = 1; this.panY = 0;
    this.flat = { zoom: 1, x: 0, y: 0 };
    this._updateCamera();
    this.dirty = true;
  }

  /* ---------- 画像の書き出し ---------- */

  /** 今のレイヤーの表示（表示／非表示・透明度）で合成した地図全体。左端・右端は元の画像のまま */
  exportFull() {
    this._compose();
    return this.composite.width ? this.composite : null;
  }

  /**
   * 平面表示で画面に映っている範囲を切り出す。
   * 拡大中は画面の見た目どおりの解像度、縮小中は元画像の解像度で書き出す。
   */
  captureView({ maxSide = 8192 } = {}) {
    this._compose();
    const c = this.composite;
    if (!c.width || this.mode !== 'flat') return null;
    const s = this._flatFit() * this.flat.zoom;
    const w = c.width * s, h = c.height * s;
    const x0 = this.size.w / 2 - w / 2;
    const y0 = this._flatCenterY() - h / 2 + this.flat.y;
    const vx0 = Math.max(0, x0), vx1 = Math.min(this.size.w, x0 + w);
    const vy0 = Math.max(0, y0), vy1 = Math.min(this.size.h, y0 + h);
    if (vx1 <= vx0 || vy1 <= vy0) return null;
    // 画面上の位置 → 元画像上の位置（横は回り込みを考慮）
    const shift = ((((this.angle - 180) / 360) % 1) + 1) % 1 * w;
    let u0 = ((vx0 - (x0 - shift)) / s) % c.width;
    if (u0 < 0) u0 += c.width;
    const sw = (vx1 - vx0) / s, sh = (vy1 - vy0) / s, v0 = (vy0 - y0) / s;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const k = Math.min(Math.max(1, s * dpr), maxSide / Math.max(sw, sh));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * k));
    out.height = Math.max(1, Math.round(sh * k));
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const w1 = Math.min(sw, c.width - u0);
    const split = Math.round(w1 * k);
    ctx.drawImage(c, u0, v0, w1, sh, 0, 0, split, out.height);
    if (sw - w1 > 1e-6) ctx.drawImage(c, 0, v0, sw - w1, sh, split, 0, out.width - split, out.height);
    return out;
  }

  /** 上下の操作パネルの分の余白（px）を変える。筒・平面とも、残りの範囲の中央に収まる */
  setPadding({ top, bottom }) {
    this.opts.flatPadding = { top, bottom };
    this._updateCamera();
    this._flatClamp();
    this.dirty = true;
  }

  forgetImage(src) { this.images.forget(src); }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    this.renderer?.dispose();
    this.el.replaceChildren();
  }

  /* ---------- WebGL ---------- */

  _initGL() {
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.glCanvas, antialias: true, alpha: true });
    } catch (e) {
      this.gl = false;
      return;
    }
    this.gl = true;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.maxTex = this.renderer.capabilities.maxTextureSize || 4096;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.01, 100);
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: null }, shading: { value: this.shading } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: true,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  _buildCylinder(aspect) {
    // 高さ 1、円周 = 画像の横幅 になるよう半径を決める（画像の縦横比を保つ）
    this.radius = aspect / (2 * Math.PI);
    const segs = clamp(Math.round(aspect * 64), 96, 512);
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.CylinderGeometry(this.radius, this.radius, 1, segs, 1, true);
    this._updateCamera();
  }

  _fitDistance() {
    const r = this.radius || 0.2;
    const aspect = this.size.w / this.size.h;
    const tanV = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2));
    const halfH = Math.atan(tanV * aspect);
    // 上下の操作パネルを避けた範囲に収める
    const { top, bottom } = this._padding();
    const avail = Math.max(this.size.h * 0.35, this.size.h - top - bottom);
    const dV = r + (0.5 * 1.06) / (tanV * avail / this.size.h);
    const dH = r / Math.sin(halfH / 1.12);             // 左右に少し余白
    return Math.max(dV, dH);
  }

  _updateCamera() {
    if (!this.gl) return;
    const d = this._fitDistance();
    this.dist = d;
    const fov = clamp(BASE_FOV / this.zoom, 2, 80);
    this.camera.fov = fov;
    this.camera.aspect = this.size.w / this.size.h;
    const halfVis = (d - this.radius) * Math.tan(THREE.MathUtils.degToRad(fov / 2));
    const maxPan = Math.max(0, 0.5 - halfVis * 0.92);
    this.panY = clamp(this.panY, -maxPan, maxPan);
    this.camera.position.set(0, this.panY, d);
    this.camera.lookAt(0, this.panY, 0);
    // 筒の中心を、上下の操作パネルの間の中央へずらす
    const { top, bottom } = this._padding();
    const { w, h } = this.size;
    this.camera.setViewOffset(w, h, 0, -(top - bottom) / 2, w, h);
    this.dirty = true;
  }

  /** 画面上で 1 度回すのに必要なピクセル数（正面の表面が指に追従するように） */
  _pxPerDegree() {
    if (this.mode === 'flat') return Math.max(0.01, (this.composite.width * this._flatFit() * this.flat.zoom) / 360);
    if (!this.gl || !this.radius) return 4;
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const pxPerUnit = (this.size.h / 2) / ((this.dist - this.radius) * tan);
    return pxPerUnit * this.radius * (Math.PI / 180);
  }

  /* ---------- 合成 ---------- */

  _compose() {
    const cfg = this.config || {};
    const pick = (src) => (src ? this.images.ready.get(src) || null : null);
    const baseImg = pick(cfg.base?.src);
    const layers = (cfg.layers || []).map((l) => ({ l, img: pick(l.src) }));

    let w = baseImg?.naturalWidth || 0;
    let h = baseImg?.naturalHeight || 0;
    if (!w) for (const { img } of layers) if (img && img.naturalWidth * img.naturalHeight > w * h) { w = img.naturalWidth; h = img.naturalHeight; }
    const c = this.composite;
    if (!w || !h) {
      c.width = c.height = 0;
      if (this.mesh) this.mesh.visible = false;
      this.dirty = true;
      return;
    }
    const maxSide = Math.min(MAX_SIDE, this.maxTex || MAX_SIDE);
    const s = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));
    const cw = Math.round(w * s), ch = Math.round(h * s);
    const sizeChanged = c.width !== cw || c.height !== ch;
    if (sizeChanged) { c.width = cw; c.height = ch; }
    const ctx = this.compositeCtx;
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingQuality = 'high';
    if (baseImg) ctx.drawImage(baseImg, 0, 0, cw, ch);
    for (const { l, img } of layers) {
      if (!img || !this.isLayerVisible(l.id)) continue;
      ctx.globalAlpha = this.getLayerOpacity(l.id);
      ctx.drawImage(img, 0, 0, cw, ch);
    }
    ctx.globalAlpha = 1;

    if (this.gl) {
      if (sizeChanged || !this.texture) {
        this.texture?.dispose();
        this.texture = new THREE.CanvasTexture(c);
        this.texture.colorSpace = THREE.NoColorSpace;
        this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        this.texture.minFilter = THREE.LinearMipmapLinearFilter;
        this.material.uniforms.map.value = this.texture;
      } else {
        this.texture.needsUpdate = true;
      }
      const aspect = cw / ch;
      if (Math.abs(aspect - this.texAspect) > 1e-4) { this.texAspect = aspect; this._buildCylinder(aspect); }
      this.mesh.visible = true;
    }
    this.dirty = true;
  }

  /* ---------- 入力 ---------- */

  _initInput() {
    const el = this.el;
    el.style.touchAction = 'none';
    const pts = new Map();
    let last = null, pinch = null, tapAt = 0, tapPos = null, moved = 0;
    const hist = [];

    const center = () => {
      const a = [...pts.values()];
      return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button > 0) return;
      el.setPointerCapture?.(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.velocity = 0;
      if (this.autoRotate) this.setAutoRotate(false);
      this.opts.onInteract?.();
      hist.length = 0;
      moved = 0;
      if (pts.size === 1) last = { x: e.clientX, y: e.clientY };
      if (pts.size === 2) pinch = { ...center(), zoom: this.mode === 'flat' ? this.flat.zoom : this.zoom };
    });

    el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2 && pinch) {
        const c = center();
        const z = pinch.zoom * (c.d / Math.max(pinch.d, 1));
        if (this.mode === 'flat') {
          this._flatZoomAt(z, c.x, c.y);
          this.angle = mod360(this.angle - (c.x - pinch.x) / this._pxPerDegree());
          this._flatPan(0, c.y - pinch.y);
          this.opts.onAngle?.(this.angle);
        }
        else { this.zoom = clamp(z, ZOOM_MIN, ZOOM_MAX); this._updateCamera(); }
        pinch.x = c.x; pinch.y = c.y;
        moved += 10;
        return;
      }
      if (!last) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      moved += Math.abs(dx) + Math.abs(dy);
      const dDeg = -dx / this._pxPerDegree();
      this.angle = mod360(this.angle + dDeg);
      hist.push({ t: performance.now(), d: dDeg });
      if (hist.length > 6) hist.shift();
      if (this.mode === 'flat') {
        if (dy) this._flatPan(0, dy);
      } else if (dy && this.zoom > 1) {
        const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
        this.panY += dy * ((this.dist - this.radius) * tan) / (this.size.h / 2);
        this._updateCamera();
      }
      this.dirty = true;
      this.opts.onAngle?.(this.angle);
    });

    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 1) { const p = [...pts.values()][0]; last = { ...p }; return; }
      last = null;
      if (hist.length > 1) {
        const now = performance.now();
        const recent = hist.filter((h) => now - h.t < 90);
        if (recent.length > 1) {
          const span = Math.max(16, recent[recent.length - 1].t - recent[0].t);
          this.velocity = clamp(recent.reduce((a, h) => a + h.d, 0) / span, -1.2, 1.2);
        }
      }
      // ダブルタップで表示リセット
      if (moved < 8 && e.type === 'pointerup') {
        const now = performance.now();
        if (now - tapAt < 320 && tapPos && Math.hypot(e.clientX - tapPos.x, e.clientY - tapPos.y) < 30) { this.resetView(); tapAt = 0; }
        else { tapAt = now; tapPos = { x: e.clientX, y: e.clientY }; }
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) { this.rotateBy(e.deltaX / this._pxPerDegree()); }
      else if (this.mode === 'flat') this._flatZoomAt(this.flat.zoom * f, e.clientX, e.clientY);
      else { this.zoom = clamp(this.zoom * f, ZOOM_MIN, ZOOM_MAX); this._updateCamera(); }
      this.opts.onInteract?.();
    }, { passive: false });
  }

  /* ---------- 平面表示 ---------- */

  _flatFit() {
    const c = this.composite;
    if (!c.width) return 1;
    const padX = Math.min(24, this.size.w * 0.04);
    const padTop = this.opts.flatPadding?.top ?? 110;
    const padBottom = this.opts.flatPadding?.bottom ?? 90;
    return Math.min((this.size.w - padX * 2) / c.width, (this.size.h - padTop - padBottom) / c.height);
  }

  _flatZoomAt(z, cx, cy) {
    const rect = this.el.getBoundingClientRect();
    const px = cx - rect.left - this.size.w / 2 - this.flat.x;
    const py = cy - rect.top - this._flatCenterY() - this.flat.y;
    const nz = clamp(z, 0.5, 12);
    const k = nz / this.flat.zoom;
    // 横方向は枠の中で画像が回り込むので、カーソル下の位置を保つよう角度をずらす
    const before = this._pxPerDegree();
    this.flat.zoom = nz;
    const after = this._pxPerDegree();
    this.angle = mod360(this.angle + px / before - px / after);
    this.flat.y -= py * (k - 1);
    this.opts.onAngle?.(this.angle);
    this._flatClamp();
    this.dirty = true;
  }

  _flatPan(dx, dy) { this.flat.x += dx; this.flat.y += dy; this._flatClamp(); this.dirty = true; }

  _padding() {
    return { top: this.opts.flatPadding?.top ?? 110, bottom: this.opts.flatPadding?.bottom ?? 90 };
  }

  _flatCenterY() {
    const top = this.opts.flatPadding?.top ?? 110;
    const bottom = this.opts.flatPadding?.bottom ?? 90;
    return top + (this.size.h - top - bottom) / 2;
  }

  _flatClamp() {
    const c = this.composite;
    const s = this._flatFit() * this.flat.zoom;
    const my = Math.max(0, (c.height * s - this.size.h) / 2 + 60);
    this.flat.x = 0; // 横は画像が回り込むため枠は常に中央
    this.flat.y = clamp(this.flat.y, -my, my);
  }

  _drawFlat() {
    const ctx = this.flatCtx;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.size.w, this.size.h);
    const c = this.composite;
    if (!c.width) return;
    const s = this._flatFit() * this.flat.zoom;
    const w = c.width * s, h = c.height * s;
    const x = this.size.w / 2 - w / 2;
    const y = this._flatCenterY() - h / 2 + this.flat.y;
    // 正面（angle）が枠の中央に来るように横へずらし、左右をつなげて描く（angle=180 で元の画像のまま）
    const shift = (((this.angle - 180) / 360) % 1 + 1) % 1 * w;
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.max(0, x), y, Math.min(this.size.w, x + w) - Math.max(0, x), h);
    ctx.clip();
    ctx.imageSmoothingQuality = 'high';
    const start = x - shift;
    const first = start + Math.floor((Math.max(0, x) - start) / w) * w;
    // つなぎ目に隙間ができないよう、タイルの境目を実ピクセルにそろえる
    const snap = (v) => Math.round(v * dpr) / dpr;
    for (let tx = first; tx < Math.min(this.size.w, x + w); tx += w) {
      const a = snap(tx);
      ctx.drawImage(c, a, y, snap(tx + w) - a, h);
    }
    ctx.restore();
  }

  /* ---------- ループ ---------- */

  _applyMode() {
    const flat = this.mode === 'flat';
    this.el.classList.toggle('is-flat', flat);
    this.el.classList.toggle('is-cylinder', !flat);
    this.dirty = true;
  }

  _resize() {
    const r = this.el.getBoundingClientRect();
    this.size = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.flatCanvas.width = Math.round(this.size.w * dpr);
    this.flatCanvas.height = Math.round(this.size.h * dpr);
    if (this.gl) {
      this.renderer.setSize(this.size.w, this.size.h, false);
      this._updateCamera();
    }
    this._flatClamp();
    this.dirty = true;
  }

  _emitState(state, extra = {}) { this.opts.onState?.(state, extra); }

  _tick(t) {
    const dt = Math.min(64, t - this._last);
    this._last = t;
    {
      let changed = false;
      if (this.autoRotate) { this.angle = mod360(this.angle + this.rotateSpeed * dt / 1000); changed = true; }
      if (Math.abs(this.velocity) > 0.0005) {
        this.angle = mod360(this.angle + this.velocity * dt);
        this.velocity *= Math.pow(0.0035, dt / 1000);
        changed = true;
      } else this.velocity = 0;
      if (changed) { this.dirty = true; this.opts.onAngle?.(this.angle); }
    }
    if (this.dirty) {
      this.dirty = false;
      if (this.mode === 'cylinder' && this.gl) {
        this.mesh.rotation.y = -THREE.MathUtils.degToRad(this.angle);
        this.renderer.render(this.scene, this.camera);
      } else if (this.mode === 'flat') {
        this._drawFlat();
      }
    }
    this._raf = requestAnimationFrame((tt) => this._tick(tt));
  }
}

export { mod360 };
