// 閲覧ページの「日付を選ぶ」（過去の地図の表示）
const $ = (s, el = document) => el.querySelector(s);
const CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>';

const ymd = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date) {
  const m = ymd.exec(date || '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return { y, mo, d, w: '日月火水木金土'[new Date(y, mo - 1, d).getDay()] };
}
const longDate = (date, time = '') => { const p = parts(date); return `${p ? `${p.y}年${p.mo}月${p.d}日（${p.w}）` : date}${time ? ` ${time}` : ''}`; };
const shortDate = (date, time = '') => { const p = parts(date); return `${p ? `${p.mo}月${p.d}日` : date}${time ? ` ${time}` : ''}`; };
const entryKey = (e) => `${e.date} ${e.time || ''} ${e.savedAt || ''}`;

// 設定の中身が同じかどうか（並び順に依存しない比較）
function same(a, b) {
  const norm = (c) => JSON.stringify({ base: c?.base?.src || '', layers: (c?.layers || []).map((l) => [l.id, l.src, l.opacity ?? 1, l.visible !== false]), bg: c?.background?.src || '' });
  return norm(a) === norm(b);
}

export class History {
  /**
   * @param {{latest: object, file: object|null, onSelect: Function, onOpen?: Function}} p
   */
  constructor({ latest, file, onSelect, onOpen }) {
    this.onSelect = onSelect;
    this.onOpen = onOpen;
    this.panel = $('#histPanel');
    this.list = $('#histList');

    const used = new Set();
    const entries = (Array.isArray(file?.entries) ? file.entries : [])
      .filter((e) => e && ymd.test(e.date) && e.config)
      .sort((a, b) => entryKey(b).localeCompare(entryKey(a)))
      .map((e) => {
        let id = String(e.id || e.date);
        while (used.has(id)) id += '_';
        used.add(id);
        return { ...e, id, time: e.time || '' };
      });
    // いちばん新しい記録が今の地図と同じなら、「最新」にその日付を添えて重複させない
    const top = entries[0] && same(entries[0].config, latest) ? entries.shift() : null;
    this.versions = [
      { key: 'latest', date: '', config: latest, memo: top?.memo || '', since: top ? longDate(top.date, top.time) : '' },
      ...entries.map((e) => ({ key: e.id, date: e.date, time: e.time, config: e.config, memo: e.memo || '', long: longDate(e.date, e.time), short: shortDate(e.date, e.time) })),
    ];
    this.current = this.versions[0];

    // 過去の記録が 1 件もなければ日付ボタンは出さない
    this.chip = null;
    if (this.versions.length > 1) {
      this.chip = document.createElement('button');
      this.chip.type = 'button';
      this.chip.className = 'chip tool hist-chip';
      this.chip.setAttribute('aria-controls', 'histPanel');
      this.chip.setAttribute('aria-expanded', 'false');
      this.chip.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
      this.renderChip();
    }

    $('#histClose').addEventListener('click', () => { this.close(); this.chip?.focus(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen) { this.close(); this.chip?.focus(); } });
    window.addEventListener('popstate', () => {
      const v = this.fromUrl() || this.versions[0];
      if (v !== this.current) this.select(v, { push: false });
    });
  }

  get isOpen() { return !this.panel.hidden; }

  /** ?v=記録のID、または ?date=日付（その日のいちばん新しい記録） */
  fromUrl() {
    const q = new URLSearchParams(location.search);
    const id = q.get('v');
    if (id) return this.versions.find((v) => v.key === id && v.date) || null;
    const d = q.get('date');
    return d ? this.versions.find((v) => v.date === d) || null : null;
  }

  /** 最初に表示する版（URL の ?date= を優先） */
  initial() {
    const v = this.fromUrl();
    if (v) this.current = v;
    this.renderChip();
    return this.current;
  }

  renderChip() {
    if (!this.chip) return;
    const past = !!this.current.date;
    this.chip.classList.toggle('is-past', past);
    this.chip.innerHTML = `${CAL}<span class="name"></span>`;
    $('.name', this.chip).textContent = past ? this.current.short : '最新';
    this.chip.setAttribute('aria-label', past ? `${this.current.long} の地図を表示中。日付を選ぶ` : '最新の地図を表示中。日付を選ぶ');
  }

  open() {
    this.onOpen?.();
    this.render();
    this.panel.hidden = false;
    this.chip?.setAttribute('aria-expanded', 'true');
    $('.hrow[aria-current="true"]', this.list)?.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.panel.hidden = true;
    this.chip?.setAttribute('aria-expanded', 'false');
  }

  render() {
    this.list.replaceChildren();
    for (const v of this.versions) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hrow';
      if (v === this.current) b.setAttribute('aria-current', 'true');
      const main = document.createElement('span');
      main.className = 'hdate';
      main.textContent = v.date ? v.long : '最新の地図';
      const sub = document.createElement('small');
      sub.className = 'hmemo';
      sub.textContent = v.date ? v.memo : [v.since ? `${v.since}の記録` : '', v.memo].filter(Boolean).join('・');
      const tag = document.createElement('span');
      tag.className = 'htag';
      tag.textContent = v === this.current ? '表示中' : '';
      const text = document.createElement('span');
      text.className = 'htext';
      text.append(main);
      if (sub.textContent) text.append(sub);
      b.append(text, tag);
      b.addEventListener('click', () => { this.close(); if (v !== this.current) this.select(v); });
      li.append(b);
      this.list.append(li);
    }
  }

  select(v, { push = true } = {}) {
    this.current = v;
    this.renderChip();
    if (push) {
      const url = new URL(location.href);
      url.searchParams.delete('date');
      if (v.date) url.searchParams.set('v', v.key); else url.searchParams.delete('v');
      history.pushState(null, '', url);
    }
    this.onSelect(v);
  }
}
