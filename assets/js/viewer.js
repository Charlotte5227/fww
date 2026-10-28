// 閲覧サイト
import { Stage } from './engine.js?v=20261028-1';
import { Dial } from './dial.js?v=20261028-1';
import { SaveMenu } from './save.js?v=20261028-1';
import { History } from './history.js?v=20261028-1';

const $ = (s) => document.querySelector(s);
const app = $('#app');
const statusEl = $('#status');
const hintEl = $('#hint');
const autoBtn = $('#autoBtn');
const modeBtns = [...document.querySelectorAll('.mode-switch button')];
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const SLIDERS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>';

let stage;
let dial;
let config;      // 今表示している版の設定
let saveMenu;
let history;

function setStatus(html) { statusEl.innerHTML = html; }

let toastTimer;
function toast(msg, { error = false } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('is-error', error);
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), error ? 5000 : 3000);
}

/* ---------- パネルの開閉（同時に開くのは 1 つだけ） ---------- */

const opacity = {
  panel: $('#layerPanel'),
  tool: null,
  get isOpen() { return !this.panel.hidden; },
};

function closePanels(except) {
  if (except !== 'opacity') openOpacity(false);
  if (except !== 'save') saveMenu?.close();
  if (except !== 'history') history?.close();
}

// スマホでは下側に出る透明度パネルを避けて、地図をその上の空いた範囲に表示する
const narrow = matchMedia('(max-width: 600px)');
function fitAroundPanel() {
  if (opacity.isOpen && narrow.matches) {
    const r = opacity.panel.getBoundingClientRect();
    stage?.setPadding({ top: 110, bottom: Math.max(90, window.innerHeight - r.top + 8) });
  } else {
    stage?.setPadding({ top: 110, bottom: 90 });
  }
}

function openOpacity(open) {
  if (open === opacity.isOpen) return;
  if (open) { closePanels('opacity'); hintEl.classList.add('is-gone'); }
  opacity.panel.hidden = !open;
  opacity.tool?.setAttribute('aria-expanded', String(open));
  fitAroundPanel();
}

function initPanels() {
  new ResizeObserver(fitAroundPanel).observe(opacity.panel);
  narrow.addEventListener('change', fitAroundPanel);
  $('#panelClose').addEventListener('click', () => { openOpacity(false); opacity.tool?.focus(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && opacity.isOpen) { openOpacity(false); opacity.tool?.focus(); }
  });
  $('#opacityReset').addEventListener('click', () => {
    for (const l of config.layers || []) stage.setLayerOpacity(l.id, null);
    buildLayerUI();
  });
}

/** 地図以外の表示（タイトル・レイヤー欄・操作パネルなど）を隠す／戻す */
function setUiHidden(hidden) {
  const btn = $('#uiBtn');
  app.classList.toggle('ui-hidden', hidden);
  btn.setAttribute('aria-pressed', String(hidden));
  const label = hidden ? '表示を戻す' : '表示を隠す';
  btn.setAttribute('aria-label', label);
  btn.title = `${label}（H）`;
  if (hidden) {
    closePanels();
    hintEl.classList.add('is-gone');
  }
}

function setMode(mode) {
  stage.setMode(mode);
}

function onMode(mode) {
  hintEl.classList.add('is-gone');
  app.classList.toggle('is-flat', mode === 'flat');
  modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  saveMenu?.refreshMode();
}

function makeCheck() {
  const box = document.createElement('span');
  box.className = 'box';
  box.innerHTML = CHECK;
  return box;
}

/** 上部のチェック欄と透明度パネルを、今表示している版のレイヤーで作り直す（両方の表示は常に同期） */
function buildLayerUI() {
  const list = $('#layerList');
  const panelList = $('#panelList');
  list.replaceChildren();
  panelList.replaceChildren();
  if (history?.chip) list.append(history.chip);
  // 管理画面と同じく「手前に重なるもの」から並べる
  const layers = [...(config.layers || [])].reverse();
  $('#layerbar').hidden = layers.length === 0 && !history?.chip;
  if (!layers.length) { openOpacity(false); return; }

  const views = new Map(); // id -> { chip, panelCheck, range, out, row }
  let allInput = null;

  const syncAll = () => {
    if (!allInput) return;
    const on = layers.filter((l) => stage.isLayerVisible(l.id)).length;
    allInput.checked = on === layers.length;
    allInput.indeterminate = on > 0 && on < layers.length;
  };
  const showVisible = (id) => {
    const v = views.get(id);
    const on = stage.isLayerVisible(id);
    v.chip.checked = on;
    v.panelCheck.checked = on;
    v.row.classList.toggle('is-off', !on);
  };
  const showOpacity = (id) => {
    const v = views.get(id);
    const pct = Math.round(stage.getLayerOpacity(id) * 100);
    v.range.value = pct;
    v.out.textContent = `${pct}%`;
  };
  const setVisible = (id, on) => {
    stage.setLayerVisible(id, on);
    showVisible(id);
    syncAll();
  };

  // 透明度パネルを開くボタン
  const tool = document.createElement('button');
  tool.type = 'button';
  tool.className = 'chip tool';
  tool.setAttribute('aria-expanded', String(opacity.isOpen));
  tool.setAttribute('aria-controls', 'layerPanel');
  tool.innerHTML = `${SLIDERS}<span class="name">透明度</span>`;
  tool.addEventListener('click', () => openOpacity(!opacity.isOpen));
  opacity.tool = tool;
  list.append(tool);

  const makeChip = (name, checked, onChange, extraClass = '') => {
    const label = document.createElement('label');
    label.className = `chip ${extraClass}`.trim();
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const span = document.createElement('span');
    span.className = 'name';
    span.textContent = name;
    label.append(input, makeCheck(), span);
    list.append(label);
    return input;
  };

  if (layers.length >= 2) {
    allInput = makeChip('すべて', false, (on) => { for (const l of layers) setVisible(l.id, on); }, 'all');
  }

  for (const l of layers) {
    const name = l.name || '名前なし';
    const chip = makeChip(name, stage.isLayerVisible(l.id), (on) => setVisible(l.id, on));

    // パネルの行
    const row = document.createElement('li');
    row.className = 'prow';
    const label = document.createElement('label');
    label.className = 'chip-like';
    const panelCheck = document.createElement('input');
    panelCheck.type = 'checkbox';
    panelCheck.addEventListener('change', () => setVisible(l.id, panelCheck.checked));
    const nm = document.createElement('span');
    nm.className = 'name';
    nm.textContent = name;
    label.append(panelCheck, makeCheck(), nm);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.step = '1';
    range.setAttribute('aria-label', `${name}の不透明度`);
    const out = document.createElement('output');
    range.addEventListener('input', () => {
      stage.setLayerOpacity(l.id, Number(range.value) / 100);
      out.textContent = `${range.value}%`;
      // 非表示のレイヤーを調整し始めたら表示する
      if (!stage.isLayerVisible(l.id)) setVisible(l.id, true);
    });
    row.append(label, range, out);
    panelList.append(row);

    views.set(l.id, { chip, panelCheck, range, out, row });
    showVisible(l.id);
    showOpacity(l.id);
  }
  syncAll();
}

