// 管理サイト
import { Stage } from './engine.js?v=20261028-1';
import { GitHubClient, guessRepo } from './github.js?v=20261028-1';

const $ = (s, el = document) => el.querySelector(s);
const STORE_KEY = 'cylinder-viewer:github';
const MAX_SIDE = 8192;
const MAX_AREA = 16_000_000;
const IMAGE_DIR = 'data/images/';
const KEEP_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

const state = {
  config: null,
  loadedRefs: new Set(),   // 最後に読み込んだ／公開した設定が参照している画像
  pending: new Map(),      // まだリポジトリにない画像 src -> { blob, url }
  localUrls: new Map(),    // 表示用のローカル URL（公開直後・GitHub から直接取得したもの）
  dims: new Map(),         // src -> Promise<{w,h}>
  dirty: false,
  gh: null,
  history: [],             // 履歴（新しい日付が先）{ date, savedAt, memo, config }
  restore: new Map(),      // 履歴の読み込みで、リポジトリの過去から戻す画像 path -> blob sha
  previewing: null,        // プレビュー中の履歴
};

/* ---------- 共通 ---------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const baseName = (n) => (n || '').replace(/\.[^.]+$/, '').slice(0, 40);

let toastTimer;
function toast(msg, { error = false, ms = 3200 } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('is-error', error);
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
}

function defaultConfig() {
  return {
    version: 1,
    title: '',
    base: null,
    layers: [],
    background: { src: '', color: '#141a2e', fit: 'cover' },
    display: { defaultMode: 'cylinder', autoRotate: true, rotateSpeed: 6, shading: 0.55, startAngle: 180 },
  };
}

function normalize(cfg) {
  const d = defaultConfig();
  const c = { ...d, ...cfg };
  c.background = { ...d.background, ...(cfg.background || {}) };
  c.display = { ...d.display, ...(cfg.display || {}) };
  c.layers = (cfg.layers || []).map((l) => ({ id: l.id || uid(), name: l.name || '', src: l.src, visible: l.visible !== false, opacity: l.opacity ?? 1 }));
  c.base = cfg.base?.src ? { name: cfg.base.name || '下地', src: cfg.base.src } : null;
  return c;
}

/** 今の地図と履歴が使っている画像すべて */
function allRefs(cfg, history = state.history) {
  const s = refs(cfg);
  for (const h of history) for (const r of refs(h.config)) s.add(r);
  return s;
}

const todayStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDate = (ymd) => {
  const [y, m, d] = String(ymd).split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const w = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日（${w}）`;
};

const nowTime = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const fmtEntry = (e) => `${fmtDate(e.date)}${e.time ? ` ${e.time}` : ''}`;
// 新しい記録が先。同じ日付は時刻、時刻もなければ記録した順
const entryKey = (e) => `${e.date} ${e.time || ''} ${e.savedAt || ''}`;
const sortHistory = (list) => list.sort((a, b) => entryKey(b).localeCompare(entryKey(a)));

// 2 つの設定が同じ地図かどうか
function sameMap(a, b) {
  const norm = (c) => JSON.stringify({ base: c?.base?.src || '', layers: (c?.layers || []).map((l) => [l.id, l.src, l.opacity ?? 1, l.visible !== false]), bg: c?.background?.src || '' });
  return norm(a) === norm(b);
}

function normalizeHistory(h) {
  const list = Array.isArray(h?.entries) ? h.entries : [];
  const used = new Set();
  return sortHistory(list
    .filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.config)
    .map((e) => {
      // 以前の形式（1日1件・id なし）の記録は、日付を id にし、記録した時刻を補う
      let id = String(e.id || e.date);
      while (used.has(id)) id = `${id}-${uid().slice(-3)}`;
      used.add(id);
      const saved = e.savedAt ? new Date(e.savedAt) : null;
      const time = e.time ?? (saved && !Number.isNaN(+saved) && todayStr(saved) === e.date ? nowTime(saved) : '');
      return { id, date: e.date, time: time || '', savedAt: e.savedAt || '', memo: e.memo || '', config: normalize(e.config) };
    }));
}

function historyJson(history) {
  const entries = history.map((e) => ({ id: e.id, date: e.date, time: e.time || '', savedAt: e.savedAt, memo: e.memo, config: stripConfig(e.config) }));
  return `${JSON.stringify({ version: 2, entries }, null, 2)}\n`;
}

function stripConfig(c) {
  const out = structuredClone(c);
  out.layers = (out.layers || []).map(({ _new, ...l }) => l);
  return out;
}

function refs(cfg) {
  const s = new Set();
  if (cfg.base?.src) s.add(cfg.base.src);
  if (cfg.background?.src) s.add(cfg.background.src);
  for (const l of cfg.layers) if (l.src) s.add(l.src);
  return new Set([...s].filter((x) => x.startsWith(IMAGE_DIR)));
}

/* ---------- 画像の URL 解決 ---------- */

const resolveCache = new Map();
async function resolveUrl(src) {
  if (!src) return '';
  if (/^(blob:|data:|https?:)/.test(src)) return src;
  const p = state.pending.get(src);
  if (p) return p.url;
  if (state.localUrls.has(src)) return state.localUrls.get(src);
  // 過去の公開から戻す画像は、まだ公開ページにないのでリポジトリの記録から直接読む
  if (state.restore.has(src) && state.gh) {
    const url = URL.createObjectURL(await state.gh.getBlobBySha(state.restore.get(src)));
    state.localUrls.set(src, url);
    return url;
  }
  if (resolveCache.has(src)) return resolveCache.get(src);
  const pr = (async () => {
    const rel = `../${src}`;
    try {
      const r = await fetch(rel, { method: 'HEAD', cache: 'no-cache' });
      if (r.ok) return rel;
    } catch { /* 下へ */ }
    // まだ GitHub Pages に反映されていない画像はリポジトリから直接取得する
    if (state.gh) {
      try {
        const url = URL.createObjectURL(await state.gh.getBlob(src));
        state.localUrls.set(src, url);
        return url;
      } catch { /* 下へ */ }
    }
    return rel;
  })();
  resolveCache.set(src, pr);
  return pr;
}

function getDims(src) {
  if (!src) return Promise.resolve(null);
  if (!state.dims.has(src)) {
    state.dims.set(src, resolveUrl(src).then((url) => new Promise((ok) => {
      const img = new Image();
      img.onload = () => ok({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => ok(null);
      img.src = url;
    })));
  }
  return state.dims.get(src);
}

function loadImg(url) {
  return new Promise((ok, ng) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => ng(new Error('画像として読み込めませんでした'));
    img.src = url;
  });
}

/** ファイルを取り込み、必要なら縮小して、公開待ちの画像として登録する */
async function importImage(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('画像ファイルを選んでください');
  const tmp = URL.createObjectURL(file);
  let img;
  try { img = await loadImg(tmp); } finally { URL.revokeObjectURL(tmp); }
  let w = img.naturalWidth || 1024;
  let h = img.naturalHeight || 1024;
  let blob = file;
  let type = file.type;
  const s = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));
  if (s < 1 || !KEEP_TYPES.includes(type)) {
    w = Math.round(w * s); h = Math.round(h * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    type = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    blob = await new Promise((ok) => c.toBlob(ok, type, 0.9));
  }
  const src = `${IMAGE_DIR}${uid()}.${EXT[type] || 'png'}`;
  state.pending.set(src, { blob, url: URL.createObjectURL(blob) });
  state.dims.set(src, Promise.resolve({ w, h }));
  return { src, w, h, name: baseName(file.name), resized: s < 1 };
}

/* ---------- 変更の管理・プレビュー ---------- */

let stage;
let previewTimer;
function refreshPreview() {
  if (state.previewing) { state.previewing = null; $('#previewBack').hidden = true; renderHistory(); }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => stage.load(structuredClone(state.config), { keepView: true, syncVisible: true }), 120);
}

function markDirty() {
  state.dirty = true;
  updatePublishBar();
  refreshPreview();
}

function updatePublishBar() {
  const bar = $('.publish');
  bar.classList.toggle('is-dirty', state.dirty);
  $('#publishMsg').textContent = state.dirty
    ? (state.gh ? '公開していない変更があります' : '変更があります（公開するには GitHub に接続）')
    : '変更はありません';
  $('#publishBtn').disabled = !state.dirty;
}

/* ---------- 画面の描画 ---------- */

function renderAll() {
  const c = state.config;
  $('#title').value = c.title || '';
  renderSlot($('#baseSlot'), c.base, '未設定', {
    onFile: async (file) => {
      const r = await importImage(file);
      c.base = { name: r.name || '下地', src: r.src };
      afterImport(r);
      renderAll(); markDirty();
    },
    onRemove: () => { c.base = null; renderAll(); markDirty(); },
  });
  renderSlot($('#bgSlot'), c.background.src ? { name: '背景画像', src: c.background.src } : null, '背景画像なし（背景色のみ）', {
    onFile: async (file) => {
      const r = await importImage(file);
      c.background.src = r.src;
      afterImport(r);
      renderAll(); markDirty();
    },
    onRemove: () => { c.background.src = ''; renderAll(); markDirty(); },
  });
  $('#bgColor').value = c.background.color || '#141a2e';
  $('#bgColorText').value = c.background.color || '#141a2e';
  $('#bgFit').value = c.background.fit || 'cover';
  const d = c.display;
  $('#defaultMode').value = d.defaultMode;
  $('#autoRotate').checked = !!d.autoRotate;
  $('#rotateSpeed').value = d.rotateSpeed;
  $('#shading').value = d.shading;
  $('#startAngle').value = d.startAngle;
  $('#widthKm').value = d.widthKm > 0 ? d.widthKm : '';
  renderOutputs();
  renderLayers();
  renderHistory();
}

function renderOutputs() {
  const d = state.config.display;
  $('#speedOut').textContent = `1周 約${Math.round(360 / d.rotateSpeed)}秒`;
  $('#shadingOut').textContent = d.shading <= 0 ? 'なし' : `${Math.round(d.shading * 100)}%`;
  $('#angleOut').textContent = `${Math.round(d.startAngle)}°（画像の左から${Math.round(d.startAngle / 3.6)}%の位置が正面）`;
  $('#widthKmOut').textContent = d.widthKm > 0 ? `${Number(d.widthKm).toLocaleString('ja-JP')} km` : '未設定';
}

function afterImport(r) {
  if (r.resized) toast(`大きな画像だったため ${r.w}×${r.h} に縮小しました`);
}

function setThumb(img, src) {
  img.removeAttribute('src');
  if (!src) return;
  resolveUrl(src).then((url) => { img.src = url; });
}

function renderSlot(slot, item, emptyLabel, { onFile, onRemove }) {
  slot.replaceChildren($('#slotTpl').content.cloneNode(true));
  slot.classList.toggle('is-empty', !item);
  const strong = $('strong', slot);
  const small = $('small', slot);
  if (item) {
    strong.textContent = item.name || '画像';
    setThumb($('img', slot), item.src);
    getDims(item.src).then((d) => { small.textContent = d ? `${d.w}×${d.h}px` : '画像を読み込めません'; });
    $('.file-btn span', slot).textContent = '画像を変更';
  } else {
    strong.textContent = emptyLabel;
    small.textContent = 'ドロップまたは「画像を選ぶ」で設定';
    $('.thumb', slot).textContent = 'なし';
  }
  $('input[type=file]', slot).addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) onFile(f).catch((err) => toast(err.message, { error: true }));
  });
  $('[data-act=remove]', slot).addEventListener('click', onRemove);
  slot._onDropFiles = (files) => onFile(files[0]).catch((err) => toast(err.message, { error: true }));
}

function renderLayers() {
  const list = $('#layerList');
  const layers = state.config.layers;
  list.replaceChildren();
  const baseDims = getDims(state.config.base?.src);
  // 手前（配列の後ろ）から表示
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    const li = $('#layerTpl').content.firstElementChild.cloneNode(true);
    li.dataset.id = l.id;
    if (l._new) { li.classList.add('is-new'); delete l._new; }
    setThumb($('img', li), l.src);
    const name = $('.layer-name', li);
    name.value = l.name;
    name.placeholder = 'レイヤー名';
    name.addEventListener('input', () => { l.name = name.value; markDirty(); });
    const vis = $('[data-k=visible]', li);
    vis.checked = l.visible;
    vis.addEventListener('change', () => { l.visible = vis.checked; markDirty(); });
    const op = $('[data-k=opacity]', li);
    op.value = l.opacity;
    op.addEventListener('input', () => { l.opacity = Number(op.value); markDirty(); });
    const info = $('.layer-info', li);
    const warn = $('.layer-warn', li);
    Promise.all([getDims(l.src), baseDims]).then(([d, b]) => {
      info.textContent = d ? `${d.w}×${d.h}px` : '画像を読み込めません';
      if (d && b && Math.abs(d.w / d.h - b.w / b.h) > 0.02) {
        warn.hidden = false;
        warn.textContent = '下地と縦横比が違うため、下地の大きさに合わせて伸縮されます';
      }
    });
    li.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const idx = layers.indexOf(l);
      if (act === 'up' && idx < layers.length - 1) { [layers[idx], layers[idx + 1]] = [layers[idx + 1], layers[idx]]; }
      else if (act === 'down' && idx > 0) { [layers[idx], layers[idx - 1]] = [layers[idx - 1], layers[idx]]; }
      else if (act === 'remove') {
        if (!confirm(`レイヤー「${l.name || '名前なし'}」を削除しますか？`)) return;
        layers.splice(idx, 1);
      } else return;
      renderLayers(); markDirty();
      if (act !== 'remove') $(`.layer[data-id="${l.id}"] [data-act="${act}"]`)?.focus();
    });
    $('.layer-actions input[type=file]', li).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const r = await importImage(f);
        l.src = r.src;
        afterImport(r);
        renderLayers(); markDirty();
        toast('画像を差し替えました');
      } catch (err) { toast(err.message, { error: true }); }
    });
    list.append(li);
  }
}

async function addLayers(files, { allowBase = false } = {}) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) { toast('画像ファイルが見つかりませんでした', { error: true }); return; }
  let added = 0;
  for (const f of imgs) {
    try {
      const r = await importImage(f);
      afterImport(r);
      if (allowBase && !state.config.base) {
        state.config.base = { name: r.name || '下地', src: r.src };
        toast('下地画像に設定しました');
        continue;
      }
      const n = state.config.layers.length + 1;
      const name = r.name && r.name.toLowerCase() !== 'image' ? r.name : `レイヤー ${n}`;
      state.config.layers.push({ id: uid(), name, src: r.src, visible: true, opacity: 1, _new: true });
      added++;
    } catch (err) { toast(err.message, { error: true }); }
  }
  renderAll(); markDirty();
  if (added) toast(`レイヤーを${added}件追加しました`);
}

/* ---------- 入力のつなぎ込み ---------- */

function bindInputs() {
  const c = () => state.config;
  $('#title').addEventListener('input', (e) => { c().title = e.target.value; markDirty(); });
  const setColor = (v) => {
    if (!/^#[0-9a-f]{6}$/i.test(v)) return false;
    c().background.color = v.toLowerCase();
    $('#bgColor').value = v; $('#bgColorText').value = v;
    markDirty();
    return true;
  };
  $('#bgColor').addEventListener('input', (e) => setColor(e.target.value));
  $('#bgColorText').addEventListener('change', (e) => { if (!setColor(e.target.value.trim())) { e.target.value = c().background.color; toast('色は #1a2b3c の形式で入力してください', { error: true }); } });
  $('#bgFit').addEventListener('change', (e) => { c().background.fit = e.target.value; markDirty(); });
  $('#defaultMode').addEventListener('change', (e) => { c().display.defaultMode = e.target.value; markDirty(); });
  $('#autoRotate').addEventListener('change', (e) => { c().display.autoRotate = e.target.checked; markDirty(); });
  $('#rotateSpeed').addEventListener('input', (e) => { c().display.rotateSpeed = Number(e.target.value); renderOutputs(); markDirty(); });
  $('#shading').addEventListener('input', (e) => { c().display.shading = Number(e.target.value); renderOutputs(); markDirty(); });
  $('#startAngle').addEventListener('input', (e) => {
    c().display.startAngle = Number(e.target.value);
    renderOutputs();
    stage.setAngle(c().display.startAngle);
    markDirty();
  });
  $('#widthKm').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (v > 0) c().display.widthKm = v; else delete c().display.widthKm;
    renderOutputs();
    markDirty();
  });
  $('#useAngle').addEventListener('click', () => {
    c().display.startAngle = Math.round(stage.angle) % 360;
    $('#startAngle').value = c().display.startAngle;
    renderOutputs(); markDirty();
    toast(`開いたときの向きを ${c().display.startAngle}° にしました`);
  });
  $('#layerFiles').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) addLayers(fs); });

  // クリップボード
  if (navigator.clipboard?.read) {
    const btn = $('#pasteBtn');
    btn.hidden = false;
    btn.addEventListener('click', async () => {
      try {
        const items = await navigator.clipboard.read();
        const files = [];
        for (const it of items) {
          const t = it.types.find((x) => x.startsWith('image/'));
          if (t) files.push(new File([await it.getType(t)], `image.${EXT[t] || 'png'}`, { type: t }));
        }
        if (!files.length) return toast('クリップボードに画像がありません', { error: true });
        addLayers(files, { allowBase: true });
      } catch {
        toast('クリップボードを読み取れませんでした。ブラウザの許可を確認してください', { error: true });
      }
    });
  }
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    addLayers(files, { allowBase: true });
  });

  // ドラッグ＆ドロップ
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    if (!e.target.closest('.drop')) addLayers(e.dataTransfer.files, { allowBase: true });
  });
  document.querySelectorAll('.drop').forEach((z) => {
    z.addEventListener('dragover', (e) => { e.preventDefault(); z.classList.add('is-over'); });
    z.addEventListener('dragleave', (e) => { if (!z.contains(e.relatedTarget)) z.classList.remove('is-over'); });
    z.addEventListener('drop', (e) => {
      e.preventDefault();
      z.classList.remove('is-over');
      const files = e.dataTransfer?.files;
      if (!files?.length) return;
      if (z.dataset.drop === 'layer') addLayers(files);
      else z._onDropFiles?.(files);
    });
  });

  // プレビューの表示切り替え
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => stage.setMode(b.dataset.mode)));

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  $('#publishBtn').addEventListener('click', publish);
  $('#previewBack').addEventListener('click', endPreview);
  $('#histImportBtn').addEventListener('click', importHistory);
  $('#histRecord').addEventListener('change', () => { $('#histNew').hidden = !$('#histRecord').checked; });
  $('#histDate').addEventListener('input', () => { newWhen.dateTouched = true; });
  $('#histTime').addEventListener('input', () => { newWhen.timeTouched = true; });
  resetNewEntryInputs();
  $('#zipBtn').addEventListener('click', exportZip);
}

/* ---------- GitHub ---------- */

function readStored() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || sessionStorage.getItem(STORE_KEY) || 'null');
  } catch { return null; }
}

function store(settings, remember) {
  try {
    localStorage.removeItem(STORE_KEY);
    sessionStorage.removeItem(STORE_KEY);
    if (settings) (remember ? localStorage : sessionStorage).setItem(STORE_KEY, JSON.stringify(settings));
  } catch { /* 保存できない環境 */ }
}

function showGhState() {
  const on = !!state.gh;
  $('#ghConnected').hidden = !on;
  $('#ghForm').hidden = on;
  if (state.config) renderHistory();
  if (on) $('#ghLabel').textContent = `${state.gh.owner}/${state.gh.repo}（${state.gh.branch}）に接続しています`;
  updatePublishBar();
}

function bindGitHub() {
  const form = $('#ghForm');
  const saved = readStored();
  const guess = guessRepo();
  form.owner.value = saved?.owner || guess.owner || '';
  form.repo.value = saved?.repo || guess.repo || '';
  form.branch.value = saved?.branch || '';
  if (saved?.token) state.gh = new GitHubClient(saved);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#ghMsg');
    msg.textContent = '';
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    btn.textContent = '確認しています…';
    const settings = {
      owner: form.owner.value.trim(),
      repo: form.repo.value.trim(),
      branch: form.branch.value.trim(),
      token: form.token.value.trim(),
    };
    try {
      const client = new GitHubClient(settings);
      const info = await client.verify();
      if (!info.canPush) throw new Error('このトークンにはリポジトリへの書き込み権限がありません。「Contents」を「Read and write」にしてください。');
      settings.branch = client.branch;
      store(settings, form.remember.checked);
      state.gh = client;
      form.token.value = '';
      showGhState();
      if (!state.dirty) await loadConfig();
      toast('GitHub に接続しました');
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '接続する';
    }
  });

  $('#ghDisconnect').addEventListener('click', () => {
    store(null);
    state.gh = null;
    showGhState();
    toast('接続を解除しました。トークンはこのブラウザから削除されました');
  });

  $('#ghReload').addEventListener('click', async () => {
    if (state.dirty && !confirm('公開していない変更は破棄されます。GitHub から読み込み直しますか？')) return;
    await loadConfig();
    toast('GitHub から読み込みました');
  });
  showGhState();
}

async function loadHistoryFile() {
  if (state.gh) {
    try { return JSON.parse(await state.gh.getText('data/history.json')); } catch (e) { if (e.status !== 404) console.warn(e); }
  }
  try {
    const r = await fetch('../data/history.json', { cache: 'no-cache' });
    if (r.ok) return await r.json();
  } catch { /* 履歴なし */ }
  return null;
}

async function loadConfig() {
  let cfg = null;
  let note = '';
  if (state.gh) {
    try {
      cfg = JSON.parse(await state.gh.getText('data/config.json'));
    } catch (e) {
      if (e.status === 404) note = 'リポジトリに data/config.json がないため、新しく作成します。';
      else if (e.status === 401 || e.status === 403) {
        note = `${e.message}（公開されているページの内容を表示しています）`;
      } else note = e.message;
    }
  }
  if (!cfg) {
    try {
      const r = await fetch('../data/config.json', { cache: 'no-cache' });
      if (r.ok) cfg = await r.json();
    } catch { /* 新規 */ }
  }
  state.config = normalize(cfg || defaultConfig());
  const histFile = await loadHistoryFile();
  state.historyLoaded = !!histFile;
  state.history = normalizeHistory(histFile);
  state.restore.clear();
  state.previewing = null;
  state.loadedRefs = allRefs(state.config);
  state.dirty = false;
  resolveCache.clear();
  renderAll();
  updatePublishBar();
  await stage.load(structuredClone(state.config));
  if (note) toast(note, { error: true, ms: 6000 });
}

/* ---------- 履歴 ---------- */

/** 「記録の日付・時刻」の入力。触っていなければ公開した日時を使う */
const newWhen = { dateTouched: false, timeTouched: false };
function resetNewEntryInputs() {
  newWhen.dateTouched = false;
  newWhen.timeTouched = false;
  $('#histDate').value = todayStr();
  $('#histTime').value = nowTime();
  $('#histMemo').value = '';
}

/** 直前に公開した記録（日付の並びではなく、公開した時刻がいちばん新しいもの） */
function lastPublished(list = state.history) {
  return list.reduce((a, e) => (!a || (e.savedAt || '') > (a.savedAt || '') ? e : a), null);
}

/** 公開後の履歴（「履歴に残す」がオンなら記録を追加、または直前の記録を上書き） */
function historyAfterPublish(cfg) {
  const list = state.history.map((e) => ({ ...e }));
  if (!$('#histRecord').checked) return list;
  const now = new Date();
  const date = newWhen.dateTouched && $('#histDate').value ? $('#histDate').value : todayStr(now);
  const time = newWhen.timeTouched ? $('#histTime').value : nowTime(now);
  const memo = $('#histMemo').value.trim();
  const last = lastPublished(list);
  const replace = document.querySelector('input[name="histMode"]:checked')?.value === 'replace' && last;
  if (replace) {
    const top = last;
    list[list.indexOf(last)] = {
      ...top,
      date: newWhen.dateTouched ? date : top.date,
      time: newWhen.timeTouched ? time : top.time,
      savedAt: now.toISOString(),
      memo: memo || top.memo,
      config: structuredClone(cfg),
    };
  } else {
    list.push({ id: uid(), date, time, savedAt: now.toISOString(), memo, config: structuredClone(cfg) });
  }
  return sortHistory(list);
}

function renderHistory() {
  const ul = $('#histList');
  if (!ul) return;
  ul.replaceChildren();
  $('#histEmpty').hidden = state.history.length > 0;
  $('#histImport').hidden = !state.gh;
  $('#histNew').hidden = !$('#histRecord').checked;
  const last = lastPublished();
  const replaceRadio = document.querySelector('input[name="histMode"][value="replace"]');
  replaceRadio.disabled = !last;
  if (!last) document.querySelector('input[name="histMode"][value="add"]').checked = true;
  $('#histReplaceTarget').textContent = last ? `（${fmtEntry(last)}${last.memo ? `・${last.memo}` : ''}）` : '（まだ記録がありません）';
  state.history.forEach((e, i) => {
    const li = $('#histTpl').content.firstElementChild.cloneNode(true);
    li.classList.toggle('is-today', i === 0);
    li.classList.toggle('is-previewing', state.previewing === e);
    const date = $('.hist-date', li);
    const time = $('.hist-time', li);
    date.value = e.date;
    time.value = e.time || '';
    const onWhen = () => {
      if (!date.value) { date.value = e.date; return; }
      e.date = date.value;
      e.time = time.value;
      sortHistory(state.history);
      renderHistory(); markDirty();
    };
    date.addEventListener('change', onWhen);
    time.addEventListener('change', onWhen);
    const memo = $('.hist-memo', li);
    memo.value = e.memo;
    memo.addEventListener('input', () => { e.memo = memo.value; markDirty(); });
    const n = (e.config.layers || []).length;
    const saved = e.savedAt ? new Date(e.savedAt) : null;
    $('.hist-info', li).textContent = `${i === 0 ? 'いちばん新しい記録・' : ''}レイヤー ${n} 枚${saved && !Number.isNaN(+saved) ? `・${saved.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} に公開` : ''}`;
    li.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'preview') previewHistory(e);
      if (act === 'restore') {
        if (state.dirty && !confirm(`編集中の内容を ${fmtEntry(e)} の地図に置き換えますか？（公開するまでは閲覧ページは変わりません）`)) return;
        state.config = normalize(structuredClone(e.config));
        state.previewing = null;
        $('#previewBack').hidden = true;
        renderAll(); markDirty();
        toast(`${fmtEntry(e)} の地図を編集に読み込みました`);
      }
      if (act === 'remove') {
        if (!confirm(`${fmtEntry(e)} の記録を削除しますか？（公開すると、この記録だけが使っていた画像も削除されます）`)) return;
        state.history.splice(state.history.indexOf(e), 1);
        if (state.previewing === e) endPreview();
        renderHistory(); markDirty();
      }
    });
    ul.append(li);
  });
}

function previewHistory(e) {
  state.previewing = e;
  clearTimeout(previewTimer);
  stage.load(structuredClone(e.config), { keepView: true, syncVisible: true });
  $('#previewBack').hidden = false;
  $('#previewNote').textContent = `${fmtEntry(e)} の地図をプレビュー中`;
  renderHistory();
}

function endPreview() {
  state.previewing = null;
  $('#previewBack').hidden = true;
  stage.load(structuredClone(state.config), { keepView: true, syncVisible: true });
  stage.opts.onMode(stage.mode);
  renderHistory();
}

/** GitHub に残っている過去の公開から履歴を作る（画像は過去のコミットからそのまま戻す） */
async function importHistory() {
  const btn = $('#histImportBtn');
  const all = $('#histImportAll').checked;
  btn.disabled = true;
  btn.textContent = '読み込み中…';
  try {
    const commits = await state.gh.commitsFor('data/config.json');
    const picked = [];
    const days = new Set();
    for (const c of commits) {  // 新しい順。1日1件なら、各日付の最初のものがその日の最後の公開
      if (!String(c.commit.message || '').startsWith('管理ページから')) continue;  // 手動のアップロードなどは除く
      const when = new Date(c.commit.committer?.date || c.commit.author?.date);
      const d = todayStr(when);
      if (!all && days.has(d)) continue;
      days.add(d);
      picked.push({ c, when });
    }
    let added = 0;
    for (const { c, when } of picked) {
      btn.textContent = `読み込み中…（${fmtDate(todayStr(when))} ${nowTime(when)}）`;
      let cfg;
      try { cfg = normalize(JSON.parse(await state.gh.getTextAt('data/config.json', c.sha))); } catch { continue; }
      if (!cfg.base && !cfg.layers.length) continue;
      if (state.history.some((e) => sameMap(e.config, cfg))) continue;  // 同じ内容の記録はもうある
      const tree = await state.gh.treeMap(c.commit.tree.sha);
      if ([...refs(cfg)].some((src) => !tree.has(src))) continue;  // 画像が揃っていない記録は使わない
      for (const src of refs(cfg)) if (!state.loadedRefs.has(src)) state.restore.set(src, tree.get(src));
      state.history.push({ id: uid(), date: todayStr(when), time: nowTime(when), savedAt: when.toISOString(), memo: '', config: cfg });
      added++;
    }
    sortHistory(state.history);
    resolveCache.clear();
    renderHistory();
    if (added) { markDirty(); toast(`${added} 件の記録を作りました。「公開する」で保存されます`); }
    else toast('追加できる過去の記録はありませんでした');
  } catch (err) {
    toast(err.message, { error: true, ms: 6000 });
  } finally {
    btn.disabled = false;
    btn.textContent = 'これまでの公開から履歴を作る';
  }
}

/* ---------- 公開 ---------- */

function cleanConfig() {
  const c = structuredClone(state.config);
  c.layers = c.layers.map(({ _new, ...l }) => l);
  return c;
}

async function publish() {
  if (!state.gh) {
    toast('公開するには、先に「公開先（GitHub）」で接続してください', { error: true, ms: 5000 });
    $('#ghPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#ghForm input[name=token]').focus({ preventScroll: true });
    return;
  }
  const dlg = $('#progress');
  const bar = $('#progressBar');
  const msg = $('#progressMsg');
  const close = $('#progressClose');
  dlg.classList.remove('is-error');
  $('#progressTitle').textContent = '公開しています';
  close.hidden = true;
  bar.style.width = '0%';
  msg.textContent = '準備中';
  dlg.showModal();

  const cfg = cleanConfig();
  const history = historyAfterPublish(cfg);
  const newRefs = allRefs(cfg, history);
  const uploads = [...state.pending.entries()].filter(([src]) => newRefs.has(src));
  const restores = [...state.restore.entries()].filter(([src]) => newRefs.has(src) && !state.pending.has(src));
  const deletes = [...state.loadedRefs].filter((src) => !newRefs.has(src));
  try {
    await state.gh.commit({
      files: [
        ...uploads.map(([path, p]) => ({ path, blob: p.blob })),
        ...restores.map(([path, sha]) => ({ path, sha })),
        { path: 'data/config.json', text: `${JSON.stringify(cfg, null, 2)}\n` },
        ...(history.length || state.historyLoaded ? [{ path: 'data/history.json', text: historyJson(history) }] : []),
      ],
      deletes,
      message: `管理ページから更新：${cfg.title || '筒ビューア'}`,
      onProgress: (m, r) => { msg.textContent = m; bar.style.width = `${Math.round(r * 100)}%`; },
    });
    for (const [src, p] of uploads) { state.localUrls.set(src, p.url); state.pending.delete(src); }
    for (const src of [...state.pending.keys()]) { URL.revokeObjectURL(state.pending.get(src).url); state.pending.delete(src); }
    state.loadedRefs = newRefs;
    state.history = history;
    state.restore.clear();
    state.historyLoaded = true;
    resetNewEntryInputs();
    document.querySelector('input[name="histMode"][value="add"]').checked = true;
    state.dirty = false;
    updatePublishBar();
    renderHistory();
    bar.style.width = '100%';
    $('#progressTitle').textContent = '公開しました';
    msg.textContent = '閲覧ページに反映されるまで、1〜2分ほどかかります。';
  } catch (err) {
    dlg.classList.add('is-error');
    $('#progressTitle').textContent = '公開できませんでした';
    msg.textContent = err.message;
  }
  close.hidden = false;
  close.focus();
}

/* ---------- ZIP 書き出し ---------- */

async function exportZip() {
  if (!window.JSZip) return toast('ZIP 機能の読み込み中です。少し待ってからもう一度お試しください', { error: true });
  const btn = $('#zipBtn');
  btn.disabled = true;
  btn.textContent = '作成中…';
  try {
    const zip = new window.JSZip();
    const cfg = cleanConfig();
    zip.file('data/config.json', `${JSON.stringify(cfg, null, 2)}\n`);
    const history = historyAfterPublish(cfg);
    if (history.length) zip.file('data/history.json', historyJson(history));
    for (const src of allRefs(cfg, history)) {
      const p = state.pending.get(src);
      const blob = p ? p.blob : await (await fetch(await resolveUrl(src))).blob();
      zip.file(src, blob);
    }
    const out = await zip.generateAsync({ type: 'blob' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(out), download: 'cylinder-viewer-data.zip' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('ZIP をダウンロードしました');
  } catch (err) {
    toast(`ZIP を作成できませんでした：${err.message}`, { error: true });
  } finally {
    btn.disabled = false;
    btn.textContent = 'ZIP をダウンロード';
  }
}

/* ---------- 起動 ---------- */

async function main() {
  stage = new Stage($('#pstage'), {
    resolveUrl,
    flatPadding: { top: 16, bottom: 16 },
    onMode: (mode) => {
      document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
      $('#previewNote').textContent = state.previewing
        ? `${fmtEntry(state.previewing)} の地図をプレビュー中`
        : mode === 'flat' ? 'プレビュー（左右にドラッグで回り込み）' : 'プレビュー（ドラッグで回転）';
    },
    onState: (s) => {
      if (s === 'empty') $('#previewNote').textContent = '画像を追加するとここに表示されます';
      if (s === 'ready') stage.opts.onMode(stage.mode);
    },
  });
  $('#progressClose').addEventListener('click', () => $('#progress').close());
  bindGitHub();
  bindInputs();
  await loadConfig();
}

main();
