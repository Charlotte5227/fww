// 元に戻す／やり直す
//
// 描いた操作は、書き換えたタイルの「前」と「後」を覚えておく。
// 覚えた画像はすぐに PNG に圧縮して、メモリを節約する。
import { TILE } from './doc.js?v=20261028-6';

const MAX_STEPS = 50;
const MAX_BYTES = 160 * 1024 * 1024;

/** タイルの中身を覚える（空なら null） */
function snap(tile) {
  if (!tile) return { empty: true, bytes: 0 };
  const data = tile.getContext('2d').getImageData(0, 0, TILE, TILE);
  const s = { data, bytes: data.data.length };
  // あとで PNG に圧縮
  queueMicrotask(() => compress(s));
  return s;
}

function compress(s) {
  if (!s.data || s.compressing) return;
  s.compressing = true;
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  c.getContext('2d').putImageData(s.data, 0, 0);
  c.toBlob((b) => {
    if (!b || !s.data) return;
    s.blob = b;
    s.data = null;
    s.bytes = b.size;
  }, 'image/png');
}

async function restore(doc, layer, key, s) {
  if (s.empty) {
    layer.tiles.delete(key);
    return;
  }
  const [tx, ty] = doc.tileXY(key);
  const t = doc.tile(layer, tx, ty, true);
  const ctx = t.getContext('2d');
  if (s.data) {
    ctx.putImageData(s.data, 0, 0);
  } else {
    const bmp = await createImageBitmap(s.blob);
    ctx.clearRect(0, 0, TILE, TILE);
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
  }
}

export class History {
  constructor(doc, { onChange, onRestore } = {}) {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;   // 描いている途中の操作
    this.busy = false;
    this.onChange = onChange;     // 戻せる／やり直せる状態が変わったとき
    this.onRestore = onRestore;   // タイルを戻したとき（再描画・自動保存）
    doc.onTouch = (layer, key) => this.touch(layer, key);
  }

  get canUndo() { return !this.busy && this.undoStack.length > 0; }
  get canRedo() { return !this.busy && this.redoStack.length > 0; }

  /* ---------- 描く操作 ---------- */

  begin(label) {
    if (this.pending) this.commit();
    this.pending = { kind: 'pixels', label, tiles: new Map() };  // "layerId|key" -> { layer, key, before, after }
  }

  touch(layer, key) {
    if (!this.pending) return;  // 元に戻す処理そのものによる書き換え
    const id = `${layer.id}|${key}`;
    if (!this.pending.tiles.has(id)) {
      const [tx, ty] = this.doc.tileXY(key);
      this.pending.tiles.set(id, { layer, key, before: snap(this.doc.tile(layer, tx, ty)) });
    }
  }

  /** 描き終わったら、変わったタイルの「後」を覚えて履歴に積む */
  commit() {
    const op = this.pending;
    this.pending = null;
    if (!op || !op.tiles.size) return;
    for (const t of op.tiles.values()) {
      const [tx, ty] = this.doc.tileXY(t.key);
      t.after = snap(this.doc.tile(t.layer, tx, ty));
    }
    const doc = this.doc;
    this.push({
      label: op.label,
      get bytes() { let b = 0; for (const t of op.tiles.values()) b += (t.before.bytes || 0) + (t.after.bytes || 0); return b; },
      undo: async () => {
        const layers = new Set();
        for (const t of op.tiles.values()) { await restore(doc, t.layer, t.key, t.before); layers.add(t.layer); }
        return { tiles: [...op.tiles.values()].map((t) => [t.layer, t.key]) };
      },
      redo: async () => {
        for (const t of op.tiles.values()) await restore(doc, t.layer, t.key, t.after);
        return { tiles: [...op.tiles.values()].map((t) => [t.layer, t.key]) };
      },
    });
  }

  /** 描いている途中でやめる（2 本指の操作が始まったときなど）。描いた分は消す */
  async abort() {
    const op = this.pending;
    this.pending = null;
    if (!op) return;
    for (const t of op.tiles.values()) await restore(this.doc, t.layer, t.key, t.before);
    this.onRestore?.({ tiles: [...op.tiles.values()].map((t) => [t.layer, t.key]) });
  }

  /* ---------- レイヤーの操作など ---------- */

  /** undo / redo を自分で持つ操作を積む */
  push(op) {
    this.undoStack.push(op);
    this.redoStack.length = 0;
    // 古いものから捨てる
    let total = this.undoStack.reduce((a, o) => a + (o.bytes || 0), 0);
    while (this.undoStack.length > MAX_STEPS || (total > MAX_BYTES && this.undoStack.length > 1)) {
      const o = this.undoStack.shift();
      total -= o.bytes || 0;
    }
    this.onChange?.();
  }

  async undo() {
    if (this.pending) this.commit();
    if (!this.canUndo) return null;
    const op = this.undoStack.pop();
    this.busy = true;
    try {
      const r = await op.undo();
      this.redoStack.push(op);
      this.onRestore?.(r || {});
      return op;
    } finally {
      this.busy = false;
      this.onChange?.();
    }
  }

  async redo() {
    if (!this.canRedo) return null;
    const op = this.redoStack.pop();
    this.busy = true;
    try {
      const r = await op.redo();
      this.undoStack.push(op);
      this.onRestore?.(r || {});
      return op;
    } finally {
      this.busy = false;
      this.onChange?.();
    }
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pending = null;
    this.onChange?.();
  }
}
