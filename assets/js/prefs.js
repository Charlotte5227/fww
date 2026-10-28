// 機能のオン・オフ
//
// ・サイト全体：管理ページで決めて data/config.json の features に保存（全員に効く）
// ・自分用：各ページの「⚙ 表示の設定」で決めて、このブラウザにだけ保存（その人にだけ効く）
// どちらかでオフになっている項目は、ページの #app に `hide-〇〇` のクラスが付いて隠れる。

/** サイト全体の機能（管理ページのチェック欄）。初期値はすべてオン */
export const SITE_FEATURES = [
  { key: 'history', group: '閲覧ページ', label: '過去の地図（日付の切り替え）' },
  { key: 'opacity', group: '閲覧ページ', label: '透明度の変更' },
  { key: 'save', group: '閲覧ページ', label: '画像の保存' },
  { key: 'draw', group: 'お絵かきページ', label: 'お絵かきページを使えるようにする' },
  { key: 'tool-eraser', group: 'お絵かきページ', label: '消しゴム' },
  { key: 'tool-line', group: 'お絵かきページ', label: '定規' },
  { key: 'tool-shape', group: 'お絵かきページ', label: '図形' },
  { key: 'tool-fill', group: 'お絵かきページ', label: '塗りつぶし' },
  { key: 'tool-eyedropper', group: 'お絵かきページ', label: 'スポイト' },
  { key: 'draw-save', group: 'お絵かきページ', label: '画像の保存（作業のバックアップはいつでも使えます）' },
  { key: 'draw-discord', group: 'お絵かきページ', label: 'Discord に送る（Worker の URL を入れているときだけ）' },
];

/** サイト全体でオンになっているか */
export function siteOn(config, key) {
  return config?.features?.[key] !== false;
}

const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できなくても、その場では効く */ } };

/**
 * 自分用の表示の設定
 * @param {object} o
 * @param {string} o.page          'viewer' | 'draw'
 * @param {HTMLElement} o.app      クラスを付ける要素
 * @param {HTMLElement} o.panel    設定パネル（中身はここで作る）
 * @param {HTMLElement} o.button   パネルを開くボタン
 * @param {{key:string,label:string,group:string,site?:string}[]} o.items  site を書くと、その機能がサイト全体でオフのときは出さない
 * @param {object} o.config        data/config.json
 * @param {(prefs:Prefs)=>void} [o.onChange]
 * @param {()=>void} [o.onOpen]    パネルを開く前（ほかのパネルを閉じる）
 */
export class Prefs {
  constructor(o) {
    this.o = o;
    this.storeKey = `cv-prefs:${o.page}:${location.pathname.replace(/[^/]*$/, '').replace(/\/draw\/$/, '/')}`;
    this.user = read(this.storeKey);
    this.apply();
    o.button.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen) { this.close(); o.button.focus(); } });
    document.addEventListener('pointerdown', (e) => {
      if (this.isOpen && !o.panel.contains(e.target) && !o.button.contains(e.target)) this.close();
    });
  }

  get isOpen() { return !this.o.panel.hidden; }

  /** サイト全体と自分用の両方でオンか */
  on(key) {
    const item = this.o.items.find((i) => i.key === key);
    if (item?.site && !siteOn(this.o.config, item.site)) return false;
    return this.user[key] !== false;
  }

  /** サイト全体でオンか（自分用の設定は見ない） */
  site(key) { return siteOn(this.o.config, key); }

  apply() {
    const { app, items } = this.o;
    for (const it of items) app.classList.toggle(`hide-${it.key}`, !this.on(it.key));
    // サイト全体でオフの機能も同じクラスで隠す
    for (const f of SITE_FEATURES) if (!siteOn(this.o.config, f.key)) app.classList.add(`hide-${f.key}`);
    this.o.onChange?.(this);
  }

  set(key, on) {
    if (on) delete this.user[key]; else this.user[key] = false;
    write(this.storeKey, this.user);
    this.apply();
  }

  reset() {
    this.user = {};
    write(this.storeKey, this.user);
    this.apply();
    this.render();
  }

  render() {
    const { panel, items, config } = this.o;
    panel.replaceChildren();
    const head = document.createElement('div');
    head.className = 'prefs-head';
    head.innerHTML = '<h2>表示の設定</h2><button type="button" class="prefs-close" aria-label="閉じる"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    head.querySelector('button').addEventListener('click', () => { this.close(); this.o.button.focus(); });
    const note = document.createElement('p');
    note.className = 'prefs-note';
    note.textContent = 'このブラウザだけの設定です。チェックを外したものは画面から隠れます（ほかの人には影響しません）。';
    panel.append(head, note);
    let hiddenBySite = 0;
    const groups = new Map();
    for (const it of items) {
      if (it.site && !siteOn(config, it.site)) { hiddenBySite++; continue; }
      if (!groups.has(it.group)) {
        const g = document.createElement('fieldset');
        g.className = 'prefs-group';
        const lg = document.createElement('legend');
        lg.textContent = it.group;
        g.append(lg);
        groups.set(it.group, g);
        panel.append(g);
      }
      const label = document.createElement('label');
      label.className = 'prefs-item';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = this.user[it.key] !== false;
      input.addEventListener('change', () => this.set(it.key, input.checked));
      const span = document.createElement('span');
      span.textContent = it.label;
      label.append(input, span);
      groups.get(it.group).append(label);
    }
    const foot = document.createElement('div');
    foot.className = 'prefs-foot';
    if (hiddenBySite) {
      const p = document.createElement('p');
      p.className = 'prefs-note';
      p.textContent = '管理する人がオフにしている機能は、ここには出てきません。';
      foot.append(p);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'prefs-reset';
    reset.textContent = 'すべて表示に戻す';
    reset.addEventListener('click', () => this.reset());
    foot.append(reset);
    panel.append(foot);
  }

  open() {
    this.o.onOpen?.();
    this.render();
    this.o.panel.hidden = false;
    this.o.button.setAttribute('aria-expanded', 'true');
  }

  close() {
    if (this.o.panel.hidden) return;
    this.o.panel.hidden = true;
    this.o.button.setAttribute('aria-expanded', 'false');
  }
}

export const GEAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
