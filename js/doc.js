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
BLEND.pass_through = { label: '通過', gco: 'source-over', exact: true };       // グループだけが使う
// exe と同じ属性名（.sko の document.json の各レイヤーと同じ）
const LAYER_PROPS = ['name', 'visible', 'opacity', 'blend', 'alpha_locked', 'locked', 'mask_enabled', 'text',
  'adjustment', 'styles', 'clip', 'group', 'parent'];

let _nextLayerId = 1;
function bumpLayerId(n) { _nextLayerId = Math.max(_nextLayerId, n + 1); }

class Layer {
  /** kind: 'pixel'（既定）/ 'group' / 'adjustment'。グループ・調整レイヤーは画素を持たない（canvas = null） */
  constructor(w, h, name = 'レイヤー', canvas = null, { kind = 'pixel' } = {}) {
    this.id = _nextLayerId++;
    this.name = name;
    this.visible = true;
    this.opacity = 1;
    this.blend = kind === 'group' ? 'pass_through' : 'normal';
    this.alpha_locked = false;
    this.locked = false;
    this.mask_enabled = true;
    this.text = null;          // テキストの設定（exe core/text.py と同じ辞書）。辞書は差し替えて使う
    this.adjustment = null;    // 調整レイヤー {key, params}
    this.styles = null;        // レイヤースタイル {効果名: {...}}
    this.clip = false;         // クリッピングマスク（すぐ下のレイヤーの形で切り抜く）
    this.group = kind === 'group' ? { collapsed: false } : null;
    this.parent = null;        // 属するグループの id
    this.extra = {};           // Web 版で扱わない属性（.sko の往復で失わないよう持つ）
    this.canvas = kind === 'pixel' ? (canvas || newCanvas(w, h)) : null;
    this.mask = null;          // レイヤーマスク（白・アルファ = 見える度合い）
    this.ver = 0;              // 画素・マスクをその場で書き換えるたびに増える（サムネイル・自動保存の差分用）
  }
  get ctx() { return this.canvas.getContext('2d'); }
  get isGroup() { return !!this.group; }
  get isAdjustment() { return !!this.adjustment; }
  get isText() { return !!this.text; }
  get pixelless() { return !this.canvas; }
  get kind() { return this.isGroup ? 'group' : this.isAdjustment ? 'adjustment' : this.isText ? 'text' : 'pixel'; }
  hasStyles() { return !!this.styles && Object.values(this.styles).some((s) => s && s.enabled !== false); }
  displayMask() { return this.mask && this.mask_enabled !== false ? this.mask : null; }
  props() {
    const p = {};
    for (const k of LAYER_PROPS) p[k] = this[k];
    p.extra = this.extra;     // 辞書は差し替えて使う（中身を書き換えない）
    return p;
  }
  setProps(p) { for (const k of [...LAYER_PROPS, 'extra']) if (k in p) this[k] = p[k]; }
}

// ---- 履歴 ------------------------------------------------------------------------
class PixelCmd {
  /** attr: 'canvas'（画素）か 'mask' */
  constructor(label, layer, rect, before, after, attr = 'canvas') {
    Object.assign(this, { label, layer, attr, target: layer[attr], rect, before, after });
    this.bytes = rect.w * rect.h * 8 + 200;
    layer.ver++;
  }
  undo(doc) { this.target.getContext('2d').putImageData(this.before, this.rect.x, this.rect.y); this.layer.ver++; doc.invalidate(this.rect, 'pixels'); }
  redo(doc) { this.target.getContext('2d').putImageData(this.after, this.rect.x, this.rect.y); this.layer.ver++; doc.invalidate(this.rect, 'pixels'); }
}

class StateCmd {
  constructor(label, before, after) {
    Object.assign(this, { label, before, after });
    // 履歴だけが持っている canvas のおおよそのメモリ
    const live = new Set();
    for (const e of after.layers) { live.add(e.canvas); live.add(e.mask); }
    let bytes = 500;
    for (const e of before.layers) {
      for (const c of [e.canvas, e.mask]) if (c && !live.has(c)) bytes += c.width * c.height * 4;
    }
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
    this.layers = [];               // 下 → 上。グループの中身はグループ本体の真下に連続して並ぶ（exe・PSD と同じ）
    this.activeId = null;
    this.sel = null;                // null = 全体、{canvas, bounds}
    this.editingMask = false;       // true: 描く道具はレイヤーマスクに描く
    this.comp = newCanvas(w, h);
    this.compDirty = { x: 0, y: 0, w, h };
    this.live = null;               // ツールの描きかけ表示 {layer, canvas?, mask?, update(rect)}
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
    if (!layer.mask && !layer.isAdjustment) this.editingMask = false;
    this.emit('layers');
  }

