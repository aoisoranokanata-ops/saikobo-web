'use strict';
/* 選択範囲: null（全体）か {canvas, bounds}。canvas は文書と同じ大きさで、アルファ = 選択度（色は白）。
   不変として扱う（変えるときは新しい物を作る）。履歴がそのまま参照を持つため。 */

const Sel = {
  /** canvas から作る。何も選ばれていなければ null */
  fromCanvas(c) {
    const b = alphaBounds(c);
    return b ? { canvas: c, bounds: b } : null;
  },
  fromAlpha(alpha, w, h) {
    const c = newCanvas(w, h);
    const g = ctx2d(c);
    const img = g.createImageData(w, h);
    const d = img.data;
    for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
      d[j] = d[j + 1] = d[j + 2] = 255;
      d[j + 3] = alpha[i];
    }
    g.putImageData(img, 0, 0);
    return Sel.fromCanvas(c);
  },
  alphaOf(sel, w, h) {
    const d = ctx2d(sel.canvas).getImageData(0, 0, w, h).data;
    const a = new Uint8Array(w * h);
    for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
    return a;
  },
  /** 形（パス）を塗った canvas を作る */
  shape(w, h, drawPath, { antialias = true } = {}) {
    const c = newCanvas(w, h);
    const g = ctx2d(c);
    g.imageSmoothingEnabled = antialias;
    g.fillStyle = '#fff';
    g.beginPath();
    drawPath(g);
    g.fill('evenodd');
    return c;
  },
  /** 今の選択範囲と組み合わせる。mode: replace / add / subtract / intersect */
  combine(cur, shapeCanvas, mode, w, h) {
    if (mode === 'replace') return Sel.fromCanvas(shapeCanvas);
    if (!cur) return mode === 'add' ? Sel.fromCanvas(shapeCanvas) : null;
    const c = cloneCanvas(cur.canvas);
    const g = ctx2d(c);
    g.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
    g.drawImage(shapeCanvas, 0, 0);
    return Sel.fromCanvas(c);
  },
  all(w, h) {
    const c = newCanvas(w, h);
    const g = ctx2d(c);
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    return { canvas: c, bounds: { x: 0, y: 0, w, h } };
  },
  invert(cur, w, h) {
    if (!cur) return null;
    const c = newCanvas(w, h);
    const g = ctx2d(c);
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(cur.canvas, 0, 0);
    return Sel.fromCanvas(c);
  },
  feather(cur, r, w, h) {
    if (!cur || r <= 0) return cur;
    const a = Sel.alphaOf(cur, w, h);
    boxBlur(a, w, h, Math.max(1, Math.round(r / 1.7)), 3);
    return Sel.fromAlpha(a, w, h);
  },
  /** 拡張（px > 0）・縮小（px < 0）。距離変換で正確に */
  grow(cur, px, w, h) {
    if (!cur || !px) return cur;
    const a = Sel.alphaOf(cur, w, h);
    const inside = new Uint8Array(w * h);
    for (let i = 0; i < a.length; i++) inside[i] = a[i] >= 128 ? 1 : 0;
    const out = new Uint8Array(w * h);
    if (px > 0) {
      const d = distanceTransform(inside, w, h, 1);       // 選択部分からの距離
      const lim = px * px;
      for (let i = 0; i < out.length; i++) out[i] = d[i] <= lim ? 255 : 0;
    } else {
      const d = distanceTransform(inside, w, h, 0);       // 選択外からの距離
      const lim = px * px;
      for (let i = 0; i < out.length; i++) out[i] = d[i] > lim ? 255 : 0;
    }
    return Sel.fromAlpha(out, w, h);
  },
  /** 外周の線（文書座標の Path2D）。点線表示用。0.5 以上を内側とみなす */
  outline(sel, w, h) {
    if (sel._outline) return sel._outline;
    const b = sel.bounds;
    const x0 = Math.max(0, b.x - 1), y0 = Math.max(0, b.y - 1);
    const x1 = Math.min(w, b.x + b.w + 1), y1 = Math.min(h, b.y + b.h + 1);
    const bw = x1 - x0, bh = y1 - y0;
    const d = ctx2d(sel.canvas).getImageData(x0, y0, bw, bh).data;
    const at = (x, y) => (x < 0 || y < 0 || x >= bw || y >= bh) ? 0 : (d[(y * bw + x) * 4 + 3] >= 128 ? 1 : 0);
    const p = new Path2D();
    let n = 0;
    for (let y = 0; y <= bh; y++) {           // 横の辺（y-1 と y の境）
      let start = -1;
      for (let x = 0; x <= bw; x++) {
        const edge = x < bw && at(x, y - 1) !== at(x, y);
        if (edge && start < 0) start = x;
        else if (!edge && start >= 0) { p.moveTo(x0 + start, y0 + y); p.lineTo(x0 + x, y0 + y); start = -1; n++; }
      }
    }
    for (let x = 0; x <= bw; x++) {           // 縦の辺
      let start = -1;
      for (let y = 0; y <= bh; y++) {
        const edge = y < bh && at(x - 1, y) !== at(x, y);
        if (edge && start < 0) start = y;
        else if (!edge && start >= 0) { p.moveTo(x0 + x, y0 + start); p.lineTo(x0 + x, y0 + y); start = -1; n++; }
      }
    }
    sel._outline = p;
    sel._segments = n;
    return p;
  },
};

