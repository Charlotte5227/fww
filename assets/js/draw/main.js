// お絵かきページ
import { Doc, TILE, MAX_DRAW_LAYERS, newId, newCanvas, isEmpty, bumpRev } from './doc.js?v=20261028-6';
import { Board } from './view.js?v=20261028-6';
import { History } from './history.js?v=20261028-6';
import { Store } from './store.js?v=20261028-6';
import { createTools, formatLength } from './tools.js?v=20261028-6';
import { createDiscord } from './discord.js?v=20261028-6';
import { Prefs, siteOn } from '../prefs.js?v=20261028-6';
import { safeName, stamp, canvasToBlob, loadJSZip, deliver } from '../save.js?v=20261028-1';

const $ = (s, el = document) => el.querySelector(s);
const app = {};
window.__draw = app;  // 動作確認用
const appEl = $('#app');
const statusEl = $('#status');

const BACKUP_DAYS = 7;
const PALETTE = ['#000000', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa',
  '#6d4c41', '#9e9e9e', '#00acc1', '#f06292', '#c0ca33', '#3949ab', '#ff7043', '#26a69a'];
const DEFAULTS = {
  color: '#e53935',
  sizes: { pen: 8, eraser: 32, line: 6, shape: 6 },
  opts: { snap: true, poly: false, shape: 'rect', style: 'stroke', lock: false, arrowBoth: false, fillRef: 'visible', tolerance: 20 },
};
const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 3.5l17 17M10.5 6.1A9 9 0 0 1 12 6c6 0 9.5 6 9.5 6a16 16 0 0 1-3 3.6M6.6 7.7C4 9.4 2.5 12 2.5 12s3.5 6 9.5 6c1.6 0 3-.4 4.2-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

/* ---------- 共通 ---------- */

let toastTimer;
function toast(msg, { error = false } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('is-error', error);
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), error ? 5000 : 2600);
}
app.toast = toast;

app.setBusy = (msg) => {
  app.busy = !!msg;
  statusEl.innerHTML = msg ? `<div><div class="spinner"></div>${msg}</div>` : '';
};

function loadImage(src) {
  return new Promise((ok, ng) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => ok(img);
    img.onerror = () => ng(new Error(`画像を読み込めませんでした: ${src}`));
    img.src = src;
  });
}

/** 地図の中身が変わったかを調べるための目印 */
function mapSignature(config) {
  return JSON.stringify([config.base?.src || '', ...(config.layers || []).map((l) => [l.id, l.src])]);
}

/* ---------- 起動 ---------- */

