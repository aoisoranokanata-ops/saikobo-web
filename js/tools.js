'use strict';
/* ツール。view から down / move / up / cancel が呼ばれる（点は文書座標・筆圧つき）。
   options は道具ごとに localStorage に覚える。spec はオプションバーの作り方。 */

class Tool {
  constructor(app, name, label, defaults = {}) {
    this.app = app;
    this.name = name;
    this.label = label;
    this.opts = { ...defaults, ...LS.get('tool.' + name, {}) };
  }
  get doc() { return this.app.doc; }
  get view() { return this.app.view; }
  setOpt(k, v) { this.opts[k] = v; LS.set('tool.' + this.name, this.opts); }
  spec() { return []; }
  /** 要るレイヤー: false / 'paint'（画素かマスクに描く）/ 'pixels'（画素だけ）/ 'move'（画素かテキスト） */
  needsLayer() { return 'paint'; }
  down() {} move() {} up() {}
  cancel() {}
}

/** 選択系の合成モード（Shift = 追加、Alt = 一部削除、両方 = 共通） */
function selMode(tool, p) {
  if (p.shift && p.alt) return 'intersect';
  if (p.shift) return 'add';
  if (p.alt) return 'subtract';
  return tool.opts.mode || 'replace';
}
const SEL_MODE_SEG = { key: 'mode', type: 'seg', items: [['replace', '新規'], ['add', '追加'], ['subtract', '削除'], ['intersect', '共通']] };

// ---- ブラシ・消しゴム ------------------------------------------------------------
/* ペンの種類。min = 筆圧0のときの太さの割合、gamma = 筆圧の効き方（大きいほど入り抜きが細い）、
   spacing = 点の間隔（太さに対する割合）、flow = 1点の濃さ、grain = 紙の質感（0..1）、grainScale = 質感の粗さ */
const BRUSH_PRESETS = {
  round:      { label: '標準ペン',   hardness: 85, min: 0.15, gamma: 1.0, spacing: 0.10, flow: 1.0,  pressureSize: true,  pressureOpacity: false, grain: 0,    grainScale: 1 },
  gpen:       { label: 'Gペン',      hardness: 96, min: 0.03, gamma: 1.5, spacing: 0.06, flow: 1.0,  pressureSize: true,  pressureOpacity: false, grain: 0,    grainScale: 1 },
  mapping:    { label: '丸ペン',      hardness: 92, min: 0.35, gamma: 0.8, spacing: 0.06, flow: 1.0,  pressureSize: true,  pressureOpacity: false, grain: 0,    grainScale: 1 },
  pencil:     { label: '鉛筆',       hardness: 65, min: 0.45, gamma: 1.0, spacing: 0.10, flow: 0.85, pressureSize: true,  pressureOpacity: true,  grain: 0.6,  grainScale: 1 },
  chalk:      { label: 'チョーク',   hardness: 55, min: 0.60, gamma: 1.0, spacing: 0.12, flow: 0.9,  pressureSize: true,  pressureOpacity: true,  grain: 0.85, grainScale: 2.5 },
  marker:     { label: 'マーカー',   hardness: 80, min: 1.00, gamma: 1.0, spacing: 0.08, flow: 1.0,  pressureSize: false, pressureOpacity: false, grain: 0,    grainScale: 1, opacity: 60 },
  airbrush:   { label: 'エアブラシ', hardness: 0,  min: 1.00, gamma: 1.0, spacing: 0.06, flow: 0.12, pressureSize: false, pressureOpacity: true,  grain: 0,    grainScale: 1 },
  watercolor: { label: '水彩',       hardness: 20, min: 0.50, gamma: 1.0, spacing: 0.08, flow: 0.3,  pressureSize: true,  pressureOpacity: true,  grain: 0.25, grainScale: 3 },
};
const ERASER_PRESETS = ['round', 'airbrush', 'pencil', 'chalk'];

