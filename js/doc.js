'use strict';
/* 文書モデル: レイヤー・合成・履歴。画面（DOM）には触らない。 */

// exe 版と同じキー。gco = Canvas の合成方法、exact = 式がそのまま同じか（false は近い式で代用）
const BLEND_MODES = [
  ['normal', '通常', 'source-over', true],
  ['dissolve', 'ディザ合成', 'source-over', false],
  ['darken', '比較（暗）', 'darken', true],
  ['multiply', '乗算', 'multiply', true],
  ['color_burn', '焼き込みカラー', 'color-burn', true],
  ['linear_burn', '焼き込み（リニア）', 'multiply', false],
  ['darker_color', 'カラー比較（暗）', 'darken', false],
  ['lighten', '比較（明）', 'lighten', true],
  ['screen', 'スクリーン', 'screen', true],
  ['color_dodge', '覆い焼きカラー', 'color-dodge', true],
  ['linear_dodge', '覆い焼き（リニア）- 加算', 'lighter', true],
  ['lighter_color', 'カラー比較（明）', 'lighten', false],
  ['overlay', 'オーバーレイ', 'overlay', true],
  ['soft_light', 'ソフトライト', 'soft-light', true],
  ['hard_light', 'ハードライト', 'hard-light', true],
  ['vivid_light', 'ビビッドライト', 'hard-light', false],
  ['linear_light', 'リニアライト', 'hard-light', false],
  ['pin_light', 'ピンライト', 'hard-light', false],
  ['hard_mix', 'ハードミックス', 'hard-light', false],
  ['difference', '差の絶対値', 'difference', true],
  ['exclusion', '除外', 'exclusion', true],
  ['subtract', '減算', 'difference', false],
  ['divide', '除算', 'color-dodge', false],
  ['hue', '色相', 'hue', true],
  ['saturation', '彩度', 'saturation', true],
  ['color', 'カラー', 'color', true],
  ['luminosity', '輝度', 'luminosity', true],
];
const BLEND = Object.fromEntries(BLEND_MODES.map(([k, label, gco, exact]) => [k, { label, gco, exact }]));
const LAYER_PROPS = ['name', 'visible', 'opacity', 'blend', 'alpha_locked', 'locked'];

let _nextLayerId = 1;
function bumpLayerId(n) { _nextLayerId = Math.max(_nextLayerId, n + 1); }

class Layer {
  constructor(w, h, name = 'レイヤー', canvas = null) {
    this.id = _nextLayerId++;
    this.name = name;
    this.visible = true;
    this.opacity = 1;
    this.blend = 'normal';
    this.alpha_locked = false;
    this.locked = false;
    this.extra = {};          // Web 版では扱わない exe の属性（text・styles など）。.sko の往復で失わないよう持つ
    this.canvas = canvas || newCanvas(w, h);
    this.ver = 0;             // 画素をその場で書き換えるたびに増える（サムネイル・自動保存の差分用）
  }
  get ctx() { return this.canvas.getContext('2d'); }
  props() {
    const p = {};
    for (const k of LAYER_PROPS) p[k] = this[k];
    p.extra = this.extra;     // extra は差し替えて使う（中身を書き換えない）
    return p;
  }
  setProps(p) { for (const k of [...LAYER_PROPS, 'extra']) if (k in p) this[k] = p[k]; }
}

// ---- 履歴 ------------------------------------------------------------------------
class PixelCmd {
  constructor(label, layer, rect, before, after) {
    Object.assign(this, { label, layer, canvas: layer.canvas, rect, before, after });
    this.bytes = rect.w * rect.h * 8 + 200;
    layer.ver++;
  }
  undo(doc) { this.canvas.getContext('2d').putImageData(this.before, this.rect.x, this.rect.y); this.layer.ver++; doc.invalidate(this.rect, 'pixels'); }
  redo(doc) { this.canvas.getContext('2d').putImageData(this.after, this.rect.x, this.rect.y); this.layer.ver++; doc.invalidate(this.rect, 'pixels'); }
}

