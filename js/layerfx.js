'use strict';
/* 合成（グループ・通過・クリッピング・調整レイヤー・マスク・レイヤースタイル）とテキストの描画。
   exe 版 core/blend.py・core/styles.py と同じ順序・同じ意味。
   作業用 canvas はすべて「合成する範囲 rect の大きさ」で、(0,0) が rect の左上（文書全体の大きさにしない＝iPad のメモリ対策）。 */

// ---- 作業用 canvas（役割ごとに使い回す） --------------------------------------------
const _pool = new Map();
function poolCanvas(key, w, h) {
  let c = _pool.get(key);
  // 大きさは毎回ちょうどに（大きいまま使い回すと、画素の読み出しのたびに全体が読まれて遅くなる）
  if (!c) { c = newCanvas(w, h); _pool.set(key, c); }
  else if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = ctx2d(c);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);          // 使うのは左上の w×h だけ（大きな canvas 全体を毎回消さない）
  return c;
}
/** 作業用 canvas を手放す（作品を閉じた時など）。iOS は大きさを 0 にするとすぐメモリが返る */
function releasePool() {
  for (const c of _pool.values()) { c.width = 0; c.height = 0; }
  _pool.clear();
}

function gcoFor(blend) { return (BLEND[blend] || BLEND.normal).gco; }

/** 一列のレイヤーを [[layer, 子], ...]（下 → 上）の木に（親が一覧に無ければ最上位扱い） */
function buildTree(layers) {
  const ids = new Set(layers.map((l) => l.id));
  const nodes = new Map(layers.map((l) => [l.id, [l, []]]));
  const root = [];
  for (const l of layers) {
    if (l.parent != null && ids.has(l.parent)) nodes.get(l.parent)[1].push(nodes.get(l.id));
    else root.push(nodes.get(l.id));
  }
  return root;
}