  // ---- 木構造（グループ）
  parentOf(layer) { return layer && layer.parent != null ? this.layerById(layer.parent) : null; }
  isInside(layer, group) {
    for (let p = this.parentOf(layer); p; p = this.parentOf(p)) if (p === group) return true;
    return false;
  }
  depth(layer) { let d = 0; for (let p = this.parentOf(layer); p; p = this.parentOf(p)) d++; return d; }
  /** グループの中身（すべての子孫、下 → 上） */
  descendants(group) { return this.layers.filter((l) => this.isInside(l, group)); }
  /** レイヤーとその中身が並ぶ範囲 [始まり, 終わり]（グループでなければ自分だけ） */
  blockRange(layer) {
    const end = this.indexOf(layer);
    let start = end;
    if (layer.isGroup) while (start > 0 && this.isInside(this.layers[start - 1], layer)) start--;
    return [start, end];
  }
  block(layer) { const [s, e] = this.blockRange(layer); return this.layers.slice(s, e + 1); }
  /** 同じ階層の兄弟（下 → 上） */
  siblings(layer) { return this.layers.filter((l) => l.parent === layer.parent); }
  /** 木構造の決まり（グループの中身が真下に連続）を確かめる。テスト用 */
  checkTree() {
    for (const g of this.layers.filter((l) => l.isGroup)) {
      const [s, e] = this.blockRange(g);
      const inside = this.descendants(g);
      if (inside.length !== e - s) return `グループ ${g.name} の中身が連続していません`;
    }
    for (const l of this.layers) if (l.parent != null && !(this.layerById(l.parent) || {}).isGroup) return `${l.name} の親がグループではありません`;
    return null;
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
  /** rect の範囲だけ合成して target（文書と同じ大きさ）に描く。合成の中身は layerfx.js */
  renderInto(target, rect, { skipLive = false, layers = null } = {}) {
    compositeInto(this, target, rect, { skipLive, layers });
  }
  /** 合成結果の新しい canvas（書き出し・スポイト用） */
  flattened({ background = null, layers = null } = {}) {
    const c = newCanvas(this.width, this.height);
    if (background) { const g = ctx2d(c); g.fillStyle = background; g.fillRect(0, 0, c.width, c.height); }
    const tmp = newCanvas(this.width, this.height);
    this.renderInto(tmp, this.fullRect, { skipLive: true, layers });
    ctx2d(c).drawImage(tmp, 0, 0);
    return c;
  }

  // ---- 状態の写しと復元（構造の履歴）
  snapshot() {
    return {
      w: this.width, h: this.height, activeId: this.activeId, sel: this.sel,
      layers: this.layers.map((l) => ({ layer: l, canvas: l.canvas, mask: l.mask, props: l.props() })),
    };
  }
  restore(s) {
    const resized = s.w !== this.width || s.h !== this.height;
    this.width = s.w; this.height = s.h;
    this.layers = s.layers.map((e) => { e.layer.canvas = e.canvas; e.layer.mask = e.mask; e.layer.setProps(e.props); return e.layer; });
    this.activeId = s.activeId;
    this.sel = s.sel;
    const a = this.active;
    if (!a || (!a.mask && !a.isAdjustment)) this.editingMask = false;
    if (resized) { this.comp = newCanvas(s.w, s.h); this._backup = null; }
    this.compDirty = this.fullRect;
    this.emit('structure', { resized });
  }
  /** fn の前後を比べて1手の履歴にする（構造・属性・canvas の差し替え・選択範囲） */
  change(label, fn) {
    const before = this.snapshot();
    const ret = fn();
    this.commitFrom(label, before);
    return ret;
  }
  /** 写し before からの変更を1手にする（変更が無ければ何もしない） */
  commitFrom(label, before) {
    const after = this.snapshot();
    if (sameSnapshot(before, after)) return false;
    this.history.push(new StateCmd(label, before, after));
    const resized = before.w !== after.w || before.h !== after.h;
    if (resized) { this.comp = newCanvas(this.width, this.height); this._backup = null; }
    this.compDirty = this.fullRect;
    this.emit('structure', { resized });
    return true;
  }

  // ---- 画素の履歴（attr = 'canvas'（画素）か 'mask'）
  get backup() {
    if (!this._backup || this._backup.width !== this.width || this._backup.height !== this.height) {
      this._backup = newCanvas(this.width, this.height);
    }
    return this._backup;
  }
  /** 描き始め: 今の画素（かマスク）を backup に写しておく */
  beginPixels(layer, attr = 'canvas') {
    const g = ctx2d(this.backup);
    g.clearRect(0, 0, this.width, this.height);
    g.drawImage(layer[attr], 0, 0);
    this._pending = { layer, attr };
  }
  /** 描き終わり: rect の範囲の前後を履歴に積む */
  endPixels(label, rect) {
    const p = this._pending;
    this._pending = null;
    const r = Rect.clampTo(rect, this.width, this.height);
    if (!p || !r) return;
    const before = ctx2d(this.backup).getImageData(r.x, r.y, r.w, r.h);
    const after = ctx2d(p.layer[p.attr]).getImageData(r.x, r.y, r.w, r.h);
    this.history.push(new PixelCmd(label, p.layer, r, before, after, p.attr));
    this.invalidate(r, 'pixels');
  }
  /** 範囲が分かっている画素の書き換え */
  editPixels(label, layer, rect, fn, { attr = 'canvas' } = {}) {
    const r = Rect.clampTo(rect, this.width, this.height);
    if (!r) return;
    const g = ctx2d(layer[attr]);
    const before = g.getImageData(r.x, r.y, r.w, r.h);
    g.save();
    fn(g);
    g.restore();
    const after = g.getImageData(r.x, r.y, r.w, r.h);
    this.history.push(new PixelCmd(label, layer, r, before, after, attr));
    this.invalidate(r, 'pixels');
  }

  // ---- レイヤー操作（すべて1手の履歴）
  /** 新しいレイヤーの入る場所: 選択中がグループならその中の一番上、そうでなければ選択中の真上（同じ親） */
  insertAbove(layer, anchor = this.active) {
    if (!anchor) { this.layers.push(layer); return; }
    if (anchor.isGroup) { layer.parent = anchor.id; this.layers.splice(this.indexOf(anchor), 0, layer); return; }
    layer.parent = anchor.parent;
    this.layers.splice(this.indexOf(anchor) + 1, 0, layer);
  }
  addLayer(name, { anchor = this.active, canvas = null, label = '新規レイヤー', setup = null } = {}) {
    return this.change(label, () => {
      const l = new Layer(this.width, this.height, name || this.nextLayerName(), canvas);
      if (setup) setup(l);
      this.insertAbove(l, anchor);
      this.activeId = l.id;
      return l;
    });
  }
  nextLayerName(prefix = 'レイヤー') {
    let n = this.layers.length + 1;
    const names = new Set(this.layers.map((l) => l.name));
    while (names.has(prefix + ' ' + n)) n++;
    return prefix + ' ' + n;
  }
  /** レイヤー（グループなら中身ごと）の写し。id は振り直し、親子関係も写しの中で付け直す */
  cloneBlock(layer) {
    const src = this.block(layer);
    const map = new Map();
    const out = src.map((l) => {
      const c = new Layer(this.width, this.height, l.name, l.canvas ? cloneCanvas(l.canvas) : null);
      c.setProps(l.props());
      if (l.mask) c.mask = cloneCanvas(l.mask);
      map.set(l.id, c.id);
      return c;
    });
    for (const c of out) if (map.has(c.parent)) c.parent = map.get(c.parent);
    return out;
  }
  duplicateLayer(layer = this.active) {
    if (!layer) return null;
    return this.change('レイヤーを複製', () => {
      const copies = this.cloneBlock(layer);
      const top = copies[copies.length - 1];
      top.name = layer.name + ' のコピー';
      const [, e] = this.blockRange(layer);
      this.layers.splice(e + 1, 0, ...copies);
      this.activeId = top.id;
      return top;
    });
  }
  deleteLayer(layer = this.active) {
    if (!layer) return false;
    const [s, e] = this.blockRange(layer);
    if (this.layers.length - (e - s + 1) < 1) return false;
    this.change('レイヤーを削除', () => {
      this.layers.splice(s, e - s + 1);
      const next = this.layers[Math.min(this.layers.length - 1, Math.max(0, s - 1))];
      if (!this.layerById(this.activeId)) this.activeId = next.id;
    });
    return true;
  }
  /** ブロックを取り出して、anchor の上・下・グループの中（一番上）に入れる */
  placeLayer(layer, anchor, where, label = '重ね順を変更') {
    if (!anchor || anchor === layer || this.isInside(anchor, layer)) return false;
    return this.change(label, () => {
      const [s, e] = this.blockRange(layer);
      const blk = this.layers.splice(s, e - s + 1);
      if (where === 'into') {
        layer.parent = anchor.id;
        this.layers.splice(this.indexOf(anchor), 0, ...blk);
      } else if (where === 'above') {
        layer.parent = anchor.parent;
        this.layers.splice(this.indexOf(anchor) + 1, 0, ...blk);
      } else {
        layer.parent = anchor.parent;
        const [as] = this.blockRange(anchor);
        this.layers.splice(as, 0, ...blk);
      }
      if (layer.clip && this.indexOf(layer) === this.blockRange(layer)[0] && this.isBottomOfParent(layer)) layer.clip = false;
    });
  }
  isBottomOfParent(layer) { const sib = this.siblings(layer); return sib[0] === layer; }
  /** 同じ階層の中で1つ上・下へ。端ならグループの外へ出る（exe と同じ） */
  moveLayer(layer, dir) {
    const sib = this.siblings(layer);
    const i = sib.indexOf(layer);
    const parent = this.parentOf(layer);
    if (dir === 'up') {
      if (i < sib.length - 1) return this.placeLayer(layer, sib[i + 1], 'above');
      if (parent) return this.placeLayer(layer, parent, 'above');
    } else if (dir === 'down') {
      if (i > 0) {
        const below = sib[i - 1];
        if (below.isGroup && !(below.group && below.group.collapsed)) return this.placeLayer(layer, below, 'into');
        return this.placeLayer(layer, below, 'below');
      }
      if (parent) return this.placeLayer(layer, parent, 'below');
    } else if (dir === 'top') {
      if (i < sib.length - 1) return this.placeLayer(layer, sib[sib.length - 1], 'above');
    } else if (dir === 'bottom') {
      if (i > 0) return this.placeLayer(layer, sib[0], 'below');
    }
    return false;
  }
  setLayerProps(layer, props, label = 'レイヤーの設定') {
    this.change(label, () => layer.setProps(props));
  }
  /** 下のレイヤーと結合（マスク・スタイル・不透明度・調整を焼き込む） */
  mergeDown(layer = this.active) {
    const sib = this.siblings(layer);
    const i = sib.indexOf(layer);
    if (i <= 0) return '下にレイヤーがありません';
    const below = sib[i - 1];
    if (below.isGroup || below.isAdjustment || layer.isGroup) return 'グループ・調整レイヤーの下とは結合できません（グループは「グループを結合」）';
    this.change('下のレイヤーと結合', () => {
      const lo = Object.assign(Object.create(Object.getPrototypeOf(below)), below, { blend: 'normal', clip: false, parent: null });
      const up = Object.assign(Object.create(Object.getPrototypeOf(layer)), layer, { parent: null, clip: layer.clip });
      const c = this.flattened({ layers: [lo, up] });
      below.canvas = c;
      below.setProps({ opacity: 1, mask_enabled: true, text: null, styles: null });
      below.mask = null;
      this.layers.splice(this.indexOf(layer), 1);
      this.activeId = below.id;
    });
    return null;
  }
  /** グループを1枚のレイヤーに */
  mergeGroup(group) {
    if (!group || !group.isGroup) return;
    this.change('グループを結合', () => {
      const inside = this.descendants(group).map((l) => Object.assign(Object.create(Object.getPrototypeOf(l)), l));
      const g2 = Object.assign(Object.create(Object.getPrototypeOf(group)), group, { parent: null, clip: false, opacity: 1, blend: 'normal' });
      g2.mask = null;
      const c = this.flattened({ layers: [g2, ...inside] });
      const [s, e] = this.blockRange(group);
      this.layers.splice(s, e - s);
      group.canvas = c;
      group.group = null;
      group.blend = group.blend === 'pass_through' ? 'normal' : group.blend;
      this.activeId = group.id;
    });
  }
  /** 表示中のレイヤーをまとめて1枚に（画像を統合: 背景を白で埋める） */
  flatten({ visibleOnly = false } = {}) {
    const label = visibleOnly ? '表示レイヤーを結合' : '画像を統合';
    this.change(label, () => {
      const c = this.flattened({ background: visibleOnly ? null : '#ffffff' });
      const keep = new Layer(this.width, this.height, visibleOnly ? '結合' : '背景', c);
      this.layers = visibleOnly ? [...this.layers.filter((l) => !l.visible && l.parent == null && !l.isGroup), keep] : [keep];
      this.activeId = keep.id;
    });
  }
  /** グループにまとめる（選択中のレイヤー＝ブロックをグループへ） */
  groupLayer(layer = this.active) {
    if (!layer) return null;
    return this.change('グループ化', () => {
      const g = new Layer(this.width, this.height, this.nextLayerName('グループ'), null, { kind: 'group' });
      const [, e] = this.blockRange(layer);
      g.parent = layer.parent;
      this.layers.splice(e + 1, 0, g);
      layer.parent = g.id;
      this.activeId = g.id;
      return g;
    });
  }
  newGroup() {
    return this.change('新規グループ', () => {
      const g = new Layer(this.width, this.height, this.nextLayerName('グループ'), null, { kind: 'group' });
      this.insertAbove(g, this.active);
      this.activeId = g.id;
      return g;
    });
  }
  ungroup(group) {
    if (!group || !group.isGroup) return;
    this.change('グループ解除', () => {
      for (const l of this.layers) if (l.parent === group.id) l.parent = group.parent;
      const i = this.indexOf(group);
      this.layers.splice(i, 1);
      const top = this.layers[i - 1];
      this.activeId = top ? top.id : this.layers[this.layers.length - 1].id;
    });
  }

  // ---- 画像全体の操作（すべての canvas を作り直す）
  /** M = 古い座標 → 新しい座標（[a,b,c,d,e,f]）。画素・マスク・選択範囲に同じ変換、テキストは行列を変えて描き直す */
  transformAll(label, newW, newH, M, { keepSelection = true, smooth = true } = {}) {
    this.change(label, () => {
      const make = (src, fillWhite = false) => {
        const c = newCanvas(newW, newH);
        const g = ctx2d(c);
        if (fillWhite) { g.fillStyle = '#fff'; g.fillRect(0, 0, newW, newH); g.clearRect(...matRectOnto(M, src.width, src.height)); }
        g.imageSmoothingEnabled = smooth;
        g.imageSmoothingQuality = 'high';
        g.setTransform(...M);
        g.drawImage(src, 0, 0);
        return c;
      };
      for (const l of this.layers) {
        if (l.isText) {
          l.text = { ...l.text, matrix: matMul(M, l.text.matrix || [1, 0, 0, 1, 0, 0]) };
          l.canvas = renderTextSpec(l.text, newW, newH);
        } else if (l.canvas) l.canvas = make(l.canvas);
        if (l.mask) l.mask = make(l.mask, true);
      }
      this.sel = keepSelection && this.sel ? Sel.fromCanvas(make(this.sel.canvas)) : null;
      this.width = newW; this.height = newH;
    });
  }
  resizeImage(w, h) { this.transformAll('画像解像度', w, h, [w / this.width, 0, 0, h / this.height, 0, 0]); }
  resizeCanvas(w, h, ax = 0.5, ay = 0.5) {
    const dx = Math.round((w - this.width) * ax), dy = Math.round((h - this.height) * ay);
    this.transformAll('カンバスサイズ', w, h, [1, 0, 0, 1, dx, dy], { smooth: false });
  }
  crop(rect) {
    const r = Rect.clampTo(rect, this.width, this.height);
    if (!r) return;
    this.transformAll('切り抜き', r.w, r.h, [1, 0, 0, 1, -r.x, -r.y], { smooth: false });
  }
  rotate(deg) {
    const W = this.width, H = this.height;
    const swap = deg === 90 || deg === 270;
    const nw = swap ? H : W, nh = swap ? W : H;
    const label = deg === 180 ? '画像を 180° 回転' : deg === 90 ? '画像を 90° 回転（時計回り）' : '画像を 90° 回転（反時計回り）';
    const a = (deg * Math.PI) / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
    // 中心を合わせて回す: x' = c·(x−W/2) − s·(y−H/2) + nw/2
    this.transformAll(label, nw, nh, [c, s, -s, c, nw / 2 - c * W / 2 + s * H / 2, nh / 2 - s * W / 2 - c * H / 2], { smooth: false });
  }
  flip(horizontal) {
    const W = this.width, H = this.height;
    this.transformAll(horizontal ? '画像を左右反転' : '画像を上下反転', W, H, horizontal ? [-1, 0, 0, 1, W, 0] : [1, 0, 0, -1, 0, H], { smooth: false });
  }
  flipLayer(layer, horizontal) {
    const W = this.width, H = this.height;
    const M = horizontal ? [-1, 0, 0, 1, W, 0] : [1, 0, 0, -1, 0, H];
    this.change(horizontal ? 'レイヤーを左右反転' : 'レイヤーを上下反転', () => {
      for (const l of this.block(layer)) {
        if (l.isText) { l.text = { ...l.text, matrix: matMul(M, l.text.matrix) }; l.canvas = renderTextSpec(l.text, W, H); }
        else if (l.canvas) { const c = newCanvas(W, H), g = ctx2d(c); g.setTransform(...M); g.drawImage(l.canvas, 0, 0); l.canvas = c; }
        if (l.mask) { const c = newCanvas(W, H), g = ctx2d(c); g.setTransform(...M); g.drawImage(l.mask, 0, 0); l.mask = c; }
      }
    });
  }

  // ---- マスク
  addMask(layer, { fromSelection = false, hide = false } = {}) {
    if (!layer || layer.mask) return;
    this.change(fromSelection ? 'マスクを追加（選択範囲）' : 'マスクを追加', () => {
      const m = newCanvas(this.width, this.height), g = ctx2d(m);
      if (fromSelection && this.sel) g.drawImage(this.sel.canvas, 0, 0);
      else if (!hide) { g.fillStyle = '#fff'; g.fillRect(0, 0, this.width, this.height); }
      layer.mask = m;
      layer.mask_enabled = true;
      this.editingMask = true;
    });
  }
  deleteMask(layer, apply = false) {
    if (!layer || !layer.mask) return;
    this.change(apply ? 'マスクを適用' : 'マスクを削除', () => {
      if (apply && layer.canvas && !layer.isText) {
        const c = cloneCanvas(layer.canvas), g = ctx2d(c);
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(layer.mask, 0, 0);
        layer.canvas = c;
      }
      layer.mask = null;
      this.editingMask = false;
    });
  }

  // ---- 選択範囲
  setSelection(sel, label = '選択範囲') {
    if (sel === this.sel) return;
    this.change(label, () => { this.sel = sel; });
  }
}

/** 行列 [a,b,c,d,e,f] の積（A∘B: 先に B、次に A） */
function matMul(A, B) {
  return [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
}
function matApply(M, x, y) { return { x: M[0] * x + M[2] * y + M[4], y: M[1] * x + M[3] * y + M[5] }; }
/** 変換後の元の範囲（w×h）を囲む矩形（clearRect 用） */
function matRectOnto(M, w, h) {
  const ps = [matApply(M, 0, 0), matApply(M, w, 0), matApply(M, 0, h), matApply(M, w, h)];
  const x0 = Math.min(...ps.map((p) => p.x)), y0 = Math.min(...ps.map((p) => p.y));
  return [x0, y0, Math.max(...ps.map((p) => p.x)) - x0, Math.max(...ps.map((p) => p.y)) - y0];
}

function sameSnapshot(a, b) {
  if (a.w !== b.w || a.h !== b.h || a.activeId !== b.activeId || a.sel !== b.sel || a.layers.length !== b.layers.length) return false;
  for (let i = 0; i < a.layers.length; i++) {
    const x = a.layers[i], y = b.layers[i];
    if (x.layer !== y.layer || x.canvas !== y.canvas || x.mask !== y.mask) return false;
    for (const k of [...LAYER_PROPS, 'extra']) if (x.props[k] !== y.props[k]) return false;
  }
  return true;
}
