'use strict';
/* 色調補正・フィルターのパネル（画面の上に浮かぶ。絵を見ながら値を動かせる）。
   プレビューは doc.live（作業用 canvas）に描くだけで、OK で1手の履歴にする。 */

class AdjustPanel {
  constructor(app) {
    this.app = app;
    this.root = $('#adjPanel');
    this.spec = null;
    this._timer = 0;
  }
  get doc() { return this.app.doc; }
  get open() { return !!this.spec; }

  /** 調整レイヤーの値を直す（layer モード）: 変更はそのまま画面に出し、OK で before からの1手にする */
  startLayer(layer, { before, label }) {
    const spec = findSpec(layer.adjustment.key);
    if (!spec) return;
    if (this.open) this.cancel();
    this.layerMode = { layer, before, label, wasVisible: layer.visible };
    this.spec = spec;
    this.layer = layer;
    this.params = { ...defaultParams(spec), ...JSON.parse(JSON.stringify(layer.adjustment.params || {})) };
    this.preview = true;
    this.build();
  }
  start(key) {
    const spec = findSpec(key);
    const d = this.doc;
    if (!spec || !d) return;
    if (this.open) this.cancel();
    this.layerMode = null;
    const why = this.app.cannotEdit({ needsLayer: () => 'pixels' });
    if (why) { toast(why, { error: true }); return; }
    const remembered = spec.kind === 'filter' ? LS.get('filter.' + key, null) : null;
    const params = { ...defaultParams(spec), ...(remembered || {}) };
    if (spec.noDialog) { this.applyNow(spec, params); return; }
    this.spec = spec;
    this.layer = d.active;
    this.params = params;
    this.preview = true;
    this.lastRect = null;
    this.liveC = this.app.scratch('adjust');
    const lg = ctx2d(this.liveC);
    lg.clearRect(0, 0, d.width, d.height);
    lg.drawImage(this.layer.canvas, 0, 0);
    d.live = { layer: this.layer, canvas: this.liveC, update: () => {} };
    this.build();
    this.schedule(0);
  }
  /** ダイアログ無しの補正（反転・自動トーンなど） */
  applyNow(spec, params) {
    const d = this.doc, layer = d.active;
    const { rect, data } = runSpec(spec, params, layer, d.sel, d.width, d.height);
    d.editPixels(spec.label, layer, rect, (g) => g.putImageData(data, rect.x, rect.y));
    this.app.lastFilter = spec.kind === 'filter' ? { key: spec.key, params } : this.app.lastFilter;
  }

