'use strict';
/* 自由変形（拡大縮小・回転・遠近）と切り抜きツール。
   どちらも「選んでいる間だけ有効な状態」を持つ。activate / deactivate は app.selectTool から呼ばれる。 */

// ---- 幾何 ------------------------------------------------------------------------
const quadCopy = (q) => q.map((p) => ({ x: p.x, y: p.y }));
function isParallelogram(q) {
  return Math.abs(q[0].x + q[2].x - q[1].x - q[3].x) < 0.01 && Math.abs(q[0].y + q[2].y - q[1].y - q[3].y) < 0.01;
}
/** 単位正方形 (0,0)(1,0)(1,1)(0,1) → 四角形 q[0..3] の射影変換（Heckbert） */
function squareToQuad(q) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) > 1e-12) { g = (dx3 * dy2 - dx2 * dy3) / den; h = (dx1 * dy3 - dx3 * dy1) / den; }
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x, c = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y, f = p0.y;
  return (u, v) => { const w = g * u + h * v + 1; return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w }; };
}
/** 3点 → 3点のアフィン（canvas の transform の6つの値） */
function affine3(s0, s1, s2, d0, d1, d2) {
  const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(den) < 1e-12) return null;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
  const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
  return [a, b, c, d, d0.x - a * s0.x - c * s0.y, d0.y - b * s0.x - d * s0.y];
}
/** img（大きさ iw×ih）を四角形 q に描く。平行四辺形なら1回、そうでなければ n×n の三角形に分けて近似 */
function drawQuad(g, img, q, n = 12) {
  const iw = img.width, ih = img.height;
  g.save();
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (isParallelogram(q)) {
    g.transform((q[1].x - q[0].x) / iw, (q[1].y - q[0].y) / iw, (q[3].x - q[0].x) / ih, (q[3].y - q[0].y) / ih, q[0].x, q[0].y);
    g.drawImage(img, 0, 0);
    g.restore();
    return;
  }
  g.restore();
  const map = squareToQuad(q);
  const P = [];
  for (let j = 0; j <= n; j++) { P.push([]); for (let i = 0; i <= n; i++) P[j].push(map(i / n, j / n)); }
  const tri = (s0, s1, s2, d0, d1, d2) => {
    const m = affine3(s0, s1, s2, d0, d1, d2);
    if (!m) return;
    // 隙間が出ないよう、描く三角形を重心から少し外へ広げる
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
    const grow = (p) => { const dx = p.x - cx, dy = p.y - cy, l = Math.hypot(dx, dy) || 1; return { x: p.x + dx / l * 0.7, y: p.y + dy / l * 0.7 }; };
    const e0 = grow(d0), e1 = grow(d1), e2 = grow(d2);
    const sx = Math.max(0, Math.floor(Math.min(s0.x, s1.x, s2.x)) - 2), sy = Math.max(0, Math.floor(Math.min(s0.y, s1.y, s2.y)) - 2);
    const ex = Math.min(iw, Math.ceil(Math.max(s0.x, s1.x, s2.x)) + 2), ey = Math.min(ih, Math.ceil(Math.max(s0.y, s1.y, s2.y)) + 2);
    if (ex <= sx || ey <= sy) return;
    g.save();
    g.beginPath(); g.moveTo(e0.x, e0.y); g.lineTo(e1.x, e1.y); g.lineTo(e2.x, e2.y); g.closePath(); g.clip();
    g.transform(...m);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
    g.restore();
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const s00 = { x: i / n * iw, y: j / n * ih }, s10 = { x: (i + 1) / n * iw, y: j / n * ih };
      const s01 = { x: i / n * iw, y: (j + 1) / n * ih }, s11 = { x: (i + 1) / n * iw, y: (j + 1) / n * ih };
      tri(s00, s10, s11, P[j][i], P[j][i + 1], P[j + 1][i + 1]);
      tri(s00, s11, s01, P[j][i], P[j + 1][i + 1], P[j + 1][i]);
    }
  }
}
function pointInQuad(p, q) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    if ((q[i].y > p.y) !== (q[j].y > p.y) && p.x < (q[j].x - q[i].x) * (p.y - q[i].y) / (q[j].y - q[i].y) + q[i].x) inside = !inside;
  }
  return inside;
}
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** 角・辺の取っ手（画面座標で当たり判定）。0..3 = 角、4..7 = 辺（i と i+1 の間） */
function handlePoints(q) {
  return [...q, mid(q[0], q[1]), mid(q[1], q[2]), mid(q[2], q[3]), mid(q[3], q[0])];
}
function hitHandle(view, q, p, radius = 22) {
  const s = view.toScreen(p.x, p.y);
  const hs = handlePoints(q);
  let best = -1, bd = radius;
  hs.forEach((h, i) => { const t = view.toScreen(h.x, h.y); const dd = Math.hypot(t.x - s.x, t.y - s.y); if (dd < bd) { bd = dd; best = i; } });
  return best;
}
function drawHandles(g, view, q, { center = true } = {}) {
  const pts = q.map((p) => view.toScreen(p.x, p.y));
  g.lineWidth = 1;
  for (const [c, w] of [['rgba(0,0,0,.7)', 3], ['#ffffff', 1.2]]) {
    g.strokeStyle = c; g.lineWidth = w;
    g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.stroke();
  }
  for (const h of handlePoints(q)) {
    const s = view.toScreen(h.x, h.y);
    g.fillStyle = '#fff'; g.strokeStyle = '#2f6be0'; g.lineWidth = 2;
    g.fillRect(s.x - 6, s.y - 6, 12, 12); g.strokeRect(s.x - 6, s.y - 6, 12, 12);
  }
  if (center) {
    const c = view.toScreen((q[0].x + q[2].x) / 2, (q[0].y + q[2].y) / 2);
    g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(c.x, c.y, 5, 0, Math.PI * 2); g.stroke();
  }
}