class StateCmd {
  constructor(label, before, after) {
    Object.assign(this, { label, before, after });
    // 履歴だけが持っている canvas のおおよそのメモリ
    const live = new Set(after.layers.map((e) => e.canvas));
    let bytes = 500;
    for (const e of before.layers) if (!live.has(e.canvas)) bytes += e.canvas.width * e.canvas.height * 4;
    if (before.sel && before.sel !== after.sel) bytes += before.sel.canvas.width * before.sel.canvas.height * 4;
    this.bytes = bytes;
  }
  undo(doc) { doc.restore(this.before); }
  redo(doc) { doc.restore(this.after); }
}

class History {
  constructor(doc) {
    this.doc = doc;
    this.list = [];
    this.pos = 0;
    this.bytes = 0;
    this.base = '新規';
    this.limitBytes = IS_IOS ? 220e6 : 600e6;
    this.maxSteps = 80;
  }
  push(cmd) {
    for (const c of this.list.splice(this.pos)) this.bytes -= c.bytes;
    this.list.push(cmd);
    this.pos++;
    this.bytes += cmd.bytes;
    while (this.list.length > 1 && (this.bytes > this.limitBytes || this.list.length > this.maxSteps)) {
      const c = this.list.shift();
      this.pos--;
      this.bytes -= c.bytes;
      this.base = c.label;
    }
    this.doc.emit('history');
  }
  get canUndo() { return this.pos > 0; }
  get canRedo() { return this.pos < this.list.length; }
  undo() {
    if (!this.canUndo) return null;
    const c = this.list[--this.pos];
    c.undo(this.doc);
    this.doc.emit('history');
    return c.label;
  }
  redo() {
    if (!this.canRedo) return null;
    const c = this.list[this.pos++];
    c.redo(this.doc);
    this.doc.emit('history');
    return c.label;
  }
  /** n 手目の後の状態へ（0 = 最初） */
  jump(n) {
    while (this.pos > n && this.canUndo) { this.list[--this.pos].undo(this.doc); }
    while (this.pos < n && this.canRedo) { this.list[this.pos++].redo(this.doc); }
    this.doc.emit('history');
  }
  clear(base) {
    this.list = []; this.pos = 0; this.bytes = 0; this.base = base || this.base;
    this.doc.emit('history');
  }
}

// ---- 文書 ------------------------------------------------------------------------
class Doc {
  constructor(w, h, { name = '名称未設定', workId = null, background = '#ffffff', empty = false } = {}) {
    this.width = w;
    this.height = h;
    this.name = name;
    this.workId = workId;
    this.layers = [];
    this.activeId = null;
    this.sel = null;                // null = 全体、{canvas, bounds}
    this.comp = newCanvas(w, h);
    this.compDirty = { x: 0, y: 0, w, h };
    this.live = null;               // ツールの描きかけ表示 {layer, canvas, update(rect)}
    this.history = new History(this);
    this.rev = 0;                   // 変更のたびに増える（自動保存・サムネイル用）
    this.listeners = {};
    this._backup = null;
    if (!empty) {             // empty = レイヤー無しで作る（読み込み用）
      const bg = new Layer(w, h, background ? '背景' : 'レイヤー 1');
      if (background) { bg.ctx.fillStyle = background; bg.ctx.fillRect(0, 0, w, h); }
      this.layers.push(bg);
      this.activeId = bg.id;
    }
  }
  // ---- イベント
  on(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, data) {
    if (type !== 'view') this.rev++;
    for (const fn of this.listeners[type] || []) fn(data);
    for (const fn of this.listeners['*'] || []) fn(type, data);
  }

  get active() { return this.layers.find((l) => l.id === this.activeId) || null; }
  get fullRect() { return { x: 0, y: 0, w: this.width, h: this.height }; }
  layerById(id) { return this.layers.find((l) => l.id === id) || null; }
  indexOf(layer) { return this.layers.indexOf(layer); }
  setActive(layer) {
    if (!layer || layer.id === this.activeId) return;
    this.activeId = layer.id;
    this.emit('layers');
  }