async function main() {
  app.setBusy('読み込み中');
  let config;
  try {
    const res = await fetch('../data/config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config = await res.json();
  } catch (e) {
    statusEl.innerHTML = '<p>設定ファイル（data/config.json）を読み込めませんでした。</p>';
    return;
  }
  app.config = config;
  const title = config.title || '地図';
  $('#title').textContent = title;
  document.title = `お絵かき｜${title}`;
  if (!siteOn(config, 'draw')) {
    statusEl.innerHTML = '<p>お絵かきページは、今は使えないように設定されています。<br><a href="../">閲覧ページに戻る</a></p>';
    $('#dockWrap').hidden = true;
    return;
  }
  const widthKm = Number(config.display?.widthKm) || 0;

  // 地図の画像（最新の地図だけ）
  const entries = [];
  if (config.base?.src) entries.push({ id: '__base', name: '下地', src: config.base.src, visible: true, opacity: 1, isBase: true });
  for (const l of config.layers || []) entries.push({ id: l.id, name: l.name || '名前なし', src: l.src, visible: l.visible !== false, opacity: l.opacity ?? 1 });
  const imgs = await Promise.all(entries.map((e) => loadImage(`../${e.src}`).catch(() => null)));
  const ref = imgs[0] || imgs.find(Boolean);
  if (!ref) { statusEl.innerHTML = '<p>地図の画像を読み込めませんでした。</p>'; return; }
  let W = ref.naturalWidth, H = ref.naturalHeight;
  if (!imgs[0] || !config.base?.src) for (const im of imgs) if (im && im.naturalWidth * im.naturalHeight > W * H) { W = im.naturalWidth; H = im.naturalHeight; }

  const doc = new Doc(W, H);
  app.doc = doc;
  entries.forEach((e, i) => doc.addMapLayer({ ...e, img: imgs[i] }));
  app.kmPerPx = widthKm > 0 ? widthKm / W : 0;
  app.mapSig = mapSignature(config);

  // 設定（色・太さなど）
  app.color = DEFAULTS.color;
  app.recent = [];
  app.sizes = { ...DEFAULTS.sizes };
  app.opts = { ...DEFAULTS.opts };
  app.meta = { firstEditAt: 0, lastBackupAt: 0, nextNum: 1 };

  // 前回の続き
  app.store = new Store();
  let restored = false;
  try { restored = await restore(); } catch (e) { console.warn('自動保存を読み込めませんでした', e); }

  // 履歴・表示・ツール
  app.history = new History(doc, {
    onChange: updateUndoButtons,
    onRestore: (r) => {
      for (const [layer, k] of r.tiles || []) { markTile(layer, k); bumpRev(layer); }
      afterLayersChanged();
      app.board.request();
    },
  });
  doc.onChange = (what) => {
    if (what.tiles) for (const k of what.tiles) markTile(what.layer, k);
    if (what.layers) markMeta();
    app.board?.request();
  };
  app.tools = createTools(app);
  app.board = new Board($('#board'), doc, {
    padding: () => ({ top: 72, bottom: bottomPad() }),
    onTool: proxyTool(),
    onInteract: () => closePops(),
  });
  if (config.background?.color) app.board.background = config.background.color;
  app.selectedId = doc.activeId || doc.layers.at(-1)?.id;

  initPrefs();
  initDock();
  initColor();
  initLayers();
  initSave();
  initDiscord();
  initMode();
  initKeys();
  selectTool('pen');
  setColor(app.color, { remember: false });
  updateUndoButtons();
  app.setBusy(null);
  requestAnimationFrame(() => app.board.fit());

  if (restored === 'map-updated') toast('地図が更新されています。描いた内容はそのまま残っています');
  else if (restored && app.doc.hasDrawing()) toast('前回の続きから再開しました');
  if (app.meta.firstEditAt) Store.persist();
  checkBackup();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
  window.addEventListener('pagehide', () => flushSave());
}

/** 今のツールに入力を渡す（ツールが切り替わっても同じ入口を使う） */
function proxyTool() {
  return {
    down: (...a) => app.tool?.down?.(...a),
    move: (...a) => app.tool?.move?.(...a),
    up: (...a) => app.tool?.up?.(...a),
    cancel: (...a) => app.tool?.cancel?.(...a),
    hover: (...a) => app.tool?.hover?.(...a),
    overlay: (...a) => app.tool?.overlay?.(...a),
  };
}

function bottomPad() {
  const r = $('#dockWrap').getBoundingClientRect();
  return Math.max(100, window.innerHeight - r.top + 12);
}

/* ---------- 描き込み先 ---------- */

/** 描き込むレイヤー。なければ作る。非表示なら描かない */
app.target = (what) => {
  const { doc } = app;
  let l = doc.active;
  if (!l) {
    if (doc.drawLayers.length >= MAX_DRAW_LAYERS) { toast('描き込むレイヤーを選んでください', { error: true }); return null; }
    l = addLayer({ quiet: true });
  }
  if (!l.visible) {
    toast(`「${l.name}」は非表示になっています。表示してから${what || '描いて'}ください`, { error: true });
    return null;
  }
  return l;
};

/** 描いたあと：自動保存・最近の色・バックアップのおすすめ */
app.edited = () => {
  if (!app.meta.firstEditAt) { app.meta.firstEditAt = Date.now(); Store.persist(); }
  if (app.tool && app.tool.id !== 'eraser') rememberColor(app.color);
  markMeta();
  scheduleThumbs();
  checkBackup();
};

/* ---------- 自動保存 ---------- */

const saveState = { tiles: new Set(), drop: new Set(), meta: false, timer: 0, running: false };

function markTile(layer, k) {
  if (!layer) return;
  saveState.tiles.add(`${layer.id}|${k}`);
  scheduleSave();
}
function markMeta() { saveState.meta = true; scheduleSave(); }
function markLayerTiles(layer) { for (const k of layer.tiles.keys()) saveState.tiles.add(`${layer.id}|${k}`); scheduleSave(); }
function dropLayer(id) {
  saveState.drop.add(id);
  for (const t of [...saveState.tiles]) if (t.startsWith(`${id}|`)) saveState.tiles.delete(t);
  scheduleSave();
}
function scheduleSave() {
  clearTimeout(saveState.timer);
  saveState.timer = setTimeout(flushSave, 1200);
}

function buildMeta() {
  const { doc } = app;
  return {
    v: 1,
    savedAt: Date.now(),
    size: { w: doc.w, h: doc.h },
    mapSig: app.mapSig,
    order: doc.layers.map((l) => l.id),
    layers: doc.layers.map((l) => ({ id: l.id, kind: l.kind, name: l.name, visible: l.visible, opacity: l.opacity })),
    activeId: doc.activeId,
    color: app.color,
    recent: app.recent,
    sizes: app.sizes,
    opts: app.opts,
    ...app.meta,
  };
}

async function flushSave() {
  clearTimeout(saveState.timer);
  if (saveState.running) { scheduleSave(); return; }
  if (!saveState.tiles.size && !saveState.drop.size && !saveState.meta) return;
  saveState.running = true;
  const ids = [...saveState.tiles];
  const drop = [...saveState.drop];
  saveState.tiles.clear();
  saveState.drop.clear();
  saveState.meta = false;
  try {
    const puts = [];
    const dels = [];
    for (const id of ids) {
      const [lid, ks] = id.split('|');
      const layer = app.doc.layer(lid);
      const k = Number(ks);
      const t = layer?.tiles.get(k);
      if (!t) { dels.push(id); continue; }
      // 消しゴムで空になったタイルは捨てる
      if (isEmpty(t.getContext('2d', { willReadFrequently: true }))) { layer.tiles.delete(k); dels.push(id); continue; }
      puts.push([id, await canvasToBlob(t)]);
    }
    await app.store.save({ meta: buildMeta(), puts, dels, dropLayers: drop });
  } catch (e) {
    console.error(e);
    toast('ブラウザへの自動保存に失敗しました。作業を ZIP で保存しておいてください', { error: true });
  } finally {
    saveState.running = false;
  }
}

/** 自動保存から読み込む。読み込めたら true（地図が変わっていたら 'map-updated'） */
async function restore() {
  const { doc } = app;
  const { meta, tiles } = await app.store.load();
  if (!meta || !Array.isArray(meta.layers)) return false;
  app.color = meta.color || app.color;
  app.recent = Array.isArray(meta.recent) ? meta.recent : [];
  app.sizes = { ...app.sizes, ...(meta.sizes || {}) };
  app.opts = { ...app.opts, ...(meta.opts || {}) };
  app.meta = { firstEditAt: meta.firstEditAt || 0, lastBackupAt: meta.lastBackupAt || 0, nextNum: meta.nextNum || 1 };

  const sameSize = meta.size?.w === doc.w && meta.size?.h === doc.h;
  for (const lm of meta.layers) {
    if (lm.kind === 'map') {
      const l = doc.layer(lm.id);
      if (l) { l.visible = lm.visible; l.opacity = lm.opacity; }
      continue;
    }
    const layer = doc.createDrawLayer({ id: lm.id, name: lm.name, visible: lm.visible, opacity: lm.opacity });
    const mine = [...tiles].filter(([k]) => k.startsWith(`${lm.id}|`));
    if (sameSize) {
      for (const [k, blob] of mine) {
        const bmp = await createImageBitmap(blob);
        const t = newCanvas(TILE, TILE);
        t.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close?.();
        layer.tiles.set(Number(k.split('|')[1]), t);
      }
    } else if (mine.length) {
      // 地図の大きさが変わっていたら、描いた内容も同じ割合で合わせる
      const ow = meta.size.w, oh = meta.size.h, ontx = Math.ceil(ow / TILE);
      const full = newCanvas(ow, oh);
      const fctx = full.getContext('2d');
      for (const [k, blob] of mine) {
        const key = Number(k.split('|')[1]);
        const bmp = await createImageBitmap(blob);
        fctx.drawImage(bmp, (key % ontx) * TILE, Math.floor(key / ontx) * TILE);
      }
      layer.tiles = doc.tilesFromImage(full);
    }
    doc.layers.push(layer);
  }
  applyOrder(meta.order || meta.layers.map((l) => l.id));
  doc.activeId = doc.layer(meta.activeId)?.kind === 'draw' ? meta.activeId : doc.drawLayers.at(-1)?.id || null;
  if (!sameSize) { for (const l of doc.drawLayers) markLayerTiles(l); }
  return meta.mapSig && meta.mapSig !== app.mapSig ? 'map-updated' : true;
}

/** 保存したときの並び順にする。新しく増えた地図のレイヤーは、地図の中での元の位置の近くに入れる */
function applyOrder(order) {
  const { doc } = app;
  const byId = new Map(doc.layers.map((l) => [l.id, l]));
  const sorted = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
  const mapOrder = doc.layers.filter((l) => l.kind === 'map');
  mapOrder.forEach((l, i) => {
    if (sorted.includes(l)) return;
    const prev = mapOrder.slice(0, i).reverse().find((p) => sorted.includes(p));
    sorted.splice(prev ? sorted.indexOf(prev) + 1 : 0, 0, l);
  });
  for (const l of doc.layers) if (!sorted.includes(l)) sorted.push(l);
  doc.layers = sorted;
}

/* ---------- ツールのバーと設定 ---------- */

/** 道具が使えるか（管理ページと「表示の設定」の両方でオン） */
app.toolOn = (id) => id === 'pen' || !app.prefs || app.prefs.on(`tool-${id}`);

function selectTool(id) {
  const next = app.tools[id];
  if (!next || !app.toolOn(id)) return;
  if (app.tool && app.tool !== next) app.tool.deactivate?.();
  if (app.tool && app.tool.id !== 'eyedropper' && app.tool !== next) app.prevTool = app.tool.id;
  app.tool = next;
  app.board.handMode = id === 'hand';
  const board = $('#board');
  board.className = `board tool-${id}`;
  document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === id)));
  app.refreshOptions();
  app.board.drawOverlay();
}
app.selectTool = selectTool;
app.backToPrevTool = () => selectTool(app.prevTool || 'pen');