function setTitle(version) {
  const title = config.title || '筒ビューア';
  $('#title').textContent = title;
  document.title = version?.date ? `${title}（${version.short}）` : title;
}

/** 表示する版（最新・過去の日付）を切り替える。レイヤーの表示状態や拡大はそのまま */
async function showVersion(v, { initial = false } = {}) {
  config = v.config;
  setTitle(v);
  if (!initial) await stage.load(config, { keepView: true, syncVisible: false });
  buildLayerUI();
  saveMenu?.setConfig(config, v.date ? `${v.date}${v.time ? `_${v.time.replace(':', '')}` : ''}` : '');
}

function setupHint() {
  const touch = matchMedia('(pointer: coarse)').matches;
  hintEl.textContent = touch ? 'ドラッグで回転／ピンチで拡大' : 'ドラッグで回転／ホイールで拡大';
  hintEl.hidden = false;
  hintEl.classList.remove('is-gone');
  const hide = () => hintEl.classList.add('is-gone');
  setTimeout(hide, 6000);
  return hide;
}

async function main() {
  let hideHint = () => {};
  stage = new Stage($('#stage'), {
    onAngle: (a) => dial?.set(a),
    onMode,
    onAutoRotate: (on) => autoBtn.setAttribute('aria-pressed', String(on)),
    onInteract: () => hideHint(),
    onState: (state, { failed } = {}) => {
      if (state === 'loading') setStatus('<div><div class="spinner"></div>読み込み中</div>');
      else if (state === 'empty') setStatus('<p>表示する画像がまだありません。<br>管理ページから下地画像かレイヤーを追加してください。</p>');
      else setStatus('');
      if (failed?.length) {
        console.warn('読み込めなかった画像:', failed);
        toast('一部の画像を読み込めませんでした', { error: true });
      }
    },
  });
  dial = new Dial($('#dial'), {
    onDrag: (d, kb) => {
      if (stage.autoRotate) stage.setAutoRotate(false);
      kb ? stage.nudge(d) : stage.rotateBy(d);
      hideHint();
    },
  });
  initPanels();

  let latest;
  const historyFile = fetch('data/history.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  try {
    const res = await fetch('data/config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latest = await res.json();
  } catch (e) {
    setStatus('<p>設定ファイル（data/config.json）を読み込めませんでした。<br>ファイルが公開されているか確認してください。</p>');
    console.error(e);
    return;
  }

  history = new History({
    latest,
    file: await historyFile,
    onSelect: (v) => showVersion(v).then(() => toast(v.date ? `${v.long} の地図を表示しています` : '最新の地図を表示しています')),
    onOpen: () => closePanels('history'),
  });
  const first = history.initial();   // URL に ?date= があればその日付
  config = first.config;
  setTitle(first);
  const disp = latest.display || {};

  await stage.load(config);
  saveMenu = new SaveMenu({ stage, config, toast, onOpen: () => { closePanels('save'); hintEl.classList.add('is-gone'); } });
  await showVersion(first, { initial: true });
  if (first.date) toast(`${first.long} の地図を表示しています`);
  dial.set(stage.angle);

  if (!stage.gl) {
    modeBtns.find((b) => b.dataset.mode === 'cylinder').disabled = true;
    setMode('flat');
  } else {
    setMode(disp.defaultMode === 'flat' ? 'flat' : 'cylinder');
  }
  stage.setAutoRotate(!!disp.autoRotate && !matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (stage.composite.width) hideHint = setupHint();

  modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  autoBtn.addEventListener('click', () => stage.setAutoRotate(!stage.autoRotate));
  $('#resetBtn').addEventListener('click', () => stage.resetView());
  $('#uiBtn').addEventListener('click', () => setUiHidden(!app.classList.contains('ui-hidden')));
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, [role="slider"]')) return;
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.metaKey && !e.altKey) setUiHidden(!app.classList.contains('ui-hidden'));
    if (e.key === 'ArrowLeft') { stage.setAutoRotate(false); stage.nudge(-20); }
    if (e.key === 'ArrowRight') { stage.setAutoRotate(false); stage.nudge(20); }
  });
}

main();