class BrushTool extends Tool {
  constructor(app, eraser = false) {
    super(app, eraser ? 'eraser' : 'brush', eraser ? '消しゴム' : 'ブラシ',
      { kind: 'round', size: eraser ? 40 : 12, opacity: 100, hardness: eraser ? 80 : 85, pressureSize: true, pressureOpacity: false, smoothing: 2 });
    this.eraser = eraser;
    this.showsHover = true;
    this.active = false;
    if (!BRUSH_PRESETS[this.opts.kind]) this.opts.kind = 'round';
  }
  get preset() { return BRUSH_PRESETS[this.opts.kind] || BRUSH_PRESETS.round; }
  presetKeys() { return this.eraser ? ERASER_PRESETS : Object.keys(BRUSH_PRESETS); }
  /** ペンの種類を選ぶ（硬さ・筆圧の設定もその種類の標準に） */
  setPreset(kind) {
    const p = BRUSH_PRESETS[kind];
    if (!p) return;
    this.opts.kind = kind;
    this.opts.hardness = p.hardness;
    this.opts.pressureSize = p.pressureSize;
    this.opts.pressureOpacity = p.pressureOpacity;
    if (p.opacity && !this.eraser) this.opts.opacity = p.opacity;
    else if (this.opts.opacity === 60 && kind !== 'marker') this.opts.opacity = 100;
    this.setOpt('kind', kind);
  }
  spec() {
    return [
      { type: 'preset' },
      { key: 'size', label: 'サイズ', type: 'range', min: 1, max: 500, curve: 2, unit: 'px' },
      { key: 'opacity', label: '不透明度', type: 'range', min: 1, max: 100, unit: '%' },
      { key: 'hardness', label: '硬さ', type: 'range', min: 0, max: 100, unit: '%' },
      { key: 'smoothing', label: '手ぶれ補正', type: 'range', min: 0, max: 10, unit: '' },
      { key: 'pressureSize', label: '筆圧でサイズ', type: 'check' },
      { key: 'pressureOpacity', label: '筆圧で濃さ', type: 'check' },
    ];
  }
  tip() {
    const color = this.eraser ? '#000000' : this.app.fg;
    const key = color + '|' + this.opts.hardness;
    if (this._tipKey === key) return this._tip;
    const S = 128;
    const c = newCanvas(S, S), g = ctx2d(c);
    const h = clamp(this.opts.hardness / 100, 0, 1);
    const [r, gg, b] = Color.hexToRgb(color);
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    const inner = Math.min(0.97, h);
    grad.addColorStop(0, `rgba(${r},${gg},${b},1)`);
    grad.addColorStop(inner, `rgba(${r},${gg},${b},1)`);
    if (h < 0.97) {      // なめらかに落とす
      for (let i = 1; i <= 6; i++) {
        const t = i / 6;
        const s = inner + (1 - inner) * t;
        const a = 1 - t * t * (3 - 2 * t);
        grad.addColorStop(Math.min(1, s), `rgba(${r},${gg},${b},${a.toFixed(3)})`);
      }
    } else grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    this._tip = c; this._tipKey = key;
    return c;
  }
  down(p) {
    const d = this.doc;
    const t = this.app.paintTarget();
    if (typeof t === 'string') { toast(t, { error: true }); return; }
    this.layer = t.layer;
    this.attr = t.attr;                    // 'canvas'（画素）か 'mask'
    this.buf = this.app.scratch('stroke');
    this.bg = ctx2d(this.buf);
    this.bg.clearRect(0, 0, d.width, d.height);
    this.liveC = this.app.scratch('live');
    this.dirty = null;
    this.active = true;
    this.sm = { x: p.x, y: p.y, pressure: p.pressure };
    this.last = { ...this.sm };
    this.carry = 0;
    this.pressureSeen = p.type === 'pen';
    const layer = this.layer;
    d.live = { layer, [this.attr === 'mask' ? 'mask' : 'canvas']: this.liveC, update: (r) => this.updateLive(r) };
    this.dab(p.x, p.y, p.pressure);
    this.flushDirty();
  }
  move(p) {
    if (!this.active) return;
    const s = this.opts.smoothing;
    const k = s > 0 ? 1 / (1 + s * 0.9) : 1;
    const sm = this.sm;
    sm.x += (p.x - sm.x) * k;
    sm.y += (p.y - sm.y) * k;
    sm.pressure += (p.pressure - sm.pressure) * Math.min(1, k * 1.5);
    this.lineTo(sm.x, sm.y, sm.pressure);
    this.flushDirty();
  }
  up(p) {
    if (!this.active) return;
    this.lineTo(p.x, p.y, this.sm.pressure);    // 補正で遅れた分を追いつかせる
    this.commit();
  }
  cancel() {
    if (!this.active) return;
    this.active = false;
    const d = this.doc;
    d.live = null;
    if (this.dirty) d.invalidate(this.dirty);
  }
  radius(pressure) {
    const base = this.opts.size / 2;
    if (!this.opts.pressureSize) return base;
    const p = this.preset;
    return Math.max(0.5, base * (p.min + (1 - p.min) * Math.pow(clamp(pressure, 0, 1), p.gamma)));
  }
  lineTo(x, y, pressure) {
    const l = this.last;
    const dx = x - l.x, dy = y - l.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-3) return;
    const r = this.radius((l.pressure + pressure) / 2);
    const step = Math.max(0.5, r * 2 * this.preset.spacing);
    let t = step - this.carry;
    while (t <= dist) {
      const f = t / dist;
      this.dab(l.x + dx * f, l.y + dy * f, l.pressure + (pressure - l.pressure) * f);
      t += step;
    }
    this.carry = dist - (t - step);
    this.last = { x, y, pressure };
  }
  dab(x, y, pressure) {
    const r = this.radius(pressure);
    const g = this.bg;
    g.globalAlpha = this.preset.flow * (this.opts.pressureOpacity ? clamp(pressure, 0.05, 1) : 1);
    g.drawImage(this.tip(), x - r, y - r, r * 2, r * 2);
    g.globalAlpha = 1;
    const rect = Rect.clampTo({ x: x - r, y: y - r, w: r * 2, h: r * 2 }, this.doc.width, this.doc.height, 1);
    if (!rect) return;
    const sel = this.doc.sel;
    if (sel) {         // 選択範囲の外は描かない（destination-in は描いた範囲の外も消すので、先に範囲を絞る）
      g.save();
      g.beginPath(); g.rect(rect.x, rect.y, rect.w, rect.h); g.clip();
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(sel.canvas, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
      g.restore();
    }
    this.dirty = Rect.union(this.dirty, rect);
    this.pending = Rect.union(this.pending, rect);
  }
  flushDirty() {
    if (this.pending) { this.doc.invalidate(this.pending, 'live'); this.pending = null; }
  }
  /** 描き方（消しゴム・透明部分ロック・マスク） */
  mode() {
    const l = this.layer;
    if (this.attr === 'mask') return { mask: true, gray: grayOf(this.eraser ? this.app.bg : this.app.fg) };
    if (this.eraser) return l.alpha_locked ? { gco: 'source-atop', color: this.app.bg } : { gco: 'destination-out' };
    return { gco: l.alpha_locked ? 'source-atop' : 'source-over' };
  }
  applyTo(g, r) {
    const m = this.mode();
    const grain = this.preset.grain;
    let src = this.buf;
    if (m.color || grain > 0 || m.mask) {
      // 紙の質感（紙に固定した模様で筆跡を削る）・透明部分ロック中の消しゴム（背景色で塗る）は作業用 canvas で作る
      const tmp = this.app.scratch('tint');
      const tg = ctx2d(tmp);
      tg.save();
      tg.beginPath(); tg.rect(r.x, r.y, r.w, r.h); tg.clip();
      tg.clearRect(r.x, r.y, r.w, r.h);
      tg.drawImage(this.buf, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      if (grain > 0) {
        tg.globalCompositeOperation = 'destination-out';
        tg.fillStyle = tg.createPattern(grainTexture(grain, this.preset.grainScale), 'repeat');
        tg.fillRect(r.x, r.y, r.w, r.h);
      }
      if (m.color) {
        tg.globalCompositeOperation = 'source-in';
        tg.fillStyle = m.color;
        tg.fillRect(r.x, r.y, r.w, r.h);
      }
      tg.restore();
      src = tmp;
    }
    if (m.mask) { paintMask(g, src, r, this.opts.opacity / 100, m.gray); return; }    // マスク: 明るさを fg（消しゴムは bg）へ寄せる
    g.save();
    g.globalAlpha = this.opts.opacity / 100;
    g.globalCompositeOperation = m.gco;
    g.drawImage(src, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    g.restore();
  }
  updateLive(r) {
    const g = ctx2d(this.liveC);
    g.clearRect(r.x, r.y, r.w, r.h);
    g.drawImage(this.layer[this.attr], r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    this.applyTo(g, r);
  }
  commit() {
    this.active = false;
    const d = this.doc;
    d.live = null;
    if (!this.dirty) return;
    d.beginPixels(this.layer, this.attr);
    this.applyTo(ctx2d(this.layer[this.attr]), this.dirty);
    d.endPixels(this.attr === 'mask' ? this.label + '（マスク）' : this.label, this.dirty);
  }
  drawOverlay(g, view) {
    if (this.active || !view.hover) return;
    const s = view.toScreen(view.hover.x, view.hover.y);
    const r = Math.max(1.5, (this.opts.size / 2) * view.scale);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(0,0,0,.7)';
    g.beginPath(); g.arc(s.x, s.y, r + 0.5, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.85)';
    g.beginPath(); g.arc(s.x, s.y, Math.max(0.5, r - 0.5), 0, Math.PI * 2); g.stroke();
  }
}

/** 紙の質感の模様（つなぎ目の無い 256px のノイズ。アルファ = 削る強さ） */
const _grainCache = {};
function grainTexture(strength, scale) {
  const key = strength + '|' + scale;
  if (_grainCache[key]) return _grainCache[key];
  const S = 256;
  const val = new Float32Array(S * S);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let amp = 1, total = 0;
  for (const cell of [Math.max(1, Math.round(2 * scale)), Math.max(2, Math.round(5 * scale)), Math.max(4, Math.round(16 * scale))]) {
    const n = Math.ceil(S / cell);
    const grid = Float32Array.from({ length: n * n }, rnd);
    const at = (gx, gy) => grid[((gy % n) + n) % n * n + ((gx % n) + n) % n];
    for (let y = 0; y < S; y++) {
      const gy = y / cell, y0 = Math.floor(gy), fy = gy - y0, sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < S; x++) {
        const gx = x / cell, x0 = Math.floor(gx), fx = gx - x0, sx = fx * fx * (3 - 2 * fx);
        const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
        const bot = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
        val[y * S + x] += amp * (top * (1 - sy) + bot * sy);
      }
    }
    total += amp;
    amp *= 0.55;
  }
  const c = newCanvas(S, S), g = ctx2d(c);
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = val[i] / total;                       // 0..1、平均 0.5
    img.data[i * 4 + 3] = Math.round(clamp((v - 0.35) * 2.2, 0, 1) * strength * 255);
  }
  g.putImageData(img, 0, 0);
  _grainCache[key] = c;
  return c;
}

// ---- スポイト --------------------------------------------------------------------
class EyedropperTool extends Tool {
  constructor(app) { super(app, 'eyedropper', 'スポイト', { source: 'all' }); this.showsHover = true; }
  spec() { return [{ key: 'source', type: 'seg', items: [['all', '全レイヤー'], ['layer', '現在のレイヤー']] }]; }
  needsLayer() { return this.opts.source === 'layer' ? 'pixels' : false; }
  pick(p) {
    const d = this.doc;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= d.width || y >= d.height) return;
    const src = this.opts.source === 'layer' && d.active ? d.active.canvas : d.composite();
    const px = ctx2d(src).getImageData(x, y, 1, 1).data;
    if (px[3] === 0) return;
    // 半透明は白の上に置いた色にする
    const a = px[3] / 255;
    const hex = Color.rgbToHex(px[0] * a + 255 * (1 - a), px[1] * a + 255 * (1 - a), px[2] * a + 255 * (1 - a));
    this.picked = hex;
    if (p.alt) this.app.setBg(hex); else this.app.setFg(hex, { recent: false });
    this.at = p;
  }
  down(p) { this.picking = true; this.pick(p); }
  move(p) { if (this.picking) this.pick(p); }
  up() {
    this.picking = false; this.at = null;
    if (this.picked) this.app.addRecent(this.app.fg);
  }
  drawOverlay(g, view) {
    const at = this.at || view.hover;
    if (!at || !this.at) return;
    const s = view.toScreen(at.x, at.y);
    g.lineWidth = 10;
    g.strokeStyle = this.app.fg;
    g.beginPath(); g.arc(s.x, s.y - 60, 30, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1.5; g.strokeStyle = '#fff';
    g.beginPath(); g.arc(s.x, s.y - 60, 35.5, 0, Math.PI * 2); g.stroke();
  }
}

// ---- 塗りつぶし ------------------------------------------------------------------
class FillTool extends Tool {
  constructor(app) { super(app, 'fill', '塗りつぶし', { tolerance: 32, contiguous: true, allLayers: false, gap: true, opacity: 100 }); }
  spec() {
    return [
      { key: 'tolerance', label: '許容値', type: 'range', min: 0, max: 255, unit: '' },
      { key: 'opacity', label: '不透明度', type: 'range', min: 1, max: 100, unit: '%' },
      { key: 'contiguous', label: '隣接', type: 'check' },
      { key: 'allLayers', label: '全レイヤーを対象', type: 'check' },
      { key: 'gap', label: '線との隙間を埋める', type: 'check' },
    ];
  }
  down(p) {
    const d = this.doc;
    const t = this.app.paintTarget();
    if (typeof t === 'string') { toast(t, { error: true }); return; }
    const layer = t.layer, onMask = t.attr === 'mask';
    const W = d.width, H = d.height;
    if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
    let data;
    if (onMask) {            // マスクの明るさで範囲を決める
      data = ctx2d(layer.mask).getImageData(0, 0, W, H).data;
      for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = data[i + 3]; data[i + 3] = 255; }
    } else data = ctx2d(this.opts.allLayers ? d.composite() : layer.canvas).getImageData(0, 0, W, H).data;
    let mask = regionMask(data, W, H, p.x, p.y, this.opts.tolerance, this.opts.contiguous);
    if (this.opts.gap) mask = dilate1(mask, W, H);
    const selA = d.sel ? Sel.alphaOf(d.sel, W, H) : null;
    const [r, g, b] = Color.hexToRgb(this.app.fg);
    const fill = newCanvas(W, H);
    const img = ctx2d(fill).createImageData(W, H);
    const o = img.data;
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0, i = 0; y < H; y++) {
      for (let x = 0; x < W; x++, i++) {
        let a = mask[i];
        if (selA) a = (a * selA[i]) / 255;
        if (!a) continue;
        const j = i * 4;
        o[j] = r; o[j + 1] = g; o[j + 2] = b; o[j + 3] = a;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; maxY = y;
      }
    }
    if (maxX < 0) return;
    ctx2d(fill).putImageData(img, 0, 0);
    const rect = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    if (onMask) {
      d.editPixels('塗りつぶし（マスク）', layer, rect, (gm) => paintMask(gm, fill, rect, this.opts.opacity / 100, grayOf(this.app.fg)), { attr: 'mask' });
      return;
    }
    d.editPixels('塗りつぶし', layer, rect, (gc) => {
      gc.globalAlpha = this.opts.opacity / 100;
      gc.globalCompositeOperation = layer.alpha_locked ? 'source-atop' : 'source-over';
      gc.drawImage(fill, 0, 0);
    });
  }
}
function dilate1(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (m[i]) { o[i] = 255; continue; }
      if ((x > 0 && m[i - 1]) || (x < w - 1 && m[i + 1]) || (y > 0 && m[i - w]) || (y < h - 1 && m[i + w])) o[i] = 255;
    }
  }
  return o;
}