Object.defineProperty(app, 'size', {
  get() { const id = app.tool?.id; return app.sizes[id] ?? app.sizes.pen; },
});

function initDock() {
  document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => b.addEventListener('click', () => selectTool(b.dataset.tool)));
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  new ResizeObserver(() => app.board?.request()).observe($('#dockWrap'));
}

function updateUndoButtons() {
  const h = app.history;
  if (!h) return;
  const pendingStep = app.tool?.id === 'shape' ? !!app.tool.shape : app.tool?.id === 'line' ? app.tool.points.length > 0 : false;
  $('#undoBtn').disabled = !(h.canUndo || pendingStep);
  $('#redoBtn').disabled = !h.canRedo;
  const last = h.undoStack.at(-1);
  $('#undoBtn').title = last ? `元に戻す：${last.label}（Ctrl+Z）` : '元に戻す（Ctrl+Z）';
}

async function undo() {
  const t = app.tool;
  if (t?.id === 'shape' && t.shape) { t.discard(); updateUndoButtons(); return; }
  if (t?.id === 'line' && t.points.length) { t.undoPoint(); updateUndoButtons(); return; }
  const op = await app.history.undo();
  if (op) toast(`元に戻しました（${op.label}）`);
}

async function redo() {
  const op = await app.history.redo();
  if (op) toast(`やり直しました（${op.label}）`);
}

const SHAPES = [
  ['rect', '四角', '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>'],
  ['ellipse', '丸', '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="8" ry="6.5"/></svg>'],
  ['triangle', '三角', '<svg viewBox="0 0 24 24"><path d="M12 5l8 14H4z"/></svg>'],
  ['arrow', '矢印', '<svg viewBox="0 0 24 24"><path d="M4 18L19 6M19 6h-6.5M19 6v6.5"/></svg>'],
  ['line', '直線', '<svg viewBox="0 0 24 24"><path d="M4.5 19.5l15-15"/></svg>'],
];

/** ツールごとの設定欄を作り直す */
app.refreshOptions = () => {
  const el = $('#opts');
  const t = app.tool;
  if (!t) return;
  el.replaceChildren();
  const add = (html) => { el.insertAdjacentHTML('beforeend', html); return el.lastElementChild; };
  const sizeSlider = () => {
    const id = t.id;
    const wrap = add(`<label class="opt"><span>太さ</span><input type="range" min="1" max="120" step="1" aria-label="太さ"><output></output></label>`);
    const r = $('input', wrap), o = $('output', wrap);
    r.value = app.sizes[id];
    o.textContent = `${app.sizes[id]}px`;
    r.addEventListener('input', () => { app.sizes[id] = Number(r.value); o.textContent = `${r.value}px`; app.board.drawOverlay(); markMeta(); });
  };
  const toggle = (key, text) => {
    const b = add(`<button type="button" class="toggle" aria-pressed="${!!app.opts[key]}">${text}</button>`);
    b.addEventListener('click', () => { app.opts[key] = !app.opts[key]; markMeta(); if (key === 'poly' && !app.opts.poly) app.tools.line.deactivate(); app.refreshOptions(); app.board.drawOverlay(); });
  };
  const seg = (key, items, label) => {
    const w = add(`<div class="seg-mini" role="group" aria-label="${label}"></div>`);
    for (const [v, text, icon] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(app.opts[key] === v));
      b.innerHTML = icon ? `${icon}<span class="sr">${text}</span>` : text;
      if (icon) b.title = text;
      b.addEventListener('click', () => { app.opts[key] = v; markMeta(); app.refreshOptions(); app.board.drawOverlay(); });
      w.append(b);
    }
  };
  const button = (text, fn, ghost = false) => { const b = add(`<button type="button" class="opt-btn${ghost ? ' ghost' : ''}">${text}</button>`); b.addEventListener('click', fn); };
  const note = (text) => add(`<span class="opt-note">${text}</span>`);

  if (t.id === 'hand') {
    note('ドラッグで移動・ピンチやホイールで拡大');
    button('全体を表示', () => app.board.fit(), true);
  }
  if (t.id === 'pen' || t.id === 'eraser') sizeSlider();
  if (t.id === 'line') {
    sizeSlider();
    toggle('snap', '角度をそろえる');
    toggle('poly', '折れ線');
    if (app.opts.poly) {
      if (t.points.length) {
        note(`${formatLength(t.length(t.points), app.kmPerPx)}`);
        button('1つ戻る', () => t.undoPoint(), true);
        button('確定', () => t.finish());
      } else note('タップで点を打ち、最後の点を2回タップで確定');
    }
  }
  if (t.id === 'shape') {
    seg('shape', SHAPES, '図形の種類');
    if (app.opts.shape === 'arrow') toggle('arrowBoth', '両方向');
    else if (app.opts.shape !== 'line') {
      seg('style', [['stroke', '枠線'], ['fill', '塗り'], ['both', '両方']], '描き方');
      toggle('lock', { rect: '正方形', ellipse: '正円', triangle: '正三角形' }[app.opts.shape] || 'そろえる');
    }
    sizeSlider();
    if (t.shape && !t.op) {
      button('取り消す', () => t.discard(), true);
      button('確定', () => t.commit());
    }
  }
  if (t.id === 'fill') {
    seg('fillRef', [['visible', '見えている地図'], ['layer', 'このレイヤー']], '塗る範囲の決め方');
    const wrap = add('<label class="opt"><span>似た色も塗る</span><input type="range" min="0" max="60" step="1" aria-label="似た色も塗る範囲"><output></output></label>');
    const r = $('input', wrap), o = $('output', wrap);
    r.value = app.opts.tolerance;
    o.textContent = `${app.opts.tolerance}%`;
    r.addEventListener('input', () => { app.opts.tolerance = Number(r.value); o.textContent = `${r.value}%`; markMeta(); });
  }
  if (t.id === 'eyedropper') note('地図をタップして、その色を取ります');
  updateUndoButtons();
};

