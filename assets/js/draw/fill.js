// 塗りつぶしの範囲を調べる（左右の端はつながっている）

/**
 * data: 地図と同じ大きさの RGBA。(sx, sy) と似た色でつながっている範囲を返す。
 * tol: 0〜255。各色の差がこれ以下なら同じ色とみなす。
 * @returns {{ mask: Uint8Array, x0: number, x1: number, y0: number, y1: number, count: number } | null}
 */
export function floodRegion(data, w, h, sx, sy, tol) {
  sx = ((Math.floor(sx) % w) + w) % w;
  sy = Math.floor(sy);
  if (sy < 0 || sy >= h) return null;
  const i0 = (sy * w + sx) * 4;
  const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
  const mask = new Uint8Array(w * h);
  const match = (p) => {
    if (mask[p]) return false;
    const i = p * 4;
    // 透明どうしは色に関係なく同じとみなす
    if (a0 === 0 && data[i + 3] <= tol) return true;
    return Math.abs(data[i] - r0) <= tol && Math.abs(data[i + 1] - g0) <= tol
      && Math.abs(data[i + 2] - b0) <= tol && Math.abs(data[i + 3] - a0) <= tol;
  };
  let x0 = sx, x1 = sx, y0 = sy, y1 = sy, count = 0;
  let wrapped = false;
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    const row = y * w;
    if (!match(row + x)) continue;
    // 左右に広げる（端で反対側につながる）
    let l = x, r = x, n = 1;
    mask[row + x] = 1;
    while (n < w) {
      const nx = (l - 1 + w) % w;
      if (!match(row + nx)) break;
      mask[row + nx] = 1; l = nx; n++;
    }
    while (n < w) {
      const nx = (r + 1) % w;
      if (!match(row + nx)) break;
      mask[row + nx] = 1; r = nx; n++;
    }
    count += n;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (l > r || n >= w) wrapped = true; else { if (l < x0) x0 = l; if (r > x1) x1 = r; }
    // 上下の行で、まだ塗っていないところを探す
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let k = 0, px = l; k < n; k++, px = (px + 1) % w) {
        const ok = match(nrow + px);
        if (ok && !inRun) { stack.push(px, ny); inRun = true; } else if (!ok) inRun = false;
      }
    }
  }
  if (wrapped) { x0 = 0; x1 = w - 1; }
  return { mask, x0, x1, y0, y1, count };
}
