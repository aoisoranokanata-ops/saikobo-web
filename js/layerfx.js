'use strict';
/* 合成（グループ・通過・クリッピング・調整レイヤー・マスク・レイヤースタイル）とテキストの描画。
   exe 版 core/blend.py・core/styles.py と同じ順序・同じ意味。
   作業用 canvas はすべて「合成する範囲 rect の大きさ」で、(0,0) が rect の左上（文書全体の大きさにしない＝iPad のメモリ対策）。 */

// ---- 作業用 canvas（役割ごとに使い回す） --------------------------------------------
const _pool = new Map();
function poolCanvas(key, w, h) {
  let c = _pool.get(key);
  if (!c) { c = newCanvas(w, h); _pool.set(key, c); }
  else if (c.width < w || c.height < h) { c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
  const g = ctx2d(c);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.shadowColor = 'rgba(0,0,0,0)'; g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
  g.clearRect(0, 0, c.width, c.height);
  return c;
}
/** 大きくなった作業用 canvas を手放す（作品を閉じた時など） */
function releasePool() { _pool.clear(); }

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
function rgbaStr(hex, a) { const [r, g, b] = Color.hexToRgb(hex) || [0, 0, 0]; return `rgba(${r},${g},${b},${clamp(a, 0, 1)})`; }

function styledSource(ctx, layer, pix, mask, depth) {
  const { doc, r } = ctx;
  const E = Rect.clampTo(r, doc.width, doc.height, styleMargin(layer.styles));
  const cont = poolCanvas('sc' + depth, E.w, E.h), gc = ctx2d(cont);
  gc.drawImage(pix, E.x, E.y, E.w, E.h, 0, 0, E.w, E.h);
  if (mask) { gc.globalCompositeOperation = 'destination-in'; gc.drawImage(mask, E.x, E.y, E.w, E.h, 0, 0, E.w, E.h); }
  const out = poolCanvas('so' + depth, E.w, E.h);
  drawStyles(out, cont, E.w, E.h, layer.styles, depth);
  return { canvas: out, ox: r.x - E.x, oy: r.y - E.y };
}

/** 影の描き方: 画像本体は画面の外に描いて、影だけを (dx, dy) の位置に落とす */
function drawShadowOnly(g, src, w, h, color, blur, dx, dy) {
  const OFF = w + 64 + Math.ceil(blur * 3);
  g.save();
  g.shadowColor = color;
  g.shadowBlur = Math.max(0, blur);
  g.shadowOffsetX = dx + OFF;
  g.shadowOffsetY = dy;
  g.drawImage(src, 0, 0, w, h, -OFF, 0, w, h);
  g.restore();
}
/** アルファ（0..1）を canvas に（色は黒） */
function alphaCanvas(key, A, w, h) {
  const c = poolCanvas(key, w, h), g = ctx2d(c);
  const img = g.createImageData(w, h);
  for (let i = 0; i < A.length; i++) img.data[i * 4 + 3] = A[i] * 255;
  g.putImageData(img, 0, 0);
  return c;
}
function readAlpha(c, w, h) {
  const d = ctx2d(c).getImageData(0, 0, w, h).data;
  const A = new Float32Array(w * h);
  for (let i = 0; i < A.length; i++) A[i] = d[i * 4 + 3] / 255;
  return A;
}
/** 太らせる・細らせる（距離変換。輪郭は 1px でなめらかに） */
function dilateA(A, w, h, r) {
  if (r < 0.5) return A;
  const bin = new Uint8Array(A.length);
  for (let i = 0; i < A.length; i++) bin[i] = A[i] >= 0.5 ? 1 : 0;
  const d = distanceTransform(bin, w, h, 1);
  const o = new Float32Array(A.length);
  for (let i = 0; i < A.length; i++) o[i] = Math.max(A[i], clamp(r + 0.5 - Math.sqrt(d[i]), 0, 1));
  return o;
}
function erodeA(A, w, h, r) {
  if (r < 0.5) return A;
  const bin = new Uint8Array(A.length);
  for (let i = 0; i < A.length; i++) bin[i] = A[i] >= 0.5 ? 1 : 0;
  const d = distanceTransform(bin, w, h, 0);
  const o = new Float32Array(A.length);
  for (let i = 0; i < A.length; i++) o[i] = Math.min(A[i], clamp(Math.sqrt(d[i]) - r, 0, 1));
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
  if ((s = styleOn(styles, 'drop_shadow'))) {
    const [dx, dy] = offset(s);
    const spread = s.size * s.spread / 100;
    const src = spread >= 0.5 ? alphaCanvas('st_sp' + depth, dilateA(alpha(), w, h, spread), w, h) : cont;
    drawShadowOnly(g, src, w, h, rgbaStr(s.color, s.opacity / 100), s.size * (1 - s.spread / 100), dx, dy);
  }
  if ((s = styleOn(styles, 'outer_glow'))) {
    const spread = s.size * s.spread / 100;
    const src = spread >= 0.5 ? alphaCanvas('st_sp' + depth, dilateA(alpha(), w, h, spread), w, h) : cont;
    const blur = s.size * (1 - s.spread / 100) * 1.5;
    drawShadowOnly(g, src, w, h, rgbaStr(s.color, s.opacity / 100), blur, 0, 0);
    drawShadowOnly(g, src, w, h, rgbaStr(s.color, s.opacity / 200), blur, 0, 0);       // exe の 1.5 倍の強さに近づける
  }
  const stroke = styleOn(styles, 'stroke');
  if (stroke && stroke.position === 'outside') {
    const a = alpha(), dil = dilateA(a, w, h, stroke.size);
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
    const inv = poolCanvas('st_inv' + depth, w, h), ig = ctx2d(inv);
    ig.fillStyle = s.color; ig.fillRect(0, 0, w, h);
    ig.globalCompositeOperation = 'destination-out';
    ig.drawImage(cont, 0, 0, w, h, dx, dy, w, h);
    const bl = poolCanvas('st_bl' + depth, w, h), bg = ctx2d(bl);
    if (s.size > 0) drawShadowOnly(bg, inv, w, h, s.color, s.size, 0, 0); else bg.drawImage(inv, 0, 0, w, h, 0, 0, w, h);
    bg.globalCompositeOperation = 'destination-in';
    bg.drawImage(cont, 0, 0, w, h, 0, 0, w, h);
    g.save(); g.globalAlpha = s.opacity / 100; g.drawImage(bl, 0, 0, w, h, 0, 0, w, h); g.restore();
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