// ---- 自由変形 --------------------------------------------------------------------
class TransformTool extends Tool {
  constructor(app) { super(app, 'transform', '自由変形', { mode: 'scale', keep: true }); this.state = null; }
  needsLayer() { return 'move'; }
  optChanged(key) {
    if (key === 'mode' && this.state && this.state.text && this.opts.mode === 'distort') {
      this.setOpt('mode', 'scale');
      toast('テキストは「拡大・回転」だけです（遠近にするときはラスタライズしてから）');
    }
  }
  spec() {
    const info = this.state ? this.infoText() : '';
    return [
      { key: 'mode', type: 'seg', items: [['scale', '拡大・回転'], ['distort', '自由な形（遠近）']] },
      { key: 'keep', label: '縦横比を固定', type: 'check' },
      { type: 'note', text: info },
      { type: 'buttons', items: [['⇆ 左右反転', () => this.flip(true)], ['⇅ 上下反転', () => this.flip(false)],
        ['✕ キャンセル', () => this.cancelAll()], ['✓ 確定', () => this.commit(), 'primary']] },
    ];
  }
  infoText() {
    const q = this.state.quad, b = this.state.bounds;
    const w = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), h = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
    const ang = Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) * 180 / Math.PI;
    return `幅 ${Math.round(w / b.w * 100)}%・高さ ${Math.round(h / b.h * 100)}%・角度 ${ang.toFixed(1)}°`;
  }
  /** ツールを選んだら変形を始める。始められなければ false */
  activate() {
    const d = this.doc;
    if (!d) return false;
    const why = this.app.cannotEdit(this);
    if (why) { toast(why, { error: true }); return false; }
    const layer = d.active;
    const W = d.width, H = d.height;
    // 何を変形するか: マスク編集中ならマスクだけ。テキストは全体（行列を変える）。それ以外は画素（選択範囲があればその中）
    const attr = d.editingMask && layer.mask ? 'mask' : 'canvas';
    const text = attr === 'canvas' && layer.isText;
    const sel = text ? null : d.sel;
    if (text && this.opts.mode === 'distort') this.setOpt('mode', 'scale');
    const float = cloneCanvas(layer[attr]), base = newCanvas(W, H);
    let selSrc = null;
    if (sel) {
      const fg = ctx2d(float); fg.globalCompositeOperation = 'destination-in'; fg.drawImage(sel.canvas, 0, 0);
      const bg = ctx2d(base); bg.drawImage(layer[attr], 0, 0); bg.globalCompositeOperation = 'destination-out'; bg.drawImage(sel.canvas, 0, 0);
    }
    const b = alphaBounds(float);
    if (!b) { toast(sel ? '選択範囲の中に何も描かれていません' : attr === 'mask' ? 'マスクが空です' : 'このレイヤーは空です'); return false; }
    const src = newCanvas(b.w, b.h);
    ctx2d(src).drawImage(float, -b.x, -b.y);
    if (sel) { selSrc = newCanvas(b.w, b.h); ctx2d(selSrc).drawImage(sel.canvas, -b.x, -b.y); }
    const quad = [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }];
    // 画素と一緒にマスクも動かす（選択範囲が無く、マスク編集中でないとき）
    const withMask = attr === 'canvas' && !!layer.mask && !sel;
    this.state = { layer, attr, text, withMask, base, src, selSrc, bounds: b, quad, start: quadCopy(quad) };
    this.hideAnts = true;
    this.liveC = this.app.scratch('live');
    d.live = { layer, update: (r) => this.renderLive(r) };
    d.live[attr] = this.liveC;
    if (withMask) { this.liveM = this.app.scratch('liveMask'); d.live.mask = this.liveM; }
    d.invalidate(null, 'live');
    return true;
  }
  deactivate() { if (this.state) this.commit({ keepTool: true }); }
  renderLive(r) {
    const g = ctx2d(this.liveC), s = this.state;
    g.save();
    g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
    g.clearRect(r.x, r.y, r.w, r.h);
    g.drawImage(s.base, 0, 0);
    drawQuad(g, s.src, s.quad, 8);
    g.restore();
    if (s.withMask) {
      const m = ctx2d(this.liveM);
      m.save(); m.beginPath(); m.rect(r.x, r.y, r.w, r.h); m.clip();
      this.drawMaskTransformed(m, s, 8);
      m.restore();
    }
  }
  /** 変形前の範囲 → 変形後の四角形 を、マスク全体にかける（空いた所は「見える」） */
  drawMaskTransformed(g, s, n) {
    const d = this.doc, b = s.bounds;
    g.save();
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#fff'; g.fillRect(0, 0, d.width, d.height);
    if (isParallelogram(s.quad)) {
      const M = affine3({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x, y: b.y + b.h }, s.quad[0], s.quad[1], s.quad[3]);
      const corners = [[0, 0], [d.width, 0], [d.width, d.height], [0, d.height]].map(([x, y]) => matApply(M, x, y));
      g.beginPath(); corners.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath();
      g.save(); g.clip(); g.clearRect(0, 0, d.width, d.height); g.restore();
      g.setTransform(...M);
      g.drawImage(s.layer.mask, 0, 0);
    } else {
      const part = newCanvas(b.w, b.h);
      ctx2d(part).drawImage(s.layer.mask, -b.x, -b.y);
      g.globalCompositeOperation = 'destination-out';
      g.beginPath(); s.quad.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.fill();
      g.globalCompositeOperation = 'source-over';
      drawQuad(g, part, s.quad, n);
    }
    g.restore();
  }
  changed() {
    this.doc.invalidate(null, 'live');
    const note = $('#optbar .opt:not(label)');
    if (note) note.textContent = this.infoText();
  }
  down(p) {
    const s = this.state;
    if (!s) return;
    const h = hitHandle(this.view, s.quad, p);
    let kind;
    if (h >= 0) kind = h < 4 ? 'corner' : 'edge';
    else if (pointInQuad(p, s.quad)) kind = 'move';
    else kind = this.opts.mode === 'scale' ? 'rotate' : 'move';
    this.drag = { kind, h, p0: p, q0: quadCopy(s.quad) };
  }
  move(p) {
    const s = this.state, dr = this.drag;
    if (!s || !dr) return;
    const q0 = dr.q0;
    const dx = p.x - dr.p0.x, dy = p.y - dr.p0.y;
    if (dr.kind === 'move') {
      s.quad = q0.map((c) => ({ x: c.x + dx, y: c.y + dy }));
    } else if (dr.kind === 'rotate') {
      const c = { x: (q0[0].x + q0[1].x + q0[2].x + q0[3].x) / 4, y: (q0[0].y + q0[1].y + q0[2].y + q0[3].y) / 4 };
      let a = Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(dr.p0.y - c.y, dr.p0.x - c.x);
      if (p.shift) {
        const base = Math.atan2(q0[1].y - q0[0].y, q0[1].x - q0[0].x);
        const step = Math.PI / 12;
        a = Math.round((base + a) / step) * step - base;
      }
      const cs = Math.cos(a), sn = Math.sin(a);
      s.quad = q0.map((v) => ({ x: c.x + (v.x - c.x) * cs - (v.y - c.y) * sn, y: c.y + (v.x - c.x) * sn + (v.y - c.y) * cs }));
    } else if (this.opts.mode === 'distort') {
      s.quad = quadCopy(q0);
      if (dr.kind === 'corner') s.quad[dr.h] = { x: q0[dr.h].x + dx, y: q0[dr.h].y + dy };
      else { const i = dr.h - 4, j = (i + 1) % 4; s.quad[i] = { x: q0[i].x + dx, y: q0[i].y + dy }; s.quad[j] = { x: q0[j].x + dx, y: q0[j].y + dy }; }
    } else {
      // 拡大縮小: 四角形の向き（上の辺）に沿った座標で、反対側を基準に伸ばす
      const ang = Math.atan2(q0[1].y - q0[0].y, q0[1].x - q0[0].x);
      const u = { x: Math.cos(ang), y: Math.sin(ang) }, v = { x: -u.y, y: u.x };
      const toL = (pt, o) => ({ x: (pt.x - o.x) * u.x + (pt.y - o.y) * u.y, y: (pt.x - o.x) * v.x + (pt.y - o.y) * v.y });
      const center = { x: (q0[0].x + q0[2].x) / 2, y: (q0[0].y + q0[2].y) / 2 };
      let sx = 1, sy = 1, anchor;
      if (dr.kind === 'corner') {
        anchor = p.alt ? center : q0[(dr.h + 2) % 4];
        const cl = toL(q0[dr.h], anchor), pl = toL(p, anchor);
        const keep = this.opts.keep !== !!p.shift;
        if (keep) {
          const k = (pl.x * cl.x + pl.y * cl.y) / Math.max(1e-6, cl.x * cl.x + cl.y * cl.y);
          sx = sy = k;
        } else {
          sx = Math.abs(cl.x) > 1e-6 ? pl.x / cl.x : 1;
          sy = Math.abs(cl.y) > 1e-6 ? pl.y / cl.y : 1;
        }
      } else {
        const i = dr.h - 4;
        const m0 = mid(q0[i], q0[(i + 1) % 4]);
        anchor = p.alt ? center : mid(q0[(i + 2) % 4], q0[(i + 3) % 4]);
        const cl = toL(m0, anchor), pl = toL(p, anchor);
        if (i % 2 === 0) sy = Math.abs(cl.y) > 1e-6 ? pl.y / cl.y : 1;      // 上・下の辺
        else sx = Math.abs(cl.x) > 1e-6 ? pl.x / cl.x : 1;                  // 右・左の辺
        if (this.opts.keep !== !!p.shift) { if (i % 2 === 0) sx = Math.abs(sy); else sy = Math.abs(sx); }
      }
      s.quad = q0.map((c) => {
        const l = toL(c, anchor);
        const X = l.x * sx, Y = l.y * sy;
        return { x: anchor.x + X * u.x + Y * v.x, y: anchor.y + X * u.y + Y * v.y };
      });
    }
    this.changed();
  }
  up() { this.drag = null; }
  cancel() { this.drag = null; }
  flip(horizontal) {
    const s = this.state;
    if (!s) return;
    const q = s.quad;
    s.quad = horizontal ? [q[1], q[0], q[3], q[2]] : [q[3], q[2], q[1], q[0]];
    this.changed();
  }
  commit({ keepTool = false } = {}) {
    const s = this.state, d = this.doc;
    if (!s) return;
    this.state = null; this.drag = null; this.hideAnts = false; this.liveM = null;
    d.live = null;
    const same = s.quad.every((p, i) => Math.abs(p.x - s.start[i].x) < 1e-6 && Math.abs(p.y - s.start[i].y) < 1e-6);
    if (!same) {
      d.change(s.attr === 'mask' ? '自由変形（マスク）' : '自由変形', () => {
        const b = s.bounds;
        if (s.text) {            // テキスト: 行列を変えて描き直す（ぼやけない・あとで文字を直せる）
          const M = affine3({ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x, y: b.y + b.h }, s.quad[0], s.quad[1], s.quad[3]);
          s.layer.text = { ...s.layer.text, matrix: matMul(M, s.layer.text.matrix) };
          s.layer.canvas = renderTextSpec(s.layer.text, d.width, d.height);
        } else {
          const c = cloneCanvas(s.base);
          drawQuad(ctx2d(c), s.src, s.quad, 24);
          s.layer[s.attr] = c;
        }
        if (s.withMask) {
          const m = newCanvas(d.width, d.height);
          this.drawMaskTransformed(ctx2d(m), s, 24);
          s.layer.mask = m;
        }
        if (s.selSrc) {
          const sc = newCanvas(d.width, d.height);
          drawQuad(ctx2d(sc), s.selSrc, s.quad, 24);
          d.sel = Sel.fromCanvas(sc);
        }
      });
    } else d.invalidate(null, 'live');
    if (!keepTool) this.app.selectTool(this.app.prevTool || 'move');
  }
  cancelAll() {
    if (!this.state) return;
    this.state = null; this.drag = null; this.hideAnts = false; this.liveM = null;
    this.doc.live = null;
    this.doc.invalidate(null, 'live');
    this.app.selectTool(this.app.prevTool || 'move');
  }
  drawOverlay(g, view) { if (this.state) drawHandles(g, view, this.state.quad); }
}