// ---- グラデーション --------------------------------------------------------------
class GradientTool extends Tool {
  constructor(app) { super(app, 'gradient', 'グラデーション', { kind: 'linear', colors: 'fgbg', opacity: 100 }); }
  spec() {
    return [
      { key: 'kind', type: 'seg', items: [['linear', '線形'], ['radial', '円形']] },
      { key: 'colors', type: 'seg', items: [['fgbg', '描画色→背景色'], ['fgclear', '描画色→透明']] },
      { key: 'opacity', label: '不透明度', type: 'range', min: 1, max: 100, unit: '%' },
    ];
  }
  down(p) { this.a = p; this.b = p; }
  move(p) { if (this.a) this.b = snap45(this.a, p, p.shift); }
  up(p) {
    if (!this.a) return;
    const a = this.a, b = snap45(a, p, p.shift);
    this.a = this.b = null;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2) { this.view.request(); return; }
    const d = this.doc;
    const t = this.app.paintTarget();
    if (typeof t === 'string') { toast(t, { error: true }); return; }
    const layer = t.layer;
    const W = d.width, H = d.height;
    const tmp = newCanvas(W, H), g = ctx2d(tmp);
    if (t.attr === 'mask') {
      const g0 = grayOf(this.app.fg), g1 = this.opts.colors === 'fgbg' ? grayOf(this.app.bg) : 0;
      const gr = this.opts.kind === 'radial' ? g.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y)) : g.createLinearGradient(a.x, a.y, b.x, b.y);
      gr.addColorStop(0, `rgba(255,255,255,${g0})`); gr.addColorStop(1, `rgba(255,255,255,${g1})`);
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      const region = d.sel ? d.sel.canvas : null;
      if (region) { g.globalCompositeOperation = 'destination-in'; g.drawImage(region, 0, 0); }
      const op = this.opts.opacity / 100;
      d.editPixels('グラデーション（マスク）', layer, d.sel ? d.sel.bounds : d.fullRect, (gm) => {
        gm.globalAlpha = op;
        gm.globalCompositeOperation = 'destination-out';
        if (region) gm.drawImage(region, 0, 0); else { gm.fillStyle = '#fff'; gm.fillRect(0, 0, W, H); }
        gm.globalCompositeOperation = 'lighter';
        gm.drawImage(tmp, 0, 0);
      }, { attr: 'mask' });
      return;
    }
    const grad = this.opts.kind === 'radial'
      ? g.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y))
      : g.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, this.app.fg);
    if (this.opts.colors === 'fgbg') grad.addColorStop(1, this.app.bg);
    else { const [r, gg, bb] = Color.hexToRgb(this.app.fg); grad.addColorStop(1, `rgba(${r},${gg},${bb},0)`); }
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    const rect = d.sel ? d.sel.bounds : d.fullRect;
    if (d.sel) { g.globalCompositeOperation = 'destination-in'; g.drawImage(d.sel.canvas, 0, 0); }
    d.editPixels('グラデーション', layer, rect, (gc) => {
      gc.globalAlpha = this.opts.opacity / 100;
      gc.globalCompositeOperation = layer.alpha_locked ? 'source-atop' : 'source-over';
      gc.drawImage(tmp, 0, 0);
    });
  }
  cancel() { this.a = this.b = null; }
  drawOverlay(g, view) {
    if (!this.a) return;
    const s = view.toScreen(this.a.x, this.a.y), e = view.toScreen(this.b.x, this.b.y);
    g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.6)';
    g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(e.x, e.y); g.stroke();
    g.lineWidth = 1.5; g.strokeStyle = '#fff';
    g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(e.x, e.y); g.stroke();
    for (const [pt, c] of [[s, this.app.fg], [e, this.opts.colors === 'fgbg' ? this.app.bg : '#ffffff00']]) {
      g.fillStyle = c; g.strokeStyle = '#fff';
      g.beginPath(); g.arc(pt.x, pt.y, 7, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
}
function snap45(a, p, on) {
  if (!on) return { x: p.x, y: p.y };
  const dx = p.x - a.x, dy = p.y - a.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

// ---- 選択ツール ------------------------------------------------------------------
class MarqueeTool extends Tool {
  constructor(app, ellipse) {
    super(app, ellipse ? 'marquee_ellipse' : 'marquee_rect', ellipse ? '楕円形選択' : '長方形選択', { mode: 'replace' });
    this.ellipse = ellipse;
  }
  spec() { return [SEL_MODE_SEG]; }
  needsLayer() { return false; }
  down(p) { this.a = p; this.b = p; this.p = p; }
  move(p) { if (this.a) { this.b = p; this.p = p; } }
  rect(p) {
    let { x: x0, y: y0 } = this.a, x1 = this.b.x, y1 = this.b.y;
    if (p && p.shift && this.opts.mode !== 'add') {       // Shift は正方形・正円にもする（モードが新規のとき）
      const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s;
    }
    return Rect.fromPoints(x0, y0, x1, y1);
  }
  up(p) {
    if (!this.a) return;
    this.b = p;
    const r = this.rect(p);
    const mode = selMode(this, p);
    this.a = null;
    const d = this.doc;
    if (r.w * this.view.scale < 3 && r.h * this.view.scale < 3) {          // クリックだけ = 選択解除
      if (mode === 'replace' && d.sel) d.setSelection(null, '選択を解除');
      return;
    }
    const shape = Sel.shape(d.width, d.height, (g) => {
      if (this.ellipse) g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      else g.rect(Math.round(r.x), Math.round(r.y), Math.round(r.x + r.w) - Math.round(r.x), Math.round(r.y + r.h) - Math.round(r.y));
    });
    d.setSelection(Sel.combine(d.sel, shape, mode, d.width, d.height), this.label);
  }
  cancel() { this.a = null; }
  drawOverlay(g, view) {
    if (!this.a) return;
    const r = this.rect(this.p);
    const s = view.toScreen(r.x, r.y);
    const w = r.w * view.scale, h = r.h * view.scale;
    g.lineWidth = 1;
    g.setLineDash([5, 4]);
    for (const c of ['#000', '#fff']) {
      g.strokeStyle = c;
      g.lineDashOffset = c === '#fff' ? 4 : 0;
      g.beginPath();
      if (this.ellipse) g.ellipse(s.x + w / 2, s.y + h / 2, Math.max(0.1, w / 2), Math.max(0.1, h / 2), 0, 0, Math.PI * 2);
      else g.rect(s.x + 0.5, s.y + 0.5, w, h);
      g.stroke();
    }
    g.setLineDash([]);
    // 大きさの表示
    const label = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    g.font = '12px sans-serif';
    const tw = g.measureText(label).width + 12;
    g.fillStyle = 'rgba(0,0,0,.75)';
    g.fillRect(s.x + w + 8, s.y + h + 8, tw, 20);
    g.fillStyle = '#fff';
    g.fillText(label, s.x + w + 14, s.y + h + 22);
  }
}

class LassoTool extends Tool {
  constructor(app) { super(app, 'lasso', 'なげなわ', { mode: 'replace' }); }
  spec() { return [SEL_MODE_SEG]; }
  needsLayer() { return false; }
  down(p) { this.pts = [p]; }
  move(p) {
    if (!this.pts) return;
    const l = this.pts[this.pts.length - 1];
    if (Math.hypot(p.x - l.x, p.y - l.y) * this.view.scale >= 2) this.pts.push(p);
  }
  up(p) {
    if (!this.pts) return;
    const pts = this.pts;
    this.pts = null;
    const d = this.doc;
    const mode = selMode(this, p);
    if (pts.length < 3) { if (mode === 'replace' && d.sel) d.setSelection(null, '選択を解除'); return; }
    const shape = Sel.shape(d.width, d.height, (g) => {
      g.moveTo(pts[0].x, pts[0].y);
      for (const q of pts) g.lineTo(q.x, q.y);
      g.closePath();
    });
    d.setSelection(Sel.combine(d.sel, shape, mode, d.width, d.height), 'なげなわ選択');
  }
  cancel() { this.pts = null; }
  drawOverlay(g, view) {
    if (!this.pts) return;
    g.lineWidth = 1;
    for (const c of ['#000', '#fff']) {
      g.strokeStyle = c;
      g.setLineDash(c === '#fff' ? [5, 4] : []);
      g.beginPath();
      this.pts.forEach((q, i) => { const s = view.toScreen(q.x, q.y); i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); });
      g.stroke();
    }
    g.setLineDash([]);
  }
}

class WandTool extends Tool {
  constructor(app) { super(app, 'wand', '自動選択', { mode: 'replace', tolerance: 32, contiguous: true, allLayers: false }); }
  spec() {
    return [SEL_MODE_SEG,
      { key: 'tolerance', label: '許容値', type: 'range', min: 0, max: 255, unit: '' },
      { key: 'contiguous', label: '隣接', type: 'check' },
      { key: 'allLayers', label: '全レイヤーを対象', type: 'check' }];
  }
  needsLayer() { return this.opts.allLayers ? false : 'pixels'; }
  down(p) {
    const d = this.doc;
    const W = d.width, H = d.height;
    if (p.x < 0 || p.y < 0 || p.x >= W || p.y >= H) return;
    const src = this.opts.allLayers ? d.composite() : d.active.canvas;
    const data = ctx2d(src).getImageData(0, 0, W, H).data;
    const mask = regionMask(data, W, H, p.x, p.y, this.opts.tolerance, this.opts.contiguous);
    const shape = Sel.fromAlpha(mask, W, H);
    if (!shape) return;
    d.setSelection(Sel.combine(d.sel, shape.canvas, selMode(this, p), W, H), '自動選択');
  }
}

// ---- 移動 ------------------------------------------------------------------------
class MoveTool extends Tool {
  constructor(app) { super(app, 'move', '移動', {}); }
  needsLayer() { return 'move'; }
  /** 何を動かすか: attr = 'canvas'（画素）か 'mask'、withMask = マスクも一緒に */
  plan() {
    const d = this.doc, l = d.active;
    if (d.editingMask && l.mask) return { attr: 'mask', withMask: false, sel: d.sel };
    if (l.isText) return { attr: 'canvas', withMask: !!l.mask, sel: null };
    return { attr: 'canvas', withMask: !!l.mask && !d.sel, sel: d.sel };
  }
  split(layer, attr, sel) {
    const W = this.doc.width, H = this.doc.height;
    const float = cloneCanvas(layer[attr]), base = newCanvas(W, H);
    if (sel) {
      const fg = ctx2d(float); fg.globalCompositeOperation = 'destination-in'; fg.drawImage(sel.canvas, 0, 0);
      const bg = ctx2d(base); bg.drawImage(layer[attr], 0, 0); bg.globalCompositeOperation = 'destination-out'; bg.drawImage(sel.canvas, 0, 0);
    }
    return { float, base };
  }
  spec() { return [{ type: 'note', text: 'ドラッグでレイヤー（選択範囲があればその中身）を動かす。キーボードの矢印でも 1px（Shift で 10px）' }]; }
  down(p) {
    const d = this.doc, layer = d.active;
    this.layer = layer;
    this.start = p;
    this.dx = 0; this.dy = 0;
    this.pl = this.plan();
    const { float, base } = this.split(layer, this.pl.attr, this.pl.sel);
    this.float = float; this.base = base;
    this.liveC = this.app.scratch('live');
    d.live = { layer, update: (r) => this.updateLive(r) };
    d.live[this.pl.attr] = this.liveC;
    if (this.pl.withMask) { this.liveM = this.app.scratch('liveMask'); d.live.mask = this.liveM; }
    this.hideAnts = !!this.pl.sel;
  }
  updateLive(r) {
    const g = ctx2d(this.liveC);
    g.save();
    g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
    g.clearRect(r.x, r.y, r.w, r.h);
    g.drawImage(this.base, 0, 0);
    g.drawImage(this.float, this.dx, this.dy);
    g.restore();
    if (this.liveM) {
      const m = ctx2d(this.liveM);
      m.save(); m.beginPath(); m.rect(r.x, r.y, r.w, r.h); m.clip();
      shiftedMaskInto(m, this.layer.mask, this.dx, this.dy, this.doc.width, this.doc.height);
      m.restore();
    }
  }
  move(p) {
    if (!this.start) return;
    let dx = Math.round(p.x - this.start.x), dy = Math.round(p.y - this.start.y);
    if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    if (dx === this.dx && dy === this.dy) return;
    this.dx = dx; this.dy = dy;
    this.doc.invalidate(null, 'live');
  }
  up() {
    if (!this.start) return;
    const { dx, dy } = this;
    this.start = null;
    this.hideAnts = false;
    this.liveM = null;
    const d = this.doc;
    d.live = null;
    if (!dx && !dy) { d.invalidate(null, 'live'); return; }
    this.commitOffset(this.layer, dx, dy, this.base, this.float, this.pl);
  }
  cancel() {
    if (!this.start) return;
    this.start = null; this.hideAnts = false; this.liveM = null;
    this.doc.live = null;
    this.doc.invalidate(null, 'live');
  }
  /** base の上に float を (dx, dy) ずらして置いた canvas に差し替える（選択範囲も一緒に動かす） */
  commitOffset(layer, dx, dy, base, float, pl = this.plan()) {
    const d = this.doc;
    const W = d.width, H = d.height;
    d.change(pl.attr === 'mask' ? '移動（マスク）' : this.label, () => {
      if (layer.isText && pl.attr === 'canvas') {          // テキストは行列を動かして描き直す（ぼやけない）
        layer.text = { ...layer.text, matrix: matMul([1, 0, 0, 1, dx, dy], layer.text.matrix) };
        layer.canvas = renderTextSpec(layer.text, W, H);
      } else {
        const c = cloneCanvas(base);
        ctx2d(c).drawImage(float, dx, dy);
        layer[pl.attr] = c;
      }
      if (pl.withMask) {
        const m = newCanvas(W, H);
        shiftedMaskInto(ctx2d(m), layer.mask, dx, dy, W, H);
        layer.mask = m;
      }
      if (pl.sel && d.sel) {
        const s = newCanvas(W, H);
        ctx2d(s).drawImage(d.sel.canvas, dx, dy);
        const b = Rect.intersect({ x: d.sel.bounds.x + dx, y: d.sel.bounds.y + dy, w: d.sel.bounds.w, h: d.sel.bounds.h }, d.fullRect);
        d.sel = b ? { canvas: s, bounds: b } : null;
      }
    });
  }
  nudge(dx, dy) {
    const d = this.doc, layer = d.active;
    if (!layer || this.app.cannotEdit(this)) return;
    const pl = this.plan();
    const { float, base } = this.split(layer, pl.attr, pl.sel);
    this.commitOffset(layer, dx, dy, base, float, pl);
  }
}

/** マスクを (dx, dy) ずらして描く（はみ出して空いた所は「見える」= 白） */
function shiftedMaskInto(g, mask, dx, dy, W, H) {
  g.save();
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.clearRect(dx, dy, W, H);
  g.drawImage(mask, dx, dy);
  g.restore();
}

class HandTool extends Tool {
  constructor(app) { super(app, 'hand', '手のひら（画面の移動）', {}); }
  spec() { return [{ type: 'note', text: '2本指でつまむと拡大縮小、2本指タップで取り消し、3本指タップでやり直し' }]; }
  needsLayer() { return false; }
}
class ZoomTool extends Tool {
  constructor(app) { super(app, 'zoom', 'ズーム', {}); }
  spec() { return [{ type: 'note', text: 'タップで拡大（Alt で縮小）' }]; }
  needsLayer() { return false; }
}

const TOOL_ICONS = {
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  marquee_rect: '<rect x="4" y="5" width="16" height="14" stroke-dasharray="3 2.5"/>',
  marquee_ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5" stroke-dasharray="3 2.5"/>',
  lasso: '<path d="M7 17c-3-1-4-4-2-7s7-5 11-4 5 4 3 7-6 4-9 3"/><path d="M7 17c-1 2 0 4 2 4"/>',
  wand: '<path d="M4 20 15 9M14 4v3M18.5 5.5l-2 2M20 10h-3M12 8l4 4"/>',
  brush: '<path d="M14 4l6 6-8 8H6v-6z"/><path d="M12 6l6 6"/>',
  eraser: '<path d="M8 20h12M4.5 15.5 14 6l5 5-9.5 9.5H9z"/><path d="M9 11l5 5"/>',
  fill: '<path d="M5 11 12 4l7 7-7 7z"/><path d="M5 11h14M20 16c0 1.5 1 2.5 1 3.5a1 1 0 0 1-2 0c0-1 1-2 1-3.5z"/>',
  gradient: '<rect x="4" y="5" width="16" height="14" rx="1"/><path d="M8 5v14M12 5v14M16 5v14" stroke-opacity=".5"/>',
  eyedropper: '<path d="M4 20l1-4 8-8 3 3-8 8z"/><path d="M13 8l2-2a2.1 2.1 0 0 1 3 3l-2 2"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  transform: '<rect x="5" y="5" width="14" height="14" stroke-dasharray="2 2"/><path d="M3 3h4v4H3zM17 3h4v4h-4zM17 17h4v4h-4zM3 17h4v4H3z"/>',
  crop: '<path d="M6 2v16h16M2 6h16v16"/>',
  hand: '<path d="M8 13V6a1.5 1.5 0 0 1 3 0v6M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v8c0 4-2.5 6-6 6s-5-2-6.5-4.5L4 13a1.5 1.5 0 0 1 2.5-1.5L8 13"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5M10.5 8v5"/>',
};
const TOOL_KEYS = { text: 'T', transform: '⌘T', crop: 'C', move: 'V', marquee_rect: 'M', lasso: 'L', wand: 'W', brush: 'B', eraser: 'E', fill: 'G', gradient: 'G', eyedropper: 'I', hand: 'H', zoom: 'Z' };

function makeTools(app) {
  const list = [
    new MoveTool(app), new TransformTool(app), new CropTool(app), new MarqueeTool(app, false), new MarqueeTool(app, true), new LassoTool(app), new WandTool(app),
    null,
    new BrushTool(app, false), new BrushTool(app, true), new FillTool(app), new GradientTool(app), new EyedropperTool(app), new TextTool(app),
    null,
    new HandTool(app), new ZoomTool(app),
  ];
  return list;
}
