// お絵かきページのデータ：地図のレイヤーとお絵かきレイヤー
//
// お絵かきレイヤーは地図と同じ大きさだが、256px 四方の「タイル」に分けて、
// 描いたところのタイルだけを持つ（何も描いていない部分はメモリを使わない）。

export const TILE = 256;
export const MAX_DRAW_LAYERS = 10;

const newCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

let seq = 0;
let revSeq = 0;
/** レイヤーの中身が変わった印（表示の作り置きを作り直すため） */
export const bumpRev = (layer) => { if (layer) layer.rev = ++revSeq; };
export const newId = () => `d${Date.now().toString(36)}${(seq++).toString(36)}`;

export class Doc {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.ntx = Math.ceil(w / TILE);
    this.nty = Math.ceil(h / TILE);
    this.layers = [];      // 下から順
    this.activeId = null;  // 描き込み先のお絵かきレイヤー
    this.onTouch = null;   // タイルを書き換える直前に呼ばれる（元に戻す用）
    this.onChange = null;  // 内容が変わったとき（自動保存・再描画用）
  }

  /* ---------- レイヤー ---------- */

  layer(id) { return this.layers.find((l) => l.id === id) || null; }
  get drawLayers() { return this.layers.filter((l) => l.kind === 'draw'); }
  get active() { const l = this.layer(this.activeId); return l && l.kind === 'draw' ? l : null; }
  indexOf(id) { return this.layers.findIndex((l) => l.id === id); }

  addMapLayer({ id, name, src, img, visible = true, opacity = 1, isBase = false }) {
    const l = { id, kind: 'map', name, src, img, visible, opacity, isBase };
    this.layers.push(l);
    return l;
  }

  /** お絵かきレイヤーを作る（index の位置に入れる。省略時はいちばん上） */
  createDrawLayer({ id = newId(), name, visible = true, opacity = 1, tiles = new Map() } = {}) {
    return { id, kind: 'draw', name, visible, opacity, tiles, rev: ++revSeq };
  }

  insert(layer, index = this.layers.length) {
    this.layers.splice(Math.max(0, Math.min(index, this.layers.length)), 0, layer);
    this.changed({ layers: true });
  }

  remove(id) {
    const i = this.indexOf(id);
    if (i < 0) return null;
    const [l] = this.layers.splice(i, 1);
    if (this.activeId === id) this.activeId = this.drawLayers.at(-1)?.id || null;
    this.changed({ layers: true });
    return { layer: l, index: i };
  }

  move(id, to) {
    const i = this.indexOf(id);
    if (i < 0) return;
    const [l] = this.layers.splice(i, 1);
    this.layers.splice(Math.max(0, Math.min(to, this.layers.length)), 0, l);
    this.changed({ layers: true });
  }

  changed(what) {
    if (what.tiles && what.layer) bumpRev(what.layer);
    this.onChange?.(what);
  }

  /* ---------- タイル ---------- */

  key(tx, ty) { return ty * this.ntx + tx; }
  tileXY(key) { return [key % this.ntx, Math.floor(key / this.ntx)]; }

  tile(layer, tx, ty, create = false) {
    const k = this.key(tx, ty);
    let t = layer.tiles.get(k);
    if (!t && create) {
      t = newCanvas(TILE, TILE);
      layer.tiles.set(k, t);
    }
    return t || null;
  }

  /**
   * お絵かきレイヤーに描く。bbox は地図の座標（左右の端からはみ出してもよい）。
   * draw(ctx) は地図の座標で描く関数。地図は左右がつながっているので、端をまたぐ分は反対側にも描く。
   */
  paint(layer, bbox, draw) {
    const touched = [];
    for (const off of this.wrapOffsets(bbox.x0, bbox.x1)) {
      const x0 = Math.max(0, Math.floor((bbox.x0 + off) / TILE));
      const x1 = Math.min(this.ntx - 1, Math.floor((bbox.x1 + off) / TILE));
      const y0 = Math.max(0, Math.floor(bbox.y0 / TILE));
      const y1 = Math.min(this.nty - 1, Math.floor(bbox.y1 / TILE));
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const k = this.key(tx, ty);
          this.onTouch?.(layer, k);
          const t = this.tile(layer, tx, ty, true);
          const ctx = t.getContext('2d');
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, -tx * TILE + off, -ty * TILE);
          ctx.beginPath();
          ctx.rect(tx * TILE - off, ty * TILE, TILE, TILE);
          ctx.clip();
          draw(ctx);
          ctx.restore();
          touched.push(k);
        }
      }
    }
    this.changed({ tiles: touched, layer });
    return touched;
  }

  /** 左右にはみ出した図形を、反対側にも描くためのずらし量 */
  wrapOffsets(x0, x1) {
    const out = new Set([0]);
    const w = this.w;
    for (let k = Math.floor(x0 / w); k <= Math.floor(x1 / w); k++) out.add(-k * w);
    return [...out];
  }

  /* ---------- 表示・書き出し ---------- */

  /**
   * 地図の範囲 (rx, ry, rw, rh) を ctx に scale 倍で描く。左右は地図がつながっているので繰り返す。
   * layers を渡すとそのレイヤーだけ、opts.hidden で非表示のレイヤーも描く。
   */
  render(ctx, rx, ry, rw, rh, scale, { layers = this.layers, hidden = false, smooth = true, quality = 'high' } = {}) {
    const W = this.w, H = this.h;
    ctx.imageSmoothingEnabled = smooth;
    ctx.imageSmoothingQuality = quality;
    const kx0 = Math.floor(rx / W), kx1 = Math.floor((rx + rw) / W);
    const px = (x) => Math.round((x - rx) * scale);
    const py = (y) => Math.round((y - ry) * scale);
    for (const l of layers) {
      if (!hidden && !l.visible) continue;
      if (l.opacity <= 0) continue;
      ctx.globalAlpha = l.opacity;
      for (let k = kx0; k <= kx1; k++) {
        const ox = k * W;
        if (l.kind === 'map') {
          if (!l.img) continue;
          const x0 = px(ox), x1 = px(ox + W), y0 = py(0), y1 = py(H);
          ctx.drawImage(l.img, x0, y0, x1 - x0, y1 - y0);
        } else {
          const t0 = Math.max(0, Math.floor((rx - ox) / TILE)), t1 = Math.min(this.ntx - 1, Math.floor((rx + rw - ox) / TILE));
          const s0 = Math.max(0, Math.floor(ry / TILE)), s1 = Math.min(this.nty - 1, Math.floor((ry + rh) / TILE));
          for (let ty = s0; ty <= s1; ty++) {
            for (let tx = t0; tx <= t1; tx++) {
              const t = l.tiles.get(this.key(tx, ty));
              if (!t) continue;
              const x0 = px(ox + tx * TILE), x1 = px(ox + (tx + 1) * TILE);
              const y0 = py(ty * TILE), y1 = py((ty + 1) * TILE);
              ctx.drawImage(t, x0, y0, x1 - x0, y1 - y0);
            }
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /** 地図全体を合成したキャンバス（scale 倍） */
  composite(scale = 1, opts = {}) {
    const c = newCanvas(Math.max(1, Math.round(this.w * scale)), Math.max(1, Math.round(this.h * scale)));
    this.render(c.getContext('2d'), 0, 0, this.w, this.h, scale, opts);
    return c;
  }

  /** お絵かきレイヤー 1 枚を、地図と同じ大きさのキャンバスに */
  layerCanvas(layer) {
    const c = newCanvas(this.w, this.h);
    const ctx = c.getContext('2d');
    for (const [k, t] of layer.tiles) {
      const [tx, ty] = this.tileXY(k);
      ctx.drawImage(t, tx * TILE, ty * TILE);
    }
    return c;
  }

  /** 地図と同じ大きさの画像を、タイルに分けて読み込む（何も描かれていないタイルは作らない） */
  tilesFromImage(img) {
    const tiles = new Map();
    const tmp = newCanvas(TILE, TILE);
    const tctx = tmp.getContext('2d', { willReadFrequently: true });
    for (let ty = 0; ty < this.nty; ty++) {
      for (let tx = 0; tx < this.ntx; tx++) {
        tctx.clearRect(0, 0, TILE, TILE);
        tctx.drawImage(img, -tx * TILE, -ty * TILE, this.w, this.h);
        if (isEmpty(tctx)) continue;
        const t = newCanvas(TILE, TILE);
        t.getContext('2d').drawImage(tmp, 0, 0);
        tiles.set(this.key(tx, ty), t);
      }
    }
    return tiles;
  }

  /** ある 1 点の、見えている色（すべての表示中レイヤーを重ねた色） */
  sample(x, y) {
    const W = this.w;
    x = ((Math.floor(x) % W) + W) % W;
    y = Math.floor(y);
    if (y < 0 || y >= this.h) return null;
    const c = sampler();
    let r = 0, g = 0, b = 0, a = 0;
    for (const l of this.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      c.ctx.clearRect(0, 0, 1, 1);
      if (l.kind === 'map') {
        if (!l.img) continue;
        const iw = l.img.naturalWidth || l.img.width, ih = l.img.naturalHeight || l.img.height;
        c.ctx.drawImage(l.img, Math.floor((x * iw) / W), Math.floor((y * ih) / this.h), 1, 1, 0, 0, 1, 1);
      } else {
        const t = l.tiles.get(this.key(Math.floor(x / TILE), Math.floor(y / TILE)));
        if (!t) continue;
        c.ctx.drawImage(t, x % TILE, y % TILE, 1, 1, 0, 0, 1, 1);
      }
      const d = c.ctx.getImageData(0, 0, 1, 1).data;
      const sa = (d[3] / 255) * l.opacity;
      if (sa <= 0) continue;
      // 上に重ねる（ふつうの重ね方）
      const na = sa + a * (1 - sa);
      r = (d[0] * sa + r * a * (1 - sa)) / na;
      g = (d[1] * sa + g * a * (1 - sa)) / na;
      b = (d[2] * sa + b * a * (1 - sa)) / na;
      a = na;
    }
    if (a <= 0) return null;
    return [Math.round(r), Math.round(g), Math.round(b)];
  }

  /** お絵かきレイヤーに何か描かれているか */
  hasDrawing() { return this.drawLayers.some((l) => l.tiles.size > 0); }
}

let _sampler;
function sampler() {
  if (!_sampler) {
    const c = newCanvas(1, 1);
    _sampler = { c, ctx: c.getContext('2d', { willReadFrequently: true }) };
  }
  return _sampler;
}

export function isEmpty(ctx) {
  const d = ctx.getImageData(0, 0, TILE, TILE).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
  return true;
}

export { newCanvas };