  build() {
    const s = this.spec;
    const root = this.root;
    root.replaceChildren();
    const head = el('div', { class: 'adj-head' }, el('span', { class: 'adj-title' }, (this.layerMode ? '調整レイヤー: ' : '') + s.label),
      el('button', { class: 'adj-x', 'aria-label': '小さくする', onclick: () => root.classList.toggle('mini') }, '▾'));
    root.append(head);
    const body = el('div', { class: 'adj-body' });
    root.append(body);
    this.inputs = {};
    if (s.ui === 'curves' || s.ui === 'levels') body.append(this.histWidget());
    for (const q of s.params) {
      if (q.type === 'points') continue;
      body.append(this.field(q));
    }
    const prev = el('input', { type: 'checkbox', checked: true });
    prev.addEventListener('change', () => { this.preview = prev.checked; this.schedule(0); });
    const busy = el('span', { class: 'adj-busy', hidden: true }, '計算中…');
    this.busy = busy;
    body.append(el('div', { class: 'adj-foot' },
      el('label', { class: 'adj-prev' }, prev, ' プレビュー'), busy,
      el('span', { style: 'flex:1' }),
      el('button', { class: 'btn', onclick: () => this.reset() }, '初期値'),
      el('button', { class: 'btn', onclick: () => this.cancel() }, 'キャンセル'),
      el('button', { class: 'btn primary', onclick: () => this.ok() }, 'OK')));
    root.classList.remove('mini');
    root.hidden = false;
  }
  field(q) {
    const p = this.params;
    if (q.type === 'bool') {
      const cb = el('input', { type: 'checkbox', checked: !!p[q.key] });
      cb.addEventListener('change', () => { p[q.key] = cb.checked; this.schedule(); });
      this.inputs[q.key] = { set: (v) => { cb.checked = !!v; } };
      return el('label', { class: 'adj-row adj-check' }, cb, ' ', q.label);
    }
    if (q.type === 'choice') {
      const sel = el('select', {});
      for (const [v, l] of q.choices) sel.append(el('option', { value: v, selected: v === p[q.key] }, l));
      sel.addEventListener('change', () => {
        p[q.key] = sel.value;
        if (this.spec.ui && q.key === 'channel') this.drawHist();
        this.schedule();
      });
      this.inputs[q.key] = { set: (v) => { sel.value = v; } };
      return el('div', { class: 'adj-row' }, el('label', {}, q.label), sel);
    }
    if (q.type === 'color') {
      const c = el('input', { type: 'color', value: p[q.key] });
      c.addEventListener('input', () => { p[q.key] = c.value; this.schedule(); });
      this.inputs[q.key] = { set: (v) => { c.value = v; } };
      return el('div', { class: 'adj-row' }, el('label', {}, q.label), c);
    }
    // 数値: スライダー＋数字
    const digits = q.type === 'float' ? (q.digits ?? 1) : 0;
    const curve = q.curve || 1;
    const toT = (v) => Math.round(Math.pow((v - q.min) / (q.max - q.min), 1 / curve) * 1000);
    const fromT = (t) => q.min + Math.pow(t / 1000, curve) * (q.max - q.min);
    const fix = (v) => Number(clamp(v, q.min, q.max).toFixed(digits));
    const range = el('input', { type: 'range', min: 0, max: 1000, value: toT(p[q.key]) });
    const num = el('input', { type: 'number', value: p[q.key], min: q.min, max: q.max, step: digits ? 1 / 10 ** digits : 1, inputmode: 'decimal' });
    range.addEventListener('input', () => { p[q.key] = fix(fromT(Number(range.value))); num.value = p[q.key]; this.onParam(q.key); });
    num.addEventListener('change', () => { const v = Number(num.value); p[q.key] = Number.isFinite(v) ? fix(v) : q.def; num.value = p[q.key]; range.value = toT(p[q.key]); this.onParam(q.key); });
    this.inputs[q.key] = { set: (v) => { num.value = v; range.value = toT(v); } };
    return el('div', { class: 'adj-row' }, el('label', {}, q.label), range, el('span', { class: 'adj-num' }, num, q.suffix ? el('span', { class: 'adj-suf' }, q.suffix) : null));
  }
  onParam(key) {
    if (this.spec.ui === 'levels' && /^(in_black|in_white|gamma)$/.test(key)) this.drawHist();
    this.schedule();
  }
  reset() {
    this.params = defaultParams(this.spec);
    for (const [k, inp] of Object.entries(this.inputs)) inp.set(this.params[k]);
    if (this.hist) this.drawHist();
    this.schedule(0);
  }

  // ---- ヒストグラム・トーンカーブ
  histWidget() {
    const c = el('canvas', { class: 'adj-hist', width: 512, height: 512 });
    this.histC = c;
    const d = this.doc;
    const rect = d.sel && !this.layerMode ? d.sel.bounds : d.fullRect;
    this.hist = histogramOf(this.layerMode ? d.composite() : this.layer.canvas, rect, this.layerMode ? null : d.sel);
    if (this.spec.ui === 'curves') this.curveEvents(c);
    else c.height = 200;
    setTimeout(() => this.drawHist(), 0);
    return c;
  }
  drawHist() {
    const c = this.histC;
    if (!c) return;
    const g = ctx2d(c), W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#16171a'; g.fillRect(0, 0, W, H);
    const ch = this.params.channel || 'rgb';
    const hist = this.hist[ch];
    let mx = 0; for (let i = 1; i < 255; i++) mx = Math.max(mx, hist[i]);
    mx = mx || 1;
    g.fillStyle = { rgb: '#6b6f78', red: '#a04a4a', green: '#4a8a4a', blue: '#4a5ea0' }[ch];
    for (let i = 0; i < 256; i++) {
      const v = Math.min(1, hist[i] / mx) * H * 0.95;
      g.fillRect(i * W / 256, H - v, W / 256 + 0.6, v);
    }
    if (this.spec.ui === 'levels') {
      const p = this.params;
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      const mark = (x, col) => { g.strokeStyle = col; g.beginPath(); g.moveTo(x * W / 255, 0); g.lineTo(x * W / 255, H); g.stroke(); };
      const mid = p.in_black + (p.in_white - p.in_black) * Math.pow(0.5, p.gamma);
      mark(p.in_black, '#000'); mark(p.in_white, '#fff'); mark(mid, '#999');
      return;
    }
    // グリッドと曲線
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo(i * W / 4, 0); g.lineTo(i * W / 4, H); g.stroke();
      g.beginPath(); g.moveTo(0, i * H / 4); g.lineTo(W, i * H / 4); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,.25)';
    g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke();
    const lut = curveLut(this.params.points);
    g.strokeStyle = '#fff'; g.lineWidth = 3;
    g.beginPath();
    for (let x = 0; x < 256; x++) { const px = x * W / 255, py = H - lut[x] * H / 255; x ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.stroke();
    for (const [x, y] of this.params.points) {
      g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 2;
      g.beginPath(); g.arc(x * W / 255, H - y * H / 255, 9, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
  curveEvents(c) {
    const toVal = (e) => {
      const r = c.getBoundingClientRect();
      return [clamp((e.clientX - r.left) / r.width * 255, 0, 255), clamp((1 - (e.clientY - r.top) / r.height) * 255, 0, 255)];
    };
    let drag = -1, lastTap = 0;
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
      const [x, y] = toVal(e);
      const pts = this.params.points;
      const r = c.getBoundingClientRect(), tol = 24 / r.width * 255;
      drag = pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < tol);
      const now = performance.now();
      if (drag >= 0 && now - lastTap < 350 && pts.length > 2) {      // ダブルタップで点を消す
        pts.splice(drag, 1); drag = -1; this.drawHist(); this.schedule(); return;
      }
      lastTap = now;
      if (drag < 0) {
        pts.push([Math.round(x), Math.round(y)]);
        pts.sort((a, b) => a[0] - b[0]);
        drag = pts.findIndex((p) => p[0] === Math.round(x) && p[1] === Math.round(y));
      }
      this.drawHist(); this.schedule();
    });
    c.addEventListener('pointermove', (e) => {
      if (drag < 0) return;
      const pts = this.params.points;
      let [x, y] = toVal(e);
      const lo = drag > 0 ? pts[drag - 1][0] + 1 : 0, hi = drag < pts.length - 1 ? pts[drag + 1][0] - 1 : 255;
      x = clamp(Math.round(x), lo, hi);
      pts[drag] = [x, Math.round(y)];
      this.drawHist(); this.schedule();
    });
    const end = () => { drag = -1; };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  }

