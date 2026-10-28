// ブラウザの中への自動保存（IndexedDB）
//
// 同じ github.io の中のほかのリポジトリと混ざらないよう、ページの場所ごとに分ける。
const DB_NAME = `cylinder-viewer-draw:${location.pathname.replace(/[^/]*$/, '')}`;
const VERSION = 1;

function req(r) {
  return new Promise((ok, ng) => { r.onsuccess = () => ok(r.result); r.onerror = () => ng(r.error); });
}

export class Store {
  async open() {
    if (this.db) return this.db;
    if (!('indexedDB' in window)) throw new Error('このブラウザでは自動保存が使えません');
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
    };
    this.db = await req(r);
    return this.db;
  }

  async tx(stores, mode, fn) {
    const db = await this.open();
    const t = db.transaction(stores, mode);
    const out = fn(t);
    await new Promise((ok, ng) => { t.oncomplete = ok; t.onerror = () => ng(t.error); t.onabort = () => ng(t.error || new Error('保存が中断されました')); });
    return out;
  }

  /** 保存してある内容をすべて読む。{ meta, tiles: Map<"layerId|key", Blob> } */
  async load() {
    const db = await this.open();
    const t = db.transaction(['meta', 'tiles'], 'readonly');
    const meta = await req(t.objectStore('meta').get('state'));
    const tiles = new Map();
    await new Promise((ok, ng) => {
      const c = t.objectStore('tiles').openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return ok();
        tiles.set(cur.key, cur.value);
        cur.continue();
      };
      c.onerror = () => ng(c.error);
    });
    return { meta: meta || null, tiles };
  }

  /**
   * 変わった分だけ書き込む。puts: [id, Blob]、dels: id、dropLayers: レイヤー ID（そのタイルを全部消す）
   */
  async save({ meta, puts = [], dels = [], dropLayers = [] }) {
    const drop = new Set(dropLayers);
    let dropKeys = [];
    if (drop.size) {
      const db = await this.open();
      const keys = await req(db.transaction('tiles', 'readonly').objectStore('tiles').getAllKeys());
      dropKeys = keys.filter((k) => drop.has(String(k).split('|')[0]));
    }
    await this.tx(['meta', 'tiles'], 'readwrite', (t) => {
      const ts = t.objectStore('tiles');
      for (const k of dropKeys) ts.delete(k);
      for (const k of dels) ts.delete(k);
      for (const [k, b] of puts) ts.put(b, k);
      if (meta) t.objectStore('meta').put(meta, 'state');
    });
  }

  /** すべて消して書き直す（作業を再開したとき） */
  async replaceAll(meta, puts) {
    await this.tx(['meta', 'tiles'], 'readwrite', (t) => {
      const ts = t.objectStore('tiles');
      ts.clear();
      for (const [k, b] of puts) ts.put(b, k);
      t.objectStore('meta').put(meta, 'state');
    });
  }

  async clear() {
    await this.tx(['meta', 'tiles'], 'readwrite', (t) => {
      t.objectStore('tiles').clear();
      t.objectStore('meta').clear();
    });
  }

  /** ブラウザに「この保存を消さないで」と頼む（対応しているブラウザだけ） */
  static async persist() {
    try {
      if (navigator.storage?.persisted && await navigator.storage.persisted()) return true;
      return (await navigator.storage?.persist?.()) || false;
    } catch { return false; }
  }
}
