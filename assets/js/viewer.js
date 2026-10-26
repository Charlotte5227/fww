// 閲覧サイト
import { Stage } from './engine.js';
import { Dial } from './dial.js';

const $ = (s) => document.querySelector(s);
const app = $('#app');
const statusEl = $('#status');
const hintEl = $('#hint');
const autoBtn = $('#autoBtn');
const modeBtns = [...document.querySelectorAll('.mode-switch button')];
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

let stage;
let dial;
let config;

function setStatus(html) { statusEl.innerHTML = html; }

function setMode(mode) {
  stage.setMode(mode);
}

function onMode(mode) {
  hintEl.classList.add('is-gone');
  app.classList.toggle('is-flat', mode === 'flat');
  modeBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
}

function buildLayerChips() {
  const list = $('#layerList');
  list.replaceChildren();
  // 管理画面と同じく「手前に重なるもの」から並べる
  const layers = [...(config.layers || [])].reverse();
  $('#layerbar').hidden = layers.length === 0;
  if (!layers.length) return;

  const inputs = [];
  let allInput = null;
  const syncAll = () => {
    if (!allInput) return;
    const on = inputs.filter((i) => i.checked).length;
    allInput.checked = on === inputs.length;
    allInput.indeterminate = on > 0 && on < inputs.length;
  };

  const makeChip = (name, checked, onChange, extraClass = '') => {
    const label = document.createElement('label');
    label.className = `chip ${extraClass}`.trim();
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    const box = document.createElement('span');
    box.className = 'box';
    box.innerHTML = CHECK;
    const span = document.createElement('span');
    span.className = 'name';
    span.textContent = name;
    label.append(input, box, span);
    list.append(label);
    return input;
  };

  if (layers.length >= 2) {
    allInput = makeChip('すべて', false, (on) => {
      inputs.forEach((i) => { i.checked = on; i.dispatchEvent(new Event('change')); });
    }, 'all');
  }
  for (const l of layers) {
    const input = makeChip(l.name || '名前なし', stage.isLayerVisible(l.id), (on) => {
      stage.setLayerVisible(l.id, on);
      syncAll();
    });
    inputs.push(input);
  }
  syncAll();
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
      if (failed?.length) console.warn('読み込めなかった画像:', failed);
    },
  });
  dial = new Dial($('#dial'), {
    onDrag: (d, kb) => {
      if (stage.autoRotate) stage.setAutoRotate(false);
      kb ? stage.nudge(d) : stage.rotateBy(d);
      hideHint();
    },
  });

  try {
    const res = await fetch('data/config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config = await res.json();
  } catch (e) {
    setStatus('<p>設定ファイル（data/config.json）を読み込めませんでした。<br>ファイルが公開されているか確認してください。</p>');
    console.error(e);
    return;
  }

  const title = config.title || '筒ビューア';
  $('#title').textContent = title;
  document.title = title;
  const disp = config.display || {};

  await stage.load(config);
  buildLayerChips();
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
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, [role="slider"]')) return;
    if (e.key === 'ArrowLeft') { stage.setAutoRotate(false); stage.nudge(-20); }
    if (e.key === 'ArrowRight') { stage.setAutoRotate(false); stage.nudge(20); }
  });
}

main();