  // ---- 計算
  schedule(ms) {
    clearTimeout(this._timer);
    const delay = ms ?? (this.spec.kind === 'filter' ? 220 : 30);
    this.busy.hidden = false;
    this._timer = setTimeout(() => this.compute(), delay);
  }
  compute() {
    if (!this.spec) return;
    const d = this.doc;
    if (this.layerMode) {               // 調整レイヤー: 値を差し替えるだけ（合成が計算する）
      const L = this.layerMode.layer;
      L.adjustment = { key: this.spec.key, params: JSON.parse(JSON.stringify(this.params)) };
      L.visible = this.preview ? this.layerMode.wasVisible : false;
      this.busy.hidden = true;
      d.invalidate(null, 'live');
      return;
    }
    const g = ctx2d(this.liveC);
    if (this.lastRect) {            // 前回の結果を元に戻す
      const r = this.lastRect;
      g.clearRect(r.x, r.y, r.w, r.h);
      g.drawImage(this.layer.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    }
    if (this.preview) {
      try {
        const { rect, data } = runSpec(this.spec, this.params, this.layer, d.sel, d.width, d.height);
        g.putImageData(data, rect.x, rect.y);
        this.result = { rect, data, key: JSON.stringify(this.params) };
        this.lastRect = rect;
      } catch (e) { console.error(e); toast('計算できませんでした: ' + e.message, { error: true }); }
    }
    this.busy.hidden = true;
    d.invalidate(this.lastRect || d.fullRect, 'live');
  }
  ok() {
    const d = this.doc, spec = this.spec;
    clearTimeout(this._timer);
    if (this.layerMode) {
      const lm = this.layerMode;
      this.preview = true;
      this.compute();
      lm.layer.visible = lm.wasVisible;
      this.layerMode = null;
      this.close();
      d.commitFrom(lm.label, lm.before);
      return;
    }
    let res = this.result;
    if (!res || res.key !== JSON.stringify(this.params)) res = runSpec(spec, this.params, this.layer, d.sel, d.width, d.height);
    this.close();
    d.editPixels(spec.label, this.layer, res.rect, (g) => g.putImageData(res.data, res.rect.x, res.rect.y));
    if (spec.kind === 'filter') {
      LS.set('filter.' + spec.key, this.params);
      this.app.lastFilter = { key: spec.key, params: JSON.parse(JSON.stringify(this.params)) };
    }
  }
  cancel() {
    clearTimeout(this._timer);
    if (this.layerMode) {
      const lm = this.layerMode;
      this.layerMode = null;
      this.close();
      this.doc.restore(lm.before);         // 作る前・直す前に戻す（履歴には残さない）
      return;
    }
    this.close();
    this.doc && this.doc.invalidate(null, 'live');
  }
  close() {
    const d = this.doc;
    if (d && d.live && d.live.canvas === this.liveC) d.live = null;
    this.spec = null; this.result = null; this.histC = null; this.hist = null;
    this.app.releaseScratch('adjust');            // 文書と同じ大きさの作業用 canvas は使い終わったら返す
    this.liveC = null;
    this.root.hidden = true;
    this.root.replaceChildren();
  }
}