/* ---------- 色 ---------- */

function setColor(hex, { remember = false } = {}) {
  hex = String(hex).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(hex)) return;
  app.color = hex;
  $('#colorChip').style.background = hex;
  $('#colorBig').style.background = hex;
  $('#colorInput').value = hex;
  if (document.activeElement !== $('#hexInput')) $('#hexInput').value = hex;
  document.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-pressed', String(s.dataset.c === hex)));
  if (remember) rememberColor(hex);
  markMeta();
  app.board?.drawOverlay();
}
app.setColor = (hex) => setColor(hex, { remember: true });

function rememberColor(hex) {
  app.recent = [hex, ...app.recent.filter((c) => c !== hex)].slice(0, 8);
  renderRecent();
}

function swatch(c) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch';
  b.dataset.c = c;
  b.style.background = c;
  b.setAttribute('aria-label', c);
  b.setAttribute('aria-pressed', String(c === app.color));
  b.addEventListener('click', () => setColor(c));
  return b;
}

function renderRecent() { $('#recentRow').replaceChildren(...app.recent.map(swatch)); }

function initColor() {
  $('#paletteRow').replaceChildren(...PALETTE.map(swatch));
  renderRecent();
  $('#colorBtn').addEventListener('click', () => togglePop('colorPanel', 'colorBtn'));
  $('#colorInput').addEventListener('input', (e) => setColor(e.target.value));
  $('#colorInput').addEventListener('change', (e) => setColor(e.target.value, { remember: true }));
  $('#hexInput').addEventListener('input', (e) => {
    let v = e.target.value.trim();
    if (!v.startsWith('#')) v = `#${v}`;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(v);
  });
  $('#hexInput').addEventListener('change', (e) => { e.target.value = app.color; });
}

/* ---------- 浮いて出るパネル ---------- */

const POPS = [['colorPanel', 'colorBtn'], ['layersPanel', 'layersBtn'], ['saveMenu', 'saveBtn'], ['discordPanel', 'saveBtn']];

function togglePop(id, btnId, open) {
  const el = $(`#${id}`);
  const want = open ?? el.hidden;
  closePops();
  if (!want) return;
  if (id === 'saveMenu' || id === 'layersPanel') commitPending();
  el.hidden = false;
  $(`#${btnId}`).setAttribute('aria-expanded', 'true');
  if (id === 'layersPanel') renderLayers();
  if (id === 'saveMenu') prepareSaveMenu();
}

function closePops() {
  app.prefs?.close();
  for (const [id, btn] of POPS) {
    $(`#${id}`).hidden = true;
    $(`#${btn}`).setAttribute('aria-expanded', 'false');
  }
}

/** 確定していない図形・折れ線を確定する */
function commitPending() { app.tool?.deactivate?.(); app.refreshOptions(); }

/* ---------- レイヤー ---------- */

function afterLayersChanged() {
  markMeta();
  if (!$('#layersPanel').hidden) renderLayers();
  app.board.request();
  updateUndoButtons();
}

/** お絵かきレイヤーを追加（元に戻せる） */
function addLayer({ quiet = false, copyOf = null } = {}) {
  const { doc } = app;
  if (doc.drawLayers.length >= MAX_DRAW_LAYERS) { toast(`お絵かきレイヤーは ${MAX_DRAW_LAYERS} 枚までです`, { error: true }); return null; }
  let layer;
  if (copyOf) {
    const tiles = new Map();
    for (const [k, t] of copyOf.tiles) { const c = newCanvas(TILE, TILE); c.getContext('2d').drawImage(t, 0, 0); tiles.set(k, c); }
    layer = doc.createDrawLayer({ name: `${copyOf.name} のコピー`, opacity: copyOf.opacity, tiles });
  } else {
    layer = doc.createDrawLayer({ name: `レイヤー${app.meta.nextNum++}` });
  }
  // 選んでいるレイヤーのすぐ上に入れる（なければいちばん上）
  const ref = doc.indexOf(copyOf?.id || app.selectedId || doc.activeId);
  const index = ref >= 0 ? ref + 1 : doc.layers.length;
  const prevActive = doc.activeId, prevSel = app.selectedId;
  const doIt = () => { doc.insert(layer, index); doc.activeId = layer.id; app.selectedId = layer.id; markLayerTiles(layer); };
  doIt();
  app.history.push({
    label: copyOf ? 'レイヤーの複製' : 'レイヤーの追加',
    bytes: 0,
    undo: async () => { doc.remove(layer.id); dropLayer(layer.id); doc.activeId = prevActive; app.selectedId = prevSel; return {}; },
    redo: async () => { doIt(); return {}; },
  });
  if (!quiet) toast(`「${layer.name}」を追加しました`);
  afterLayersChanged();
  return layer;
}