// ---- 合成 ------------------------------------------------------------------------
function compositeInto(doc, target, rect, { skipLive = false, layers = null } = {}) {
  const r = Rect.clampTo(rect, doc.width, doc.height);
  if (!r) return;
  const ctx = { doc, r, w: r.w, h: r.h, skipLive };
  const acc = poolCanvas('acc', r.w, r.h);
  compositeNodes(ctx, buildTree(layers || doc.layers), acc, 0);
  const g = ctx2d(target);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(r.x, r.y, r.w, r.h);
  g.drawImage(acc, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
  g.restore();
}

/** 描きかけ（doc.live）を考えた画素とマスク */
function liveOf(ctx, layer) {
  const L = ctx.doc.live;
  if (ctx.skipLive || !L || L.layer !== layer) return null;
  if (L._updatedFor !== ctx.r) { L.update(ctx.r); L._updatedFor = ctx.r; }
  return L;
}
function pixelsOf(ctx, layer) { const L = liveOf(ctx, layer); return (L && L.canvas) || layer.canvas; }
function maskOf(ctx, layer) {
  if (layer.mask_enabled === false) return null;
  const L = liveOf(ctx, layer);
  return (L && L.mask) || layer.mask;
}

function compositeNodes(ctx, nodes, acc, depth) {
  const { w, h } = ctx;
  const ga = ctx2d(acc);
  let base = null, baseAlpha = null, first = true;
  for (const node of nodes) {
    const [layer, kids] = node;
    const clipped = layer.clip && !first;
    first = false;
    if (clipped && !base) continue;                         // 土台が無い・非表示
    if (!layer.visible || layer.opacity <= 0) { if (!clipped) base = null; continue; }
    let clip = null;
    if (!clipped) { base = node; baseAlpha = null; }
    else { if (!baseAlpha) baseAlpha = baseAlphaOf(ctx, base, depth); clip = baseAlpha; }
    if (layer.isGroup) { compositeGroup(ctx, layer, kids, acc, clip, depth); continue; }
    if (layer.isAdjustment) { applyAdjustmentLayer(ctx, layer, acc, clip, depth); continue; }
    let src = layerSource(ctx, layer, depth);
    if (!src) continue;
    if (clip) {
      const t = poolCanvas('clipsrc' + depth, w, h), tg = ctx2d(t);
      tg.drawImage(src.canvas, src.ox, src.oy, w, h, 0, 0, w, h);
      tg.globalCompositeOperation = 'destination-in';
      tg.drawImage(clip, 0, 0, w, h, 0, 0, w, h);
      src = { canvas: t, ox: 0, oy: 0 };
    }
    ga.save();
    ga.globalAlpha = layer.opacity;
    ga.globalCompositeOperation = gcoFor(layer.blend);
    ga.drawImage(src.canvas, src.ox, src.oy, w, h, 0, 0, w, h);
    ga.restore();
  }
}

/** レイヤーの内容（マスク・スタイル込み）。戻り値 {canvas, ox, oy}: rect の (0,0) は canvas の (ox, oy) */
function layerSource(ctx, layer, depth) {
  const { r, w, h } = ctx;
  const pix = pixelsOf(ctx, layer);
  if (!pix) return null;
  const mask = maskOf(ctx, layer);
  if (layer.hasStyles()) return styledSource(ctx, layer, pix, mask, depth);
  if (!mask) return { canvas: pix, ox: r.x, oy: r.y };
  const t = poolCanvas('src' + depth, w, h), g = ctx2d(t);
  g.drawImage(pix, r.x, r.y, w, h, 0, 0, w, h);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(mask, r.x, r.y, w, h, 0, 0, w, h);
  return { canvas: t, ox: 0, oy: 0 };
}

/** クリッピングの土台の形（アルファ）。グループが土台なら中身を合成した形 */
function baseAlphaOf(ctx, node, depth) {
  const { r, w, h } = ctx;
  const [layer, kids] = node;
  const t = poolCanvas('base' + depth, w, h), g = ctx2d(t);
  if (layer.isGroup) {
    const sub = poolCanvas('bacc' + depth, w, h);
    compositeNodes(ctx, kids, sub, depth + 1);
    g.drawImage(sub, 0, 0, w, h, 0, 0, w, h);
  } else if (layer.canvas) {
    g.drawImage(pixelsOf(ctx, layer), r.x, r.y, w, h, 0, 0, w, h);
  }
  const mask = maskOf(ctx, layer);
  if (mask) { g.globalCompositeOperation = 'destination-in'; g.drawImage(mask, r.x, r.y, w, h, 0, 0, w, h); }
  return t;
}

/** マスク×クリッピングの範囲（無ければ null） */
function coverageOf(ctx, layer, clip, depth) {
  const { r, w, h } = ctx;
  const mask = maskOf(ctx, layer);
  if (!mask && !clip) return null;
  const t = poolCanvas('cov' + depth, w, h), g = ctx2d(t);
  if (mask) g.drawImage(mask, r.x, r.y, w, h, 0, 0, w, h);
  else { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
  if (clip) { g.globalCompositeOperation = 'destination-in'; g.drawImage(clip, 0, 0, w, h, 0, 0, w, h); }
  return t;
}

function compositeGroup(ctx, group, kids, acc, clip, depth) {
  const { w, h } = ctx;
  const ga = ctx2d(acc);
  const cov = coverageOf(ctx, group, clip, depth);
  if (group.blend === 'pass_through') {
    if (!cov && group.opacity >= 1) { compositeNodes(ctx, kids, acc, depth + 1); return; }
    // 中身を外と直接合成した結果 inner と、元の acc を cov×不透明度 で混ぜる（乗算済みのまま線形に）
    const inner = poolCanvas('inner' + depth, w, h), gi = ctx2d(inner);
    gi.drawImage(acc, 0, 0, w, h, 0, 0, w, h);
    compositeNodes(ctx, kids, inner, depth + 1);
    gi.globalCompositeOperation = 'destination-in';
    gi.globalAlpha = group.opacity;
    if (cov) gi.drawImage(cov, 0, 0, w, h, 0, 0, w, h); else { gi.fillStyle = '#fff'; gi.fillRect(0, 0, w, h); }
    ga.save();
    ga.globalCompositeOperation = 'destination-out';
    ga.globalAlpha = group.opacity;
    if (cov) ga.drawImage(cov, 0, 0, w, h, 0, 0, w, h); else { ga.fillStyle = '#fff'; ga.fillRect(0, 0, w, h); }
    ga.globalCompositeOperation = 'lighter';
    ga.globalAlpha = 1;
    ga.drawImage(inner, 0, 0, w, h, 0, 0, w, h);
    ga.restore();
    return;
  }
  const sub = poolCanvas('grp' + depth, w, h), gs = ctx2d(sub);
  compositeNodes(ctx, kids, sub, depth + 1);
  if (cov) { gs.globalCompositeOperation = 'destination-in'; gs.drawImage(cov, 0, 0, w, h, 0, 0, w, h); }
  ga.save();
  ga.globalAlpha = group.opacity;
  ga.globalCompositeOperation = gcoFor(group.blend);
  ga.drawImage(sub, 0, 0, w, h, 0, 0, w, h);
  ga.restore();
}

// 調整レイヤーの描画モード（色ごとの式。非分離のモードは通常扱い）
const BLEND_FN = {
  multiply: (b, s) => b * s, screen: (b, s) => b + s - b * s,
  overlay: (b, s) => (b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  hard_light: (b, s) => (s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s)),
  soft_light: (b, s) => (s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b)),
  darken: Math.min, lighten: Math.max, difference: (b, s) => Math.abs(b - s), exclusion: (b, s) => b + s - 2 * b * s,
  color_burn: (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  color_dodge: (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  linear_burn: (b, s) => Math.max(0, b + s - 1), linear_dodge: (b, s) => Math.min(1, b + s),
  subtract: (b, s) => Math.max(0, b - s), divide: (b, s) => (s <= 0 ? 1 : Math.min(1, b / s)),
};

function applyAdjustmentLayer(ctx, layer, acc, clip, depth) {
  const { w, h } = ctx;
  const spec = ADJUSTMENTS[layer.adjustment.key];
  if (!spec || !spec.fn) return;
  const ga = ctx2d(acc);
  const img = ga.getImageData(0, 0, w, h);
  const d = img.data;
  const out = spec.fn(d, w, h, { ...defaultParams(spec), ...(layer.adjustment.params || {}) });
  const cov = coverageOf(ctx, layer, clip, depth);
  const cd = cov ? ctx2d(cov).getImageData(0, 0, w, h).data : null;
  const op = layer.opacity;
  const bf = BLEND_FN[layer.blend] || null;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const m = op * (cd ? cd[i + 3] / 255 : 1);
    if (m <= 0) continue;
    for (let c = 0; c < 3; c++) {
      const cb = d[i + c] / 255, cs = out[i + c] / 255;
      const mix = bf ? bf(cb, cs) : cs;
      d[i + c] = (cb + (mix - cb) * m) * 255;
    }
  }
  ga.putImageData(img, 0, 0);
}

// ---- レイヤースタイル（exe core/styles.py と同じ効果・同じ重ね順） ----------------------
const STYLE_SPECS = {
  drop_shadow: { label: 'ドロップシャドウ', params: [P('color', 'カラー', 'color', 0, 0, '#000000'), P('opacity', '不透明度', 'int', 0, 100, 75, { suffix: '%' }),
    P('angle', '角度（光の向き）', 'int', -180, 180, 120, { suffix: '°' }), P('distance', '距離', 'int', 0, 1000, 10, { suffix: 'px', curve: 2 }),
    P('spread', 'スプレッド', 'int', 0, 100, 0, { suffix: '%' }), P('size', 'サイズ（ぼかし）', 'int', 0, 250, 10, { suffix: 'px', curve: 2 })] },
  outer_glow: { label: '光彩（外側）', params: [P('color', 'カラー', 'color', 0, 0, '#ffffbe'), P('opacity', '不透明度', 'int', 0, 100, 75, { suffix: '%' }),
    P('spread', 'スプレッド', 'int', 0, 100, 0, { suffix: '%' }), P('size', 'サイズ', 'int', 0, 250, 10, { suffix: 'px', curve: 2 })] },
  stroke: { label: '境界線', params: [P('color', 'カラー', 'color', 0, 0, '#000000'), P('size', 'サイズ', 'int', 1, 250, 3, { suffix: 'px', curve: 2 }),
    P('position', '位置', 'choice', 0, 0, 'outside', { choices: [['outside', '外側'], ['center', '中央'], ['inside', '内側']] }),
    P('opacity', '不透明度', 'int', 0, 100, 100, { suffix: '%' })] },
  color_overlay: { label: 'カラーオーバーレイ', params: [P('color', 'カラー', 'color', 0, 0, '#ff0000'), P('opacity', '不透明度', 'int', 0, 100, 100, { suffix: '%' })] },
  inner_shadow: { label: 'シャドウ（内側）', params: [P('color', 'カラー', 'color', 0, 0, '#000000'), P('opacity', '不透明度', 'int', 0, 100, 75, { suffix: '%' }),
    P('angle', '角度（光の向き）', 'int', -180, 180, 120, { suffix: '°' }), P('distance', '距離', 'int', 0, 1000, 5, { suffix: 'px', curve: 2 }),
    P('size', 'サイズ（ぼかし）', 'int', 0, 250, 5, { suffix: 'px', curve: 2 })] },
};
const STYLE_ORDER = ['drop_shadow', 'outer_glow', 'stroke', 'color_overlay', 'inner_shadow'];
function styleDefaults(key) { const o = { enabled: true }; for (const q of STYLE_SPECS[key].params) o[q.key] = q.def; return o; }
function styleOn(styles, key) { const s = styles && styles[key]; return s && s.enabled !== false ? { ...styleDefaults(key), ...s } : null; }
function styleMargin(styles) {
  let m = 0, s;
  if ((s = styleOn(styles, 'drop_shadow'))) m = Math.max(m, s.distance + s.size * 2 + 2);
  if ((s = styleOn(styles, 'outer_glow'))) m = Math.max(m, s.size * 2 + 2);
  if ((s = styleOn(styles, 'stroke'))) m = Math.max(m, s.size + 2);
  return Math.ceil(m);
}

function styledSource(ctx, layer, pix, mask, depth) {
  const { doc, r, w, h } = ctx;
  if (!liveOf(ctx, layer)) {
    // 描いていないレイヤーは「中身＋効果」を覚えておいて使い回す（毎コマ計算し直さない）
    const fx = styleCache(doc, layer, pix, mask);
    const t = poolCanvas('src' + depth, w, h);
    if (fx.canvas) {
      const I = Rect.intersect(r, { x: fx.x, y: fx.y, w: fx.canvas.width, h: fx.canvas.height });
      if (I) ctx2d(t).drawImage(fx.canvas, I.x - fx.x, I.y - fx.y, I.w, I.h, I.x - r.x, I.y - r.y, I.w, I.h);
    }
    return { canvas: t, ox: 0, oy: 0 };
  }
  const E = Rect.clampTo(r, doc.width, doc.height, styleMargin(layer.styles));
  const cont = poolCanvas('sc' + depth, E.w, E.h), gc = ctx2d(cont);
  gc.drawImage(pix, E.x, E.y, E.w, E.h, 0, 0, E.w, E.h);
  if (mask) { gc.globalCompositeOperation = 'destination-in'; gc.drawImage(mask, E.x, E.y, E.w, E.h, 0, 0, E.w, E.h); }
  const out = poolCanvas('so' + depth, E.w, E.h);
  drawStyles(out, cont, E.w, E.h, layer.styles, depth);
  return { canvas: out, ox: r.x - E.x, oy: r.y - E.y };
}

/** スタイル付きレイヤーの「中身＋効果」（中身のある範囲＋余白だけ）。画素・マスク・スタイルが変わったら作り直す */
function styleCache(doc, layer, pix, mask) {
  const f = layer._fx;
  if (f && f.pix === pix && f.ver === layer.ver && f.styles === layer.styles && f.mask === mask && f.W === doc.width && f.H === doc.height) return f;
  const W = doc.width, H = doc.height;
  let src = pix;
  if (mask) {
    src = newCanvas(W, H);
    const g = ctx2d(src);
    g.drawImage(pix, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(mask, 0, 0);
  }
  const b = alphaBounds(src);
  const out = { pix, ver: layer.ver, styles: layer.styles, mask, W, H, canvas: null, x: 0, y: 0 };
  if (b) {
    const E = Rect.clampTo(b, W, H, styleMargin(layer.styles) + 2);
    const cont = newCanvas(E.w, E.h);
    ctx2d(cont).drawImage(src, -E.x, -E.y);
    const res = newCanvas(E.w, E.h);
    drawStyles(res, cont, E.w, E.h, layer.styles, 'fx');
    Object.assign(out, { canvas: res, x: E.x, y: E.y });
  }
  layer._fx = out;
  return out;
}

function readAlpha(c, w, h) {
  const d = ctx2d(c).getImageData(0, 0, w, h).data;
  const A = new Float32Array(w * h);
  for (let i = 0; i < A.length; i++) A[i] = d[i * 4 + 3] / 255;
  return A;
}
/** OpenCV の MORPH_ELLIPSE（2k+1 角）と同じ形の窓で、明るさの最大（太らせる）・最小（細らせる）。
   exe の styles._dilate / _erode と同じ結果になる（半透明の輪郭もそのまま広がる）。外側は 0 とみなす */
function ellipseMorph(A, w, h, r, isMax) {
  const k = Math.ceil(r);
  const halfw = [];                               // 行のずれ dy ごとの横の半幅（OpenCV と同じ丸め）
  for (let dy = -k; dy <= k; dy++) halfw.push(Math.round(Math.sqrt(Math.max(0, k * k - dy * dy))));
  const widths = [...new Set(halfw)];
  const rows = new Map();                         // 半幅 → 横方向に最大・最小をとった画像
  const op = isMax ? Math.max : Math.min;
  for (const hw of widths) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let v = isMax ? 0 : 1;
        const x0 = x - hw, x1 = x + hw;
        if (!isMax && (x0 < 0 || x1 >= w)) v = 0;              // 外側は 0（細らせると端から削れる）
        for (let xx = Math.max(0, x0); xx <= Math.min(w - 1, x1); xx++) v = op(v, A[o + xx]);
        out[o + x] = v;
      }
    }
    rows.set(hw, out);
  }
  const res = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = isMax ? 0 : 1;
      for (let j = 0; j < halfw.length; j++) {
        const yy = y + j - k;
        if (yy < 0 || yy >= h) { if (!isMax) v = 0; continue; }
        v = op(v, rows.get(halfw[j])[yy * w + x]);
      }
      res[y * w + x] = v;
    }
  }
  return res;
}
/** σ = 0.5 のガウスぼかし（exe の境界線の _blur(…, 1.0)） */
function blurHalf(A, w, h) {
  const k = [0.1065, 0.787, 0.1065];
  const t = new Float32Array(A.length), o = new Float32Array(A.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    t[i] = A[i] * k[1] + (x > 0 ? A[i - 1] : 0) * k[0] + (x < w - 1 ? A[i + 1] : 0) * k[2];
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    o[i] = t[i] * k[1] + (y > 0 ? t[i - w] : 0) * k[0] + (y < h - 1 ? t[i + w] : 0) * k[2];
  }
  return o;
}
/** 太らせる・細らせる。ふつうの大きさは exe と同じ窓、大きいときは距離変換で（速さのため。輪郭は 1px でなめらかに） */
function dilateA(A, w, h, r) {
  if (r < 0.5) return A;
  if (r <= 24) return ellipseMorph(A, w, h, r, true);
  const bin = new Uint8Array(A.length);
  for (let i = 0; i < A.length; i++) bin[i] = A[i] >= 0.5 ? 1 : 0;
  const d = distanceTransform(bin, w, h, 1);
  const o = new Float32Array(A.length);
  for (let i = 0; i < A.length; i++) o[i] = Math.max(A[i], clamp(r + 0.5 - Math.sqrt(d[i]), 0, 1));
  return o;
}
function erodeA(A, w, h, r) {
  if (r < 0.5) return A;
  if (r <= 24) return ellipseMorph(A, w, h, r, false);
  const bin = new Uint8Array(A.length);
  for (let i = 0; i < A.length; i++) bin[i] = A[i] >= 0.5 ? 1 : 0;
  const d = distanceTransform(bin, w, h, 0);
  const o = new Float32Array(A.length);
  for (let i = 0; i < A.length; i++) o[i] = Math.min(A[i], clamp(Math.sqrt(d[i]) - r, 0, 1));
  return o;
}
/** (dx, dy) ずらす（小数は双線形。はみ出た所は fill）= exe の _shift（cv2.warpAffine） */
function shiftA(A, w, h, dx, dy, fill = 0) {
  const o = new Float32Array(A.length);
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? fill : A[y * w + x]);
  for (let y = 0; y < h; y++) {
    const sy = y - dy, y0 = Math.floor(sy), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = x - dx, x0 = Math.floor(sx), fx = sx - x0;
      o[y * w + x] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    }
  }
  return o;
}
/** ガウスぼかし（σ）。exe の _blur(a, size) は σ = size/2 */
function blurA(A, w, h, sigma) {
  if (sigma <= 0) return A;
  // 外側は 0（exe の BORDER_CONSTANT）。余白を付けてからぼかして切り出す
  const p = Math.ceil(sigma * 3) + 2, pw = w + p * 2, ph = h + p * 2;
  const big = new Float32Array(pw * ph);
  for (let y = 0; y < h; y++) big.set(A.subarray(y * w, y * w + w), (y + p) * pw + p);
  gaussBlurF(big, pw, ph, 1, sigma);
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) o.set(big.subarray((y + p) * pw + p, (y + p) * pw + p + w), y * w);
  return o;
}
function ringCanvas(key, ring, w, h, color, opacity) {
  const c = poolCanvas(key, w, h), g = ctx2d(c);
  const img = g.createImageData(w, h);
  const [R, G, B] = Color.hexToRgb(color) || [0, 0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] * opacity;
    if (a <= 0) continue;
    const j = i * 4;
    img.data[j] = R; img.data[j + 1] = G; img.data[j + 2] = B; img.data[j + 3] = a * 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function drawStyles(out, cont, w, h, styles, depth) {
  const g = ctx2d(out);
  let A = null;
  const alpha = () => (A ||= readAlpha(cont, w, h));
  const offset = (s) => { const a = (s.angle * Math.PI) / 180; return [-Math.cos(a) * s.distance, Math.sin(a) * s.distance]; };
  let s;
  // 影・光彩は exe の core/styles.py と同じ式で計算する（ずらす → 太らせる → ガウスぼかし）
  if ((s = styleOn(styles, 'drop_shadow'))) {
    const [dx, dy] = offset(s);
    const spread = s.size * s.spread / 100;
    const sh = blurA(dilateA(shiftA(alpha(), w, h, dx, dy), w, h, spread), w, h, s.size * (1 - s.spread / 100) / 2);
    g.drawImage(ringCanvas('st_ds' + depth, sh, w, h, s.color, s.opacity / 100), 0, 0, w, h, 0, 0, w, h);
  }
  if ((s = styleOn(styles, 'outer_glow'))) {
    const spread = s.size * s.spread / 100;
    const gl = blurA(dilateA(alpha(), w, h, spread), w, h, s.size * (1 - s.spread / 100) * 1.5 / 2);
    for (let i = 0; i < gl.length; i++) gl[i] = Math.min(1, gl[i] * 1.5);
    g.drawImage(ringCanvas('st_gl' + depth, gl, w, h, s.color, s.opacity / 100), 0, 0, w, h, 0, 0, w, h);
  }
  const stroke = styleOn(styles, 'stroke');
  if (stroke && stroke.position === 'outside') {
    const a = alpha(), dil = blurHalf(dilateA(a, w, h, stroke.size), w, h);
    const ring = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) ring[i] = Math.max(0, dil[i] - a[i]);
    g.drawImage(ringCanvas('st_ring' + depth, ring, w, h, stroke.color, stroke.opacity / 100), 0, 0, w, h, 0, 0, w, h);
  }
  if ((s = styleOn(styles, 'color_overlay'))) {
    const t = poolCanvas('st_ov' + depth, w, h), tg = ctx2d(t);
    tg.drawImage(cont, 0, 0, w, h, 0, 0, w, h);
    tg.globalCompositeOperation = 'source-atop';
    tg.globalAlpha = s.opacity / 100;
    tg.fillStyle = s.color;
    tg.fillRect(0, 0, w, h);
    g.drawImage(t, 0, 0, w, h, 0, 0, w, h);
  } else g.drawImage(cont, 0, 0, w, h, 0, 0, w, h);
  if ((s = styleOn(styles, 'inner_shadow'))) {
    const [dx, dy] = offset(s);
    const a = alpha();
    const inv = a.map((v) => 1 - v);
    const bl = blurA(shiftA(inv, w, h, dx, dy, 1), w, h, s.size / 2);
    for (let i = 0; i < bl.length; i++) bl[i] *= a[i];
    g.drawImage(ringCanvas('st_is' + depth, bl, w, h, s.color, s.opacity / 100), 0, 0, w, h, 0, 0, w, h);
  }
  if (stroke && stroke.position !== 'outside') {
    const a = alpha();
    let ring;
    if (stroke.position === 'inside') {
      const ero = erodeA(a, w, h, stroke.size);
      ring = a.map((v, i) => Math.max(0, v - ero[i]));
    } else {
      const dil = dilateA(a, w, h, stroke.size / 2), ero = erodeA(a, w, h, stroke.size / 2);
      ring = dil.map((v, i) => Math.max(0, v - ero[i]));
    }
    g.drawImage(ringCanvas('st_ring' + depth, ring, w, h, stroke.color, stroke.opacity / 100), 0, 0, w, h, 0, 0, w, h);
  }
}