// ---- 切り抜き --------------------------------------------------------------------
const CROP_RATIOS = [['free', '自由'], ['orig', '元の比率'], ['1:1', '1:1'], ['4:3', '4:3'], ['3:4', '3:4'], ['16:9', '16:9'], ['9:16', '9:16'], ['3:2', '3:2'], ['2:3', '2:3']];
class CropTool extends Tool {
  constructor(app) { super(app, 'crop', '切り抜き', { ratio: 'free' }); this.rect = null; }
  needsLayer() { return false; }
  spec() {
    return [
      { key: 'ratio', type: 'select', label: '比率', items: CROP_RATIOS },
      { type: 'note', text: this.rect ? `${Math.round(this.rect.w)} × ${Math.round(this.rect.h)} px` : '' },
      { type: 'buttons', items: [['元に戻す', () => this.resetRect()], ['✓ 切り抜く', () => this.commit(), 'primary']] },
    ];
  }
  ratio() {
    const r = this.opts.ratio, d = this.doc;
    if (r === 'free') return 0;
    if (r === 'orig') return d.width / d.height;
    const [a, b] = r.split(':').map(Number);
    return a / b;
  }
  activate() {
    if (!this.doc) return false;
    this.resetRect();
    return true;
  }
  deactivate() { this.rect = null; this.drag = null; this.view.request(); }
  resetRect() {
    const d = this.doc;
    const k = this.ratio();
    let w = d.width, h = d.height;
    if (k) { if (w / h > k) w = h * k; else h = w / k; }
    this.rect = { x: (d.width - w) / 2, y: (d.height - h) / 2, w, h };
    this.view.request();
    this.refreshInfo();
  }
  optChanged(key) { if (key === 'ratio') this.resetRect(); }
  refreshInfo() { const n = $('#optbar .opt:not(label)'); if (n && this.rect) n.textContent = `${Math.round(this.rect.w)} × ${Math.round(this.rect.h)} px`; }
  quad() { const r = this.rect; return [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }]; }
  down(p) {
    if (!this.rect) this.resetRect();
    const h = hitHandle(this.view, this.quad(), p);
    const r = this.rect;
    const inside = p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    this.drag = { h, kind: h >= 0 ? 'handle' : inside ? 'move' : 'new', p0: p, r0: { ...r } };
  }
  move(p) {
    const dr = this.drag;
    if (!dr) return;
    const d = this.doc, W = d.width, H = d.height, k = this.ratio();
    const r0 = dr.r0;
    let r;
    if (dr.kind === 'move') {
      r = { ...r0, x: clamp(r0.x + p.x - dr.p0.x, 0, W - r0.w), y: clamp(r0.y + p.y - dr.p0.y, 0, H - r0.h) };
    } else {
      // 固定する点（反対側）と動かす点
      let ax, ay, bx = clamp(p.x, 0, W), by = clamp(p.y, 0, H), fixX = false, fixY = false;
      if (dr.kind === 'new') { ax = clamp(dr.p0.x, 0, W); ay = clamp(dr.p0.y, 0, H); }
      else {
        const h = dr.h;
        const x0 = r0.x, x1 = r0.x + r0.w, y0 = r0.y, y1 = r0.y + r0.h;
        const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        if (h < 4) { [ax, ay] = corners[(h + 2) % 4]; }
        else {
          const e = h - 4;              // 0 上, 1 右, 2 下, 3 左
          if (e === 0) { ax = x0; ay = y1; bx = x1; fixX = true; }
          if (e === 2) { ax = x0; ay = y0; bx = x1; fixX = true; }
          if (e === 1) { ax = x0; ay = y0; by = y1; fixY = true; }
          if (e === 3) { ax = x1; ay = y0; by = y1; fixY = true; }
        }
      }
      let w = bx - ax, h2 = by - ay;
      if (k) {
        if (fixX) w = Math.sign(w || 1) * Math.abs(h2) * k;
        else if (fixY) h2 = Math.sign(h2 || 1) * Math.abs(w) / k;
        else if (Math.abs(w) / Math.max(1e-6, Math.abs(h2)) > k) w = Math.sign(w || 1) * Math.abs(h2) * k;
        else h2 = Math.sign(h2 || 1) * Math.abs(w) / k;
      }
      r = Rect.fromPoints(ax, ay, ax + w, ay + h2);
      const c = Rect.intersect(r, { x: 0, y: 0, w: W, h: H });
      if (!c) return;
      if (k && (c.w !== r.w || c.h !== r.h)) return;     // 比率固定ではみ出すなら動かさない
      r = c;
    }
    if (r.w < 1 || r.h < 1) return;
    this.rect = r;
    this.view.request();
    this.refreshInfo();
  }
  up() { this.drag = null; }
  cancel() { this.drag = null; }
  commit() {
    const d = this.doc, r = this.rect;
    if (!d || !r) return;
    const q = Rect.clampTo({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, d.width, d.height);
    if (!q || (q.w === d.width && q.h === d.height)) { toast('切り抜く範囲を枠で決めてください'); return; }
    d.crop(q);
    this.resetRect();
  }
  drawOverlay(g, view) {
    if (!this.rect) return;
    const d = this.doc, r = this.rect;
    const a = view.toScreen(0, 0), b = view.toScreen(d.width, d.height);
    const s = view.toScreen(r.x, r.y), e = view.toScreen(r.x + r.w, r.y + r.h);
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.beginPath();
    g.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.rect(s.x, s.y, e.x - s.x, e.y - s.y);
    g.fill('evenodd');
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      const x = s.x + (e.x - s.x) * i / 3, y = s.y + (e.y - s.y) * i / 3;
      g.beginPath(); g.moveTo(x, s.y); g.lineTo(x, e.y); g.stroke();
      g.beginPath(); g.moveTo(s.x, y); g.lineTo(e.x, y); g.stroke();
    }
    drawHandles(g, view, this.quad(), { center: false });
  }
}