function removeLayer(id) {
  const { doc } = app;
  const l = doc.layer(id);
  if (!l || l.kind !== 'draw') return;
  const wasActive = doc.activeId === id;
  const r = doc.remove(id);
  dropLayer(id);
  app.selectedId = doc.activeId || doc.layers.at(-1)?.id;
  app.history.push({
    label: 'レイヤーの削除',
    bytes: 0,
    undo: async () => { doc.insert(r.layer, r.index); markLayerTiles(r.layer); if (wasActive) doc.activeId = id; app.selectedId = id; return {}; },
    redo: async () => { doc.remove(id); dropLayer(id); app.selectedId = doc.activeId || doc.layers.at(-1)?.id; return {}; },
  });
  toast(`「${l.name}」を削除しました（元に戻せます）`);
  afterLayersChanged();
}

function moveLayer(id, dir) {
  const { doc } = app;
  const from = doc.indexOf(id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= doc.layers.length) return;
  doc.move(id, to);
  app.history.push({
    label: 'レイヤーの並べ替え',
    bytes: 0,
    undo: async () => { doc.move(id, from); return {}; },
    redo: async () => { doc.move(id, to); return {}; },
  });
  afterLayersChanged();
}

function setLayerProp(id, key, from, to, label) {
  const l = app.doc.layer(id);
  if (!l || from === to) return;
  l[key] = to;
  app.history.push({
    label,
    bytes: 0,
    undo: async () => { l[key] = from; app.doc.changed({ layers: true }); return {}; },
    redo: async () => { l[key] = to; app.doc.changed({ layers: true }); return {}; },
  });
  afterLayersChanged();
}

let thumbTimer;
function scheduleThumbs() {
  if ($('#layersPanel').hidden) return;
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(drawThumbs, 400);
}

const mapThumbs = new Map();  // 地図のレイヤーは変わらないので、一度作ったら使い回す
function drawThumbs() {
  const { doc } = app;
  document.querySelectorAll('.lrow').forEach((row) => {
    const l = doc.layer(row.dataset.id);
    const c = $('canvas', row);
    if (!l || !c) return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (l.kind === 'map' && mapThumbs.has(l.id)) { ctx.drawImage(mapThumbs.get(l.id), 0, 0); return; }
    doc.render(ctx, 0, 0, doc.w, doc.h, c.width / doc.w, { layers: [{ ...l, visible: true, opacity: 1 }], hidden: true });
    if (l.kind === 'map') { const k = newCanvas(c.width, c.height); k.getContext('2d').drawImage(c, 0, 0); mapThumbs.set(l.id, k); }
  });
}

function renderLayers() {
  const { doc } = app;
  const ul = $('#layerRows');
  ul.replaceChildren();
  const nDraw = doc.drawLayers.length;
  $('#layerCount').textContent = `お絵かき ${nDraw}/${MAX_DRAW_LAYERS}`;
  $('#addLayerBtn').disabled = nDraw >= MAX_DRAW_LAYERS;
  const list = [...doc.layers].reverse();
  list.forEach((l, i) => {
    const li = document.createElement('li');
    li.className = 'lrow';
    li.dataset.id = l.id;
    li.classList.toggle('is-selected', l.id === app.selectedId);
    li.classList.toggle('is-hidden', !l.visible);
    const isActive = l.kind === 'draw' && l.id === doc.activeId;
    li.innerHTML = `
      <div class="lrow-main">
        <canvas class="lthumb" width="120" height="${Math.round((120 * doc.h) / doc.w)}"></canvas>
        <span class="lname"><strong></strong><small></small></span>
        <button type="button" class="eye-btn" aria-label="${l.visible ? '非表示にする' : '表示する'}" aria-pressed="${l.visible}">${l.visible ? EYE : EYE_OFF}</button>
      </div>
      <div class="lrow-tools">
        <label class="lrow-op"><span>透明度</span><input type="range" min="0" max="100" step="1"><output></output></label>
        <div class="lrow-btns"></div>
      </div>`;
    $('strong', li).textContent = l.name;
    $('small', li).textContent = l.kind === 'map' ? '地図のレイヤー' : isActive ? '✏️ 描き込み先' : 'お絵かきレイヤー';
    $('.lrow-main', li).addEventListener('click', (e) => {
      if (e.target.closest('.eye-btn, input')) return;
      app.selectedId = l.id;
      if (l.kind === 'draw') doc.activeId = l.id;
      markMeta();
      renderLayers();
    });
    $('.eye-btn', li).addEventListener('click', () => { l.visible = !l.visible; doc.changed({ layers: true }); renderLayers(); });
    const r = $('input[type=range]', li), o = $('output', li);
    r.value = Math.round(l.opacity * 100);
    o.textContent = `${r.value}%`;
    let from = l.opacity;
    r.addEventListener('pointerdown', () => { from = l.opacity; });
    r.addEventListener('focus', () => { from = l.opacity; });
    r.addEventListener('input', () => { l.opacity = Number(r.value) / 100; o.textContent = `${r.value}%`; app.board.request(); });
    r.addEventListener('change', () => setLayerProp(l.id, 'opacity', from, Number(r.value) / 100, '透明度の変更'));
    const btns = $('.lrow-btns', li);
    const btn = (text, fn, { disabled = false, cls = '' } = {}) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `pill-btn ${cls}`.trim();
      b.textContent = text;
      b.disabled = disabled;
      b.addEventListener('click', fn);
      btns.append(b);
    };
    btn('↑ 上へ', () => moveLayer(l.id, +1), { disabled: i === 0 });
    btn('↓ 下へ', () => moveLayer(l.id, -1), { disabled: i === list.length - 1 });
    if (l.kind === 'draw') {
      btn('複製', () => addLayer({ copyOf: l }), { disabled: nDraw >= MAX_DRAW_LAYERS });
      btn('名前を変更', () => renameInline(li, l));
      btn('削除', () => removeLayer(l.id), { cls: 'danger' });
    }
    ul.append(li);
  });
  drawThumbs();
  $('.lrow.is-selected', ul)?.scrollIntoView({ block: 'nearest' });
}