// ---- テキスト（exe core/text.py の spec と同じ形） -----------------------------------
const TEXT_DEFAULTS = { text: '', font: '', size: 48, color: '#000000', bold: false, italic: false, align: 'left', line_spacing: 1.2, matrix: [1, 0, 0, 1, 0, 0] };
const FONT_CHOICES = [['', '標準（ゴシック）'], ['Hiragino Sans', 'ヒラギノ角ゴシック'], ['Hiragino Mincho ProN', 'ヒラギノ明朝'],
  ['Hiragino Maru Gothic ProN', 'ヒラギノ丸ゴ'], ['Yu Gothic', '游ゴシック'], ['Yu Mincho', '游明朝'], ['Meiryo', 'メイリオ'],
  ['serif', '明朝体（端末の標準）'], ['sans-serif', 'ゴシック体（端末の標準）'], ['Georgia', 'Georgia'], ['Helvetica Neue', 'Helvetica Neue'], ['Courier New', 'Courier New']];
function makeTextSpec(text, x, y, opts = {}) {
  const s = { ...TEXT_DEFAULTS, ...opts, text: String(text) };
  s.size = Number(s.size); s.line_spacing = Number(s.line_spacing);
  s.matrix = [1, 0, 0, 1, x, y];
  return s;
}
function fontString(spec) {
  const fam = spec.font && !/^(serif|sans-serif|monospace)$/.test(spec.font) ? `"${spec.font}", ` : spec.font ? spec.font + ', ' : '';
  return `${spec.italic ? 'italic ' : ''}${spec.bold ? 'bold ' : ''}${Math.max(1, Math.round(spec.size))}px ${fam}"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif`;
}
let _measure = null;
/** 行・各行の幅・全体の幅・ascent・行送り（exe の Qt と同じ考え方: 行送り = (ascent + descent)·line_spacing） */
function textLayout(spec) {
  _measure ||= ctx2d(newCanvas(4, 4));
  const g = _measure;
  g.font = fontString(spec);
  const lines = String(spec.text).split('\n');
  const widths = lines.map((l) => g.measureText(l).width);
  const m = g.measureText('Mgあ');
  const ascent = m.fontBoundingBoxAscent ?? spec.size * 0.88;
  const descent = m.fontBoundingBoxDescent ?? spec.size * 0.24;
  const step = (ascent + descent) * (spec.line_spacing || 1.2);
  return { lines, widths, block: Math.max(0, ...widths), ascent, descent, step, height: ascent + descent + step * (lines.length - 1) };
}
function renderTextSpec(spec, W, H) {
  const c = newCanvas(W, H), g = ctx2d(c);
  const L = textLayout(spec);
  g.setTransform(...(spec.matrix || [1, 0, 0, 1, 0, 0]));
  g.font = fontString(spec);
  g.fillStyle = spec.color || '#000000';
  g.textBaseline = 'alphabetic';
  L.lines.forEach((line, i) => {
    const lx = spec.align === 'center' ? (L.block - L.widths[i]) / 2 : spec.align === 'right' ? L.block - L.widths[i] : 0;
    g.fillText(line, lx, L.ascent + i * L.step);
  });
  return c;
}
/** テキストの四隅（文書座標。左上・右上・右下・左下） */
function textQuad(spec) {
  const L = textLayout(spec), M = spec.matrix || [1, 0, 0, 1, 0, 0];
  const w = Math.max(L.block, spec.size * 0.5);
  return [matApply(M, 0, 0), matApply(M, w, 0), matApply(M, w, L.height), matApply(M, 0, L.height)];
}

// ---- マスクへの描き込み（マスク = 白・アルファが見える度合い） -------------------------
/** gm（マスクの ctx）の r の範囲に、src（アルファ = 塗る量）の分だけ明るさ gray（0..1）へ寄せる。
   destination-out で減らしてから lighter で白を足す: new = old·(1−a) + gray·a */
function paintMask(gm, src, r, amount, gray, tintKey = 'mtint') {
  const t = poolCanvas(tintKey, r.w, r.h), tg = ctx2d(t);
  tg.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  tg.globalCompositeOperation = 'source-in';
  tg.fillStyle = '#fff';
  tg.fillRect(0, 0, r.w, r.h);
  gm.save();
  gm.globalCompositeOperation = 'destination-out';
  gm.globalAlpha = amount;
  gm.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
  gm.globalCompositeOperation = 'lighter';
  gm.globalAlpha = amount * gray;
  if (gray > 0) gm.drawImage(t, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
  gm.restore();
}
function grayOf(hex) { const [r, g, b] = Color.hexToRgb(hex) || [0, 0, 0]; return (r * 0.299 + g * 0.587 + b * 0.114) / 255; }