/** 色が近い範囲（自動選択・塗りつぶし）。戻り値は 0/255 のアルファ配列 */
function regionMask(data, w, h, sx, sy, tolerance, contiguous) {
  sx |= 0; sy |= 0;
  const out = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;
  const i0 = (sy * w + sx) * 4;
  const r0 = data[i0], g0 = data[i0 + 1], b0 = data[i0 + 2], a0 = data[i0 + 3];
  const tol = tolerance;
  const near = (p) => {
    const j = p * 4;
    const a = data[j + 3];
    if (a0 === 0 && a === 0) return true;     // 透明どうし
    return Math.abs(data[j] - r0) <= tol && Math.abs(data[j + 1] - g0) <= tol &&
      Math.abs(data[j + 2] - b0) <= tol && Math.abs(a - a0) <= tol;
  };
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (near(p)) out[p] = 255;
    return out;
  }
  const seen = new Uint8Array(w * h);
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop(), x0 = stack.pop();
    let x = x0;
    let row = y * w;
    if (seen[row + x]) continue;
    while (x > 0 && !seen[row + x - 1] && near(row + x - 1)) x--;
    let upOpen = false, downOpen = false;
    for (; x < w && !seen[row + x] && near(row + x); x++) {
      seen[row + x] = 1;
      out[row + x] = 255;
      if (y > 0) {
        const q = row - w + x;
        const ok = !seen[q] && near(q);
        if (ok && !upOpen) { stack.push(x, y - 1); upOpen = true; } else if (!ok) upOpen = false;
      }
      if (y < h - 1) {
        const q = row + w + x;
        const ok = !seen[q] && near(q);
        if (ok && !downOpen) { stack.push(x, y + 1); downOpen = true; } else if (!ok) downOpen = false;
      }
    }
  }
  return out;
}

function alphaBounds(c) {
  const w = c.width, h = c.height;
  const d = ctx2d(c).getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4 + 3;
    for (let x = 0; x < w; x++, row += 4) {
      if (d[row]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 箱型のぼかしを passes 回（ガウスに近づく）。a は Uint8Array、その場で書き換える */
function boxBlur(a, w, h, r, passes = 3) {
  const tmp = new Float32Array(Math.max(w, h));
  const line = new Float32Array(Math.max(w, h));
  const win = r * 2 + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) line[x] = a[o + x];
      blur1d(line, tmp, w, r, win);
      for (let x = 0; x < w; x++) a[o + x] = tmp[x] + 0.5;
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) line[y] = a[y * w + x];
      blur1d(line, tmp, h, r, win);
      for (let y = 0; y < h; y++) a[y * w + x] = tmp[y] + 0.5;
    }
  }
}
function blur1d(src, dst, n, r, win) {
  let acc = 0;
  for (let i = -r; i <= r; i++) acc += src[clamp(i, 0, n - 1)];
  for (let i = 0; i < n; i++) {
    dst[i] = acc / win;
    acc += src[Math.min(n - 1, i + r + 1)] - src[Math.max(0, i - r)];
  }
}

/** 2値画像の2乗ユークリッド距離（target の画素までの距離）。Felzenszwalb の方法 */
function distanceTransform(bin, w, h, target) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = bin[i] === target ? 0 : INF;
  const pass = (n) => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
  return grid;
}