function renameInline(li, l) {
  const box = $('.lname', li);
  const input = document.createElement('input');
  input.value = l.name;
  input.maxLength = 40;
  input.setAttribute('aria-label', 'レイヤー名');
  box.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== l.name) setLayerProp(l.id, 'name', l.name, name, '名前の変更');
    else renderLayers();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

function initLayers() {
  $('#layersBtn').addEventListener('click', () => togglePop('layersPanel', 'layersBtn'));
  $('#layersClose').addEventListener('click', closePops);
  $('#addLayerBtn').addEventListener('click', () => addLayer());
}

/* ---------- 保存 ---------- */

const fileTitle = () => safeName(app.config.title || '地図', '地図');

function prepareSaveMenu() {
  $('#saveLayers').hidden = true;
  $('#saveMain').hidden = false;
  const flat = !appEl.classList.contains('is-cylinder');
  const view = $('.save-item[data-act=view]');
  view.disabled = !flat;
  $('[data-note]', view).textContent = flat ? '画面に映っている範囲をPNGに' : '平面表示に切り替えると使えます';
  const last = app.meta.lastBackupAt;
  $('#backupNote').textContent = last
    ? `前回：${new Date(last).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    : 'お絵かきレイヤーをまとめてファイルに';
  // レイヤーの一覧
  const items = saveItems();
  const ul = $('#saveList');
  ul.replaceChildren();
  for (const it of items) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'lname';
    name.textContent = it.layer.name;
    const sm = document.createElement('small');
    sm.textContent = it.layer.kind === 'draw' ? 'お絵かき' : '地図';
    name.append(sm);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill-btn';
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5v10M8 10.5l4 4 4-4M5 18.5h14"/></svg><span>保存</span>';
    b.addEventListener('click', () => run(b, () => saveLayer(it)));
    li.append(name, b);
    ul.append(li);
  }
}

/** レイヤー画像の一覧（手前から）とファイル名 */
function saveItems() {
  const seen = new Map();
  return [...app.doc.layers].reverse().map((layer) => {
    const n = safeName(layer.name, 'レイヤー');
    const c = (seen.get(n) || 0) + 1;
    seen.set(n, c);
    return { layer, file: `${c > 1 ? `${n}_${c}` : n}.png` };
  });
}

async function layerBlob(it) {
  const l = it.layer;
  if (l.kind === 'map') {
    const res = await fetch(`../${l.src}`, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`「${l.name}」の画像を読み込めませんでした`);
    const b = await res.blob();
    if (b.type === 'image/png') return b;
    const c = newCanvas(app.doc.w, app.doc.h);
    c.getContext('2d').drawImage(l.img, 0, 0, app.doc.w, app.doc.h);
    return canvasToBlob(c);
  }
  const c = app.doc.layerCanvas(l);
  const blob = await canvasToBlob(c);
  c.width = c.height = 0;
  return blob;
}

const done = (r, f) => (r === 'cancelled' ? '' : r === 'shared' ? `${f} を書き出しました` : `${f} を保存しました`);

async function saveLayer(it) { return done(await deliver(await layerBlob(it), it.file), it.file); }

async function saveAllLayers() {
  const JSZip = window.JSZip || await loadJSZip('../assets/vendor/');
  const zip = new JSZip();
  for (const it of saveItems()) zip.file(it.file, await layerBlob(it));
  const f = `${fileTitle()}_お絵かき_レイヤー.zip`;
  return done(await deliver(await zip.generateAsync({ type: 'blob' }), f), f);
}

async function saveFull() {
  const c = app.doc.composite(1);
  const f = `${fileTitle()}_お絵かき_全体.png`;
  const r = await deliver(await canvasToBlob(c), f);
  c.width = c.height = 0;
  return done(r, f);
}

async function saveView() {
  const c = viewCanvas();
  const f = `${fileTitle()}_お絵かき_表示範囲_${stamp()}.png`;
  const r = await deliver(await canvasToBlob(c), f);
  c.width = c.height = 0;
  return done(r, f);
}

/** 画面に映っている範囲（地図の解像度のまま。拡大しているときはその細かさで） */
function viewCanvas() {
  const { doc, board } = app;
  const v = board.visibleRect();
  const x = v.w >= doc.w ? board.cam.x - doc.w / 2 : v.x;
  const w = Math.min(v.w, doc.w);
  const y = Math.max(0, v.y), h = Math.min(doc.h, v.y + v.h) - y;
  if (h <= 0) throw new Error('画面に地図が映っていません');
  const k = Math.min(Math.max(1, board.cam.s * board.size.dpr), 8192 / Math.max(w, h));
  const c = newCanvas(Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
  doc.render(c.getContext('2d'), x, y, w, h, k);
  return c;
}

/** Discord に送る画像 */
async function discordImage(kind, layerId) {
  if (kind === 'full') return { canvas: app.doc.composite(1) };
  if (kind === 'view') return { canvas: viewCanvas() };
  const it = saveItems().find((x) => x.layer.id === layerId);
  if (!it) throw new Error('レイヤーが見つかりません');
  if (it.layer.kind === 'draw') return { canvas: app.doc.layerCanvas(it.layer) };
  const canvas = newCanvas(app.doc.w, app.doc.h);
  canvas.getContext('2d').drawImage(it.layer.img, 0, 0, app.doc.w, app.doc.h);
  let blob = null;
  try { blob = await layerBlob(it); } catch { /* キャンバスから作る */ }
  return { canvas, blob };
}

const hasDiscord = () => /^https:\/\//.test(String(app.config.discord?.workerUrl || '').trim());

/* ---------- 表示の設定（自分用）と、管理ページで決めた機能のオン・オフ ---------- */

function initPrefs() {
  const items = [
    { key: 'tool-hand', group: '道具', label: '移動' },
    { key: 'tool-eraser', group: '道具', label: '消しゴム', site: 'tool-eraser' },
    { key: 'tool-line', group: '道具', label: '定規', site: 'tool-line' },
    { key: 'tool-shape', group: '道具', label: '図形', site: 'tool-shape' },
    { key: 'tool-fill', group: '道具', label: '塗りつぶし', site: 'tool-fill' },
    { key: 'tool-eyedropper', group: '道具', label: 'スポイト', site: 'tool-eyedropper' },
    { key: 'undo', group: '下のバー', label: '元に戻す・やり直すボタン（Ctrl+Z・Ctrl+Y はそのまま使えます）' },
    { key: 'cyl', group: '上の欄', label: '筒・平面の切り替え' },
    { key: 'back', group: '上の欄', label: '閲覧ページに戻るボタン' },
    { key: 'draw-save', group: '保存メニュー', label: '画像の保存（レイヤー・地図全体・表示範囲）', site: 'draw-save' },
  ];
  if (hasDiscord()) items.push({ key: 'draw-discord', group: '保存メニュー', label: 'Discordに送る', site: 'draw-discord' });
  app.prefs = new Prefs({
    page: 'draw',
    app: appEl,
    panel: $('#prefsPanel'),
    button: $('#prefsBtn'),
    items,
    config: app.config,
    onOpen: () => closePops(),
    onChange: () => {
      if (app.tool && !app.toolOn(app.tool.id)) selectTool('pen');
      if (!app.prefs?.on('cyl') && appEl.classList.contains('is-cylinder')) app.setMode?.('flat');
    },
  });
}

function initDiscord() {
  const url = String(app.config.discord?.workerUrl || '').trim();
  if (!hasDiscord() || !siteOn(app.config, 'draw-discord')) return;
  document.querySelectorAll('[data-discord]').forEach((el) => { el.hidden = false; });
  app.discord = createDiscord({
    worker: url,
    makeImage: discordImage,
    layers: () => saveItems().map((it) => ({ id: it.layer.id, name: `${it.layer.name}（${it.layer.kind === 'draw' ? 'お絵かき' : '地図'}）` })),
    isFlat: () => !appEl.classList.contains('is-cylinder'),
    beforeLeave: () => flushSave(),
    open: (id, btn) => togglePop(id, btn, true),
    toast,
  });
  if (app.discord.reopen) setTimeout(() => app.discord.open(), 0);
}

/* ---------- 作業の保存・再開（ZIP） ---------- */

async function saveWork() {
  const JSZip = window.JSZip || await loadJSZip('../assets/vendor/');
  const { doc } = app;
  await flushSave();
  const zip = new JSZip();
  const meta = buildMeta();
  meta.app = 'cylinder-viewer-draw';
  meta.title = app.config.title || '';
  meta.layers = meta.layers.map((l) => (l.kind === 'draw' && doc.layer(l.id).tiles.size ? { ...l, file: `layers/${l.id}.png` } : l));
  for (const l of doc.drawLayers) {
    if (!l.tiles.size) continue;
    const c = doc.layerCanvas(l);
    zip.file(`layers/${l.id}.png`, await canvasToBlob(c));
    c.width = c.height = 0;
  }
  zip.file('work.json', JSON.stringify(meta, null, 2));
  const f = `${fileTitle()}_お絵かき作業_${stamp()}.zip`;
  const r = await deliver(await zip.generateAsync({ type: 'blob' }), f);
  if (r !== 'cancelled') {
    app.meta.lastBackupAt = Date.now();
    markMeta();
    hideBanner();
  }
  return done(r, f);
}

async function loadWork(file) {
  const JSZip = window.JSZip || await loadJSZip('../assets/vendor/');
  let zip;
  try { zip = await JSZip.loadAsync(file); } catch { throw new Error('ZIP ファイルを開けませんでした'); }
  const jf = zip.file('work.json');
  if (!jf) throw new Error('お絵かきの作業ファイルではありません（work.json がありません）');
  const meta = JSON.parse(await jf.async('string'));
  if (meta.app !== 'cylinder-viewer-draw' || !Array.isArray(meta.layers)) throw new Error('お絵かきの作業ファイルではありません');
  const when = meta.savedAt ? new Date(meta.savedAt).toLocaleString('ja-JP') : '不明';
  const hasWork = app.doc.hasDrawing();
  if (hasWork && !confirm(`作業を再開すると、今描いている内容はこのファイルの内容に置き換わります（元に戻せません）。\n\nファイルの保存日時：${when}\n\n続けますか？`)) return '';
  const { doc } = app;
  app.setBusy('作業を読み込んでいます…');
  try {
    // 今のお絵かきレイヤーを外す
    for (const l of doc.drawLayers) doc.remove(l.id);
    const created = [];
    for (const lm of meta.layers) {
      if (lm.kind === 'map') {
        const l = doc.layer(lm.id);
        if (l) { l.visible = lm.visible; l.opacity = lm.opacity; }
        continue;
      }
      const layer = doc.createDrawLayer({ id: lm.id || newId(), name: lm.name || 'レイヤー', visible: lm.visible !== false, opacity: lm.opacity ?? 1 });
      const f = lm.file && zip.file(lm.file);
      if (f) {
        const bmp = await createImageBitmap(await f.async('blob'));
        layer.tiles = doc.tilesFromImage(bmp);
        bmp.close?.();
      }
      created.push(layer);
      doc.layers.push(layer);
    }
    applyOrder(meta.order || meta.layers.map((l) => l.id));
    doc.activeId = doc.layer(meta.activeId)?.kind === 'draw' ? meta.activeId : doc.drawLayers.at(-1)?.id || null;
    app.selectedId = doc.activeId || doc.layers.at(-1)?.id;
    if (meta.color) setColor(meta.color);
    app.meta.nextNum = Math.max(app.meta.nextNum, meta.nextNum || 1);
    app.meta.firstEditAt = app.meta.firstEditAt || meta.firstEditAt || Date.now();
    app.meta.lastBackupAt = Date.now();
    app.history.clear();
    // ブラウザの保存も入れ替える
    await app.store.clear();
    saveState.tiles.clear();
    for (const l of created) markLayerTiles(l);
    markMeta();
    await flushSave();
    afterLayersChanged();
    app.board.request();
  } finally {
    app.setBusy(null);
  }
  const warn = meta.mapSig && meta.mapSig !== app.mapSig ? '（保存したときから地図が更新されています）' : '';
  return `作業を再開しました${warn}`;
}

/** ボタンを処理中の表示にして実行し、結果を知らせる */
async function run(el, fn) {
  if (el.classList.contains('is-busy')) return;
  el.classList.add('is-busy');
  const label = el.matches('.pill-btn') ? $('span', el) : null;
  const before = label?.textContent;
  if (label) label.textContent = '作成中';
  try {
    const msg = await fn();
    if (msg) toast(msg);
  } catch (e) {
    console.error(e);
    toast(e.message || '保存できませんでした', { error: true });
  } finally {
    el.classList.remove('is-busy');
    if (label) label.textContent = before;
  }
}

function initSave() {
  $('#saveBtn').addEventListener('click', () => togglePop('saveMenu', 'saveBtn'));
  $('#saveBack').addEventListener('click', () => { $('#saveLayers').hidden = true; $('#saveMain').hidden = false; });
  $('#saveMain').addEventListener('click', (e) => {
    const item = e.target.closest('.save-item');
    if (!item || item.disabled) return;
    const act = item.dataset.act;
    if (act === 'layers') { $('#saveMain').hidden = true; $('#saveLayers').hidden = false; }
    if (act === 'full') run(item, saveFull);
    if (act === 'view') run(item, saveView);
    if (act === 'work-save') run(item, saveWork);
    if (act === 'discord') app.discord?.open();
  });
  $('#saveZip').addEventListener('click', (e) => run(e.currentTarget, saveAllLayers));
  $('#workFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    closePops();
    run($('.save-item[data-act=work-load]'), () => loadWork(f));
  });
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pop, .save-menu, .dock, .opts, .banner, .prefs-panel, #prefsBtn')) return;
    if (e.target.closest('#board')) return;  // 地図の上は Board 側で閉じる
    closePops();
  });
  $('#bannerClose').addEventListener('click', () => { hideBanner(); app.bannerDismissed = true; });
}

/* ---------- バックアップのおすすめ ---------- */

function checkBackup() {
  if (app.bannerDismissed || !app.doc.hasDrawing()) return;
  const since = app.meta.lastBackupAt || app.meta.firstEditAt;
  if (!since || Date.now() - since < BACKUP_DAYS * 86400_000) return;
  $('#bannerText').textContent = app.meta.lastBackupAt
    ? `最後のバックアップから${BACKUP_DAYS}日以上たっています。作業をファイルに保存しておきませんか？`
    : 'まだバックアップがありません。作業をファイルに保存しておきませんか？';
  const act = $('#bannerAct');
  act.textContent = '保存する';
  act.onclick = () => run(act, saveWork);
  $('#banner').hidden = false;
}
function hideBanner() { $('#banner').hidden = true; }

/* ---------- 筒・平面・表示を隠す ---------- */

function initMode() {
  const modeBtns = [...document.querySelectorAll('.mode-switch button')];
  const setMode = async (mode) => {
    modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    closePops();
    if (mode === 'cylinder') {
      commitPending();
      appEl.classList.add('is-cylinder');
      $('#opts').innerHTML = '<span class="opt-note">筒は見た目の確認用です。描くときは「平面」に戻してください</span>';
      const el = $('#cyl');
      el.hidden = false;
      app.setBusy('筒の表示を準備しています…');
      try {
        if (!app.stage) {
          const { Stage } = await import('../engine.js?v=20261028-1');
          app.stage = new Stage(el, { resolveUrl: (src) => `../${src}`, flatPadding: { top: 72, bottom: bottomPad() } });
          await app.stage.load({ title: '', base: null, layers: [], background: app.config.background || {}, display: { ...(app.config.display || {}), autoRotate: false } });
        }
        app.stage.setPadding({ top: 72, bottom: bottomPad() });
        const c = app.doc.composite(Math.min(1, 4096 / app.doc.w));
        app.stage.setSource(c);
        app.stage.setMode('cylinder');
        if (!app.stage.gl) toast('このブラウザでは筒の表示ができません', { error: true });
      } finally {
        app.setBusy(null);
      }
    } else {
      appEl.classList.remove('is-cylinder');
      $('#cyl').hidden = true;
      app.refreshOptions();
      app.board.request();
    }
  };
  modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  app.setMode = setMode;

  const uiBtn = $('#uiBtn');
  const setHidden = (hidden) => {
    appEl.classList.toggle('ui-hidden', hidden);
    uiBtn.setAttribute('aria-pressed', String(hidden));
    const label = hidden ? '表示を戻す' : '表示を隠す';
    uiBtn.setAttribute('aria-label', label);
    uiBtn.title = `${label}（H）`;
    if (hidden) closePops();
  };
  uiBtn.addEventListener('click', () => setHidden(!appEl.classList.contains('ui-hidden')));
  app.toggleUi = () => setHidden(!appEl.classList.contains('ui-hidden'));
}

/* ---------- キーボード ---------- */

function initKeys() {
  const keys = { v: 'hand', p: 'pen', b: 'pen', e: 'eraser', l: 'line', s: 'shape', u: 'shape', g: 'fill', i: 'eyedropper' };
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (appEl.classList.contains('is-cylinder')) {  // 筒は確認用なので、表示を隠す以外は受け付けない
      if (k === 'h' && !e.ctrlKey && !e.metaKey) app.toggleUi();
      if (e.key === 'Escape') closePops();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ') { app.board.spaceDown = true; $('#board').classList.add('is-panning'); e.preventDefault(); return; }
    if (e.key === 'Escape') {
      if (app.tool?.id === 'shape' && app.tool.shape) app.tool.discard();
      else if (app.tool?.id === 'line' && app.tool.points.length) app.tool.discard();
      else closePops();
      return;
    }
    if (e.key === 'Enter') {
      if (app.tool?.id === 'shape' && app.tool.shape) app.tool.commit();
      if (app.tool?.id === 'line' && app.tool.points.length) app.tool.finish();
      return;
    }
    if (e.key === 'Backspace' && app.tool?.id === 'line' && app.tool.points.length) { app.tool.undoPoint(); return; }
    if (k === 'h') { app.toggleUi(); return; }
    if (k === '0') { app.board.fit(); return; }
    if (e.key === '[' || e.key === ']') {
      const id = app.tool?.id;
      if (id in app.sizes) {
        app.sizes[id] = Math.max(1, Math.min(120, app.sizes[id] + (e.key === ']' ? 1 : -1) * Math.max(1, Math.round(app.sizes[id] * 0.15))));
        app.refreshOptions();
        app.board.drawOverlay();
      }
      return;
    }
    if (keys[k]) selectTool(keys[k]);
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') { app.board.spaceDown = false; $('#board').classList.remove('is-panning'); }
  });
}

main().catch((e) => {
  console.error(e);
  statusEl.innerHTML = `<p>読み込み中にエラーが発生しました：${e.message}</p>`;
});
