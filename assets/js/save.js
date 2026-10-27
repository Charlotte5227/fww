// 閲覧ページの「画像を保存」メニュー
const $ = (s, el = document) => el.querySelector(s);
const DOWNLOAD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5v10M8 10.5l4 4 4-4M5 18.5h14"/></svg>';

/** ファイル名に使えない文字を置き換える */
export function safeName(name, fallback = '画像') {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 80);
  return s || fallback;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function canvasToBlob(canvas) {
  return new Promise((ok, ng) => canvas.toBlob((b) => (b ? ok(b) : ng(new Error('画像を作成できませんでした'))), 'image/png'));
}

let jszipPromise;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipPromise ||= new Promise((ok, ng) => {
    const s = document.createElement('script');
    s.src = 'assets/vendor/jszip.min.js';
    s.onload = () => ok(window.JSZip);
    s.onerror = () => { jszipPromise = null; ng(new Error('ZIP 機能を読み込めませんでした')); };
    document.head.append(s);
  });
  return jszipPromise;
}

/**
 * スマホでは共有メニュー（「画像を保存」で写真に保存できる）を、
 * それ以外ではダウンロードを使う。
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      // 操作から時間が経って共有が許可されなかった場合などはダウンロードに切り替える
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return 'downloaded';
}

export class SaveMenu {
  /**
   * @param {{stage: import('./engine.js').Stage, config: object, toast: Function, onOpen?: Function}} p
   */
  constructor({ stage, config, toast, onOpen }) {
    Object.assign(this, { stage, config, toast, onOpen });
    this.menu = $('#saveMenu');
    this.btn = $('#saveBtn');
    this.main = $('#saveMain');
    this.layersView = $('#saveLayers');
    this.title = safeName(config.title, '地図');

    this.btn.addEventListener('click', () => this.toggle());
    $('#saveBack').addEventListener('click', () => this.showMain(true));
    this.main.addEventListener('click', (e) => {
      const item = e.target.closest('.save-item');
      if (!item || item.disabled) return;
      if (item.dataset.act === 'layers') this.showLayers();
      if (item.dataset.act === 'full') this.run(item, () => this.saveFull());
      if (item.dataset.act === 'view') this.run(item, () => this.saveView());
    });
    $('#saveZip').addEventListener('click', (e) => this.run(e.currentTarget, () => this.saveZip()));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen) { this.close(); this.btn.focus(); } });
    // メニューの外を触ったら閉じる
    document.addEventListener('pointerdown', (e) => {
      if (this.isOpen && !this.menu.contains(e.target) && !this.btn.contains(e.target)) this.close();
    });
    this.buildLayerList();
  }

  /** 表示している版が変わったとき（過去の日付なら、保存するファイル名に日付を付ける） */
  setConfig(config, date = '') {
    this.config = config;
    this.title = safeName(`${config.title || '地図'}${date ? `_${date}` : ''}`, '地図');
    this.buildLayerList();
    this.showMain(false);
  }

  get isOpen() { return !this.menu.hidden; }

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    this.onOpen?.();
    this.refreshMode();
    this.showMain(false);
    this.menu.hidden = false;
    this.btn.setAttribute('aria-expanded', 'true');
  }

  close() {
    this.menu.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
  }

  /** 筒表示では「地図全体」「表示範囲」は使えないことを示す */
  refreshMode() {
    const flat = this.stage.mode === 'flat';
    this.main.querySelectorAll('[data-flat]').forEach((b) => {
      b.disabled = !flat;
      const note = $('[data-note]', b);
      note.dataset.text ||= note.textContent;
      note.textContent = flat ? note.dataset.text : '平面表示に切り替えると使えます';
    });
  }

  showMain(focus) {
    this.layersView.hidden = true;
    this.main.hidden = false;
    if (focus) $('[data-act="layers"]', this.main).focus();
  }

  showLayers() {
    this.main.hidden = true;
    this.layersView.hidden = false;
    $('#saveBack').focus();
  }

  /** 保存できる画像の一覧（下地＋レイヤー。手前のレイヤーから） */
  items() {
    const list = [...(this.config.layers || [])].reverse().map((l) => ({ name: l.name || '名前なし', src: l.src }));
    if (this.config.base?.src) list.push({ name: '下地', src: this.config.base.src, isBase: true });
    // 同じ名前があればファイル名に番号を付ける
    const seen = new Map();
    for (const it of list) {
      const n = safeName(it.name, 'レイヤー');
      const c = (seen.get(n) || 0) + 1;
      seen.set(n, c);
      it.file = `${c > 1 ? `${n}_${c}` : n}.png`;
    }
    return list.filter((it) => it.src);
  }

  buildLayerList() {
    const ul = $('#saveList');
    ul.replaceChildren();
    for (const it of this.items()) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'lname';
      name.textContent = it.name;
      if (it.isBase) {
        const sm = document.createElement('small');
        sm.textContent = 'いちばん下の画像';
        name.append(sm);
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pill-btn';
      b.innerHTML = `${DOWNLOAD}<span>保存</span>`;
      b.setAttribute('aria-label', `${it.name}を保存（${it.file}）`);
      b.addEventListener('click', () => this.run(b, () => this.saveLayer(it)));
      li.append(name, b);
      ul.append(li);
    }
  }

  /** ボタンを処理中の表示にして実行し、結果を知らせる */
  async run(el, fn) {
    if (el.classList.contains('is-busy')) return;
    el.classList.add('is-busy');
    el.setAttribute('aria-busy', 'true');
    const label = el.matches('.pill-btn') ? $('span', el) : null;
    const before = label?.textContent;
    if (label) label.textContent = '作成中';
    try {
      const msg = await fn();
      if (msg) this.toast(msg);
    } catch (e) {
      console.error(e);
      this.toast(e.message || '保存できませんでした', { error: true });
    } finally {
      el.classList.remove('is-busy');
      el.removeAttribute('aria-busy');
      if (label) label.textContent = before;
    }
  }

  done(result, filename) {
    if (result === 'cancelled') return '';
    return result === 'shared' ? `${filename} を書き出しました` : `${filename} を保存しました`;
  }

  /** レイヤー画像を PNG で取得（PNG 以外の形式なら変換） */
  async layerBlob(it) {
    const res = await fetch(it.src, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`「${it.name}」の画像を読み込めませんでした`);
    const blob = await res.blob();
    if (blob.type === 'image/png') return blob;
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    try { await img.decode(); } finally { URL.revokeObjectURL(img.src); }
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return canvasToBlob(c);
  }

  async saveLayer(it) {
    return this.done(await deliver(await this.layerBlob(it), it.file), it.file);
  }

  async saveZip() {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    for (const it of this.items()) zip.file(it.file, await this.layerBlob(it));
    const file = `${this.title}_レイヤー.zip`;
    const blob = await zip.generateAsync({ type: 'blob' });
    return this.done(await deliver(blob, file), file);
  }

  async saveFull() {
    const canvas = this.stage.exportFull();
    if (!canvas) throw new Error('保存できる地図がありません');
    const file = `${this.title}_全体.png`;
    return this.done(await deliver(await canvasToBlob(canvas), file), file);
  }

  async saveView() {
    const canvas = this.stage.captureView();
    if (!canvas) throw new Error('画面に地図が映っていません');
    const file = `${this.title}_表示範囲_${stamp()}.png`;
    return this.done(await deliver(await canvasToBlob(canvas), file), file);
  }
}