  // ---- 合成
  invalidate(rect, kind = 'pixels') {
    const r = rect ? Rect.clampTo(rect, this.width, this.height) : this.fullRect;
    if (r) this.compDirty = Rect.union(this.compDirty, r);
    this.emit(kind, r);
  }
  composite() {
    if (this.compDirty) {
      this.renderInto(this.comp, this.compDirty);
      this.compDirty = null;
    }
    return this.comp;
  }
  /** rect の範囲だけ合成して target に描く（target は文書と同じ大きさ） */
  renderInto(target, rect, { skipLive = false } = {}) {
    const g = target.getContext('2d');
    g.save();
    g.beginPath(); g.rect(rect.x, rect.y, rect.w, rect.h); g.clip();
    g.clearRect(rect.x, rect.y, rect.w, rect.h);
    for (const layer of this.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      let src = layer.canvas;
      if (!skipLive && this.live && this.live.layer === layer) { this.live.update(rect); src = this.live.canvas; }
      g.globalAlpha = layer.opacity;
      g.globalCompositeOperation = (BLEND[layer.blend] || BLEND.normal).gco;
      g.drawImage(src, rect.x, rect.y, rect.w, rect.h, rect.x, rect.y, rect.w, rect.h);
    }
    g.restore();
  }
  /** 合成結果の新しい canvas（書き出し・スポイト用） */
  flattened({ background = null } = {}) {
    const c = newCanvas(this.width, this.height);
    if (background) { const g = ctx2d(c); g.fillStyle = background; g.fillRect(0, 0, c.width, c.height); }
    const tmp = newCanvas(this.width, this.height);
    this.renderInto(tmp, this.fullRect, { skipLive: true });
    ctx2d(c).drawImage(tmp, 0, 0);
    return c;
  }

  // ---- 状態の写しと復元（構造の履歴）
  snapshot() {
    return {
      w: this.width, h: this.height, activeId: this.activeId, sel: this.sel,
      layers: this.layers.map((l) => ({ layer: l, canvas: l.canvas, props: l.props() })),
    };
  }
  restore(s) {
    const resized = s.w !== this.width || s.h !== this.height;
    this.width = s.w; this.height = s.h;
    this.layers = s.layers.map((e) => { e.layer.canvas = e.canvas; e.layer.setProps(e.props); return e.layer; });
    this.activeId = s.activeId;
    this.sel = s.sel;
    if (resized) { this.comp = newCanvas(s.w, s.h); this._backup = null; }
    this.compDirty = this.fullRect;
    this.emit('structure', { resized });
  }
  /** fn の前後を比べて1手の履歴にする（構造・属性・canvas の差し替え・選択範囲） */
  change(label, fn) {
    const before = this.snapshot();
    const ret = fn();
    const after = this.snapshot();
    if (sameSnapshot(before, after)) return ret;
    this.history.push(new StateCmd(label, before, after));
    const resized = before.w !== after.w || before.h !== after.h;
    if (resized) { this.comp = newCanvas(this.width, this.height); this._backup = null; }
    this.compDirty = this.fullRect;
    this.emit('structure', { resized });
    return ret;
  }

  // ---- 画素の履歴
  get backup() {
    if (!this._backup || this._backup.width !== this.width || this._backup.height !== this.height) {
      this._backup = newCanvas(this.width, this.height);
    }
    return this._backup;
  }
  /** 描き始め: 今のレイヤーを backup に写しておく */
  beginPixels(layer) {
    const g = ctx2d(this.backup);
    g.clearRect(0, 0, this.width, this.height);
    g.drawImage(layer.canvas, 0, 0);
    this._pending = layer;
  }
  /** 描き終わり: rect の範囲の前後を履歴に積む */
  endPixels(label, rect) {
    const layer = this._pending;
    this._pending = null;
    const r = Rect.clampTo(rect, this.width, this.height);
    if (!layer || !r) return;
    const before = ctx2d(this.backup).getImageData(r.x, r.y, r.w, r.h);
    const after = layer.ctx.getImageData(r.x, r.y, r.w, r.h);
    this.history.push(new PixelCmd(label, layer, r, before, after));
    this.invalidate(r, 'pixels');
  }
  /** 範囲が分かっている画素の書き換え */
  editPixels(label, layer, rect, fn) {
    const r = Rect.clampTo(rect, this.width, this.height);
    if (!r) return;
    const g = layer.ctx;
    const before = g.getImageData(r.x, r.y, r.w, r.h);
    g.save();
    fn(g);
    g.restore();
    const after = g.getImageData(r.x, r.y, r.w, r.h);
    this.history.push(new PixelCmd(label, layer, r, before, after));
    this.invalidate(r, 'pixels');
  }

  // ---- レイヤー操作（すべて1手の履歴）
  addLayer(name, { above = this.active, canvas = null } = {}) {
    return this.change('新規レイヤー', () => {
      const l = new Layer(this.width, this.height, name || this.nextLayerName(), canvas);
      const i = above ? this.indexOf(above) + 1 : this.layers.length;
      this.layers.splice(i, 0, l);
      this.activeId = l.id;
      return l;
    });
  }
  nextLayerName() {
    let n = this.layers.length + 1;
    const names = new Set(this.layers.map((l) => l.name));
    while (names.has('レイヤー ' + n)) n++;
    return 'レイヤー ' + n;
  }
  duplicateLayer(layer = this.active) {
    if (!layer) return null;
    return this.change('レイヤーを複製', () => {
      const l = new Layer(this.width, this.height, layer.name + ' のコピー', cloneCanvas(layer.canvas));
      l.setProps({ ...layer.props(), name: layer.name + ' のコピー', extra: { ...layer.extra } });
      this.layers.splice(this.indexOf(layer) + 1, 0, l);
      this.activeId = l.id;
      return l;
    });
  }
  deleteLayer(layer = this.active) {
    if (!layer || this.layers.length <= 1) return false;
    this.change('レイヤーを削除', () => {
      const i = this.indexOf(layer);
      this.layers.splice(i, 1);
      if (this.activeId === layer.id) this.activeId = this.layers[Math.max(0, i - 1)].id;
    });
    return true;
  }
  moveLayer(layer, toIndex) {
    const from = this.indexOf(layer);
    toIndex = clamp(toIndex, 0, this.layers.length - 1);
    if (from < 0 || from === toIndex) return;
    this.change('重ね順を変更', () => {
      this.layers.splice(from, 1);
      this.layers.splice(toIndex, 0, layer);
    });
  }
  setLayerProps(layer, props, label = 'レイヤーの設定') {
    this.change(label, () => layer.setProps(props));
  }
  /** 下のレイヤーと結合（新しい canvas を作る） */
  mergeDown(layer = this.active) {
    const i = this.indexOf(layer);
    if (i <= 0) return false;
    const below = this.layers[i - 1];
    this.change('下のレイヤーと結合', () => {
      const c = cloneCanvas(below.canvas);
      const g = ctx2d(c);
      if (layer.visible) {
        g.globalAlpha = layer.opacity;
        g.globalCompositeOperation = (BLEND[layer.blend] || BLEND.normal).gco;
        g.drawImage(layer.canvas, 0, 0);
      }
      below.canvas = c;
      this.layers.splice(i, 1);
      this.activeId = below.id;
    });
    return true;
  }
  /** 表示中のレイヤーをまとめて1枚に（画像を統合: 背景を白で埋める） */
  flatten({ visibleOnly = false } = {}) {
    const label = visibleOnly ? '表示レイヤーを結合' : '画像を統合';
    this.change(label, () => {
      const vis = this.layers.filter((l) => l.visible);
      if (!vis.length) return;
      const c = newCanvas(this.width, this.height);
      if (!visibleOnly) { const g = ctx2d(c); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); }
      const tmp = newCanvas(this.width, this.height);
      this.renderInto(tmp, this.fullRect, { skipLive: true });
      ctx2d(c).drawImage(tmp, 0, 0);
      const keep = visibleOnly ? vis[0] : this.layers[0];
      keep.canvas = c;
      keep.setProps({ opacity: 1, blend: 'normal', visible: true, name: visibleOnly ? keep.name : '背景', extra: {} });
      this.layers = visibleOnly ? this.layers.filter((l) => l === keep || !l.visible) : [keep];
      this.activeId = keep.id;
    });
  }

  // ---- 画像全体の操作（すべての canvas を作り直す）
  /** fn(srcCanvas) → 新しい canvas。レイヤーと選択範囲に同じ変換をかける */
  transformAll(label, newW, newH, draw, { keepSelection = true } = {}) {
    this.change(label, () => {
      const make = (src) => {
        const c = newCanvas(newW, newH);
        const g = ctx2d(c);
        g.imageSmoothingQuality = 'high';
        draw(g, src);
        return c;
      };
      for (const l of this.layers) l.canvas = make(l.canvas);
      this.sel = keepSelection && this.sel ? Sel.fromCanvas(make(this.sel.canvas)) : null;
      this.width = newW; this.height = newH;
    });
  }
  resizeImage(w, h) {
    const W = this.width, H = this.height;
    this.transformAll('画像解像度', w, h, (g, src) => g.drawImage(src, 0, 0, W, H, 0, 0, w, h));
  }
  resizeCanvas(w, h, ax = 0.5, ay = 0.5) {
    const dx = Math.round((w - this.width) * ax), dy = Math.round((h - this.height) * ay);
    this.transformAll('カンバスサイズ', w, h, (g, src) => g.drawImage(src, dx, dy));
  }
  crop(rect) {
    const r = Rect.clampTo(rect, this.width, this.height);
    if (!r) return;
    this.transformAll('切り抜き', r.w, r.h, (g, src) => g.drawImage(src, -r.x, -r.y));
  }
  rotate(deg) {
    const W = this.width, H = this.height;
    const swap = deg === 90 || deg === 270;
    const nw = swap ? H : W, nh = swap ? W : H;
    const label = deg === 180 ? '画像を 180° 回転' : deg === 90 ? '画像を 90° 回転（時計回り）' : '画像を 90° 回転（反時計回り）';
    this.transformAll(label, nw, nh, (g, src) => {
      g.translate(nw / 2, nh / 2);
      g.rotate((deg * Math.PI) / 180);
      g.drawImage(src, -W / 2, -H / 2);
    });
  }
  flip(horizontal) {
    const W = this.width, H = this.height;
    this.transformAll(horizontal ? '画像を左右反転' : '画像を上下反転', W, H, (g, src) => {
      if (horizontal) { g.translate(W, 0); g.scale(-1, 1); } else { g.translate(0, H); g.scale(1, -1); }
      g.drawImage(src, 0, 0);
    });
  }
  flipLayer(layer, horizontal) {
    const W = this.width, H = this.height;
    this.change(horizontal ? 'レイヤーを左右反転' : 'レイヤーを上下反転', () => {
      const c = newCanvas(W, H), g = ctx2d(c);
      if (horizontal) { g.translate(W, 0); g.scale(-1, 1); } else { g.translate(0, H); g.scale(1, -1); }
      g.drawImage(layer.canvas, 0, 0);
      layer.canvas = c;
    });
  }

  // ---- 選択範囲
  setSelection(sel, label = '選択範囲') {
    if (sel === this.sel) return;
    this.change(label, () => { this.sel = sel; });
  }
}

function sameSnapshot(a, b) {
  if (a.w !== b.w || a.h !== b.h || a.activeId !== b.activeId || a.sel !== b.sel || a.layers.length !== b.layers.length) return false;
  for (let i = 0; i < a.layers.length; i++) {
    const x = a.layers[i], y = b.layers[i];
    if (x.layer !== y.layer || x.canvas !== y.canvas) return false;
    for (const k of LAYER_PROPS) if (x.props[k] !== y.props[k]) return false;
    if (x.props.extra !== y.props.extra) return false;
  }
  return true;
}
