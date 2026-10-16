'use strict';
/* 画面の表示とジェスチャー。
   2本指: つまんで拡大縮小・動かして移動、素早いタップで取り消し。3本指タップでやり直し。
   ペンを一度使うと「指では描かない」（1本指 = 移動）に切り替わる（app.settings.fingerDraws）。 */

class View {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.scale = 1; this.ox = 0; this.oy = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = 1; this.cssH = 1;
    this.pointers = new Map();     // pointerId → {x, y, type}
    this.mode = null;              // 'tool' | 'pan' | 'pinch'
    this.toolPointer = null;
    this.hover = null;             // ペン・マウスの位置（ブラシの輪郭表示用）
    this.ants = 0;
    this._raf = 0;
    this.spaceDown = false;
    this.gesture = null;

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e, true));
    canvas.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !this.pointers.size) { this.hover = null; this.request(); } });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Safari のつまみ操作（トラックパッド・ページの拡大）を止める
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
    document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
    setInterval(() => {
      if (this.app.doc && this.app.doc.sel && !document.hidden && this.app.screen === 'editor') { this.ants = (this.ants + 1) % 16; this.request(); }
    }, 160);
  }

  get doc() { return this.app.doc; }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const pw = this.cssW, ph = this.cssH;
    this.cssW = Math.max(1, r.width); this.cssH = Math.max(1, r.height);
    // 画面の大きさが変わったら（iPad の回転・パネルの開閉）: 合わせた表示なら合わせ直し、それ以外は中心を保つ
    if (this.doc && pw > 10 && !this._needFit) {
      if (this.fitted) this._needFit = true;
      else { this.ox += (this.cssW - pw) / 2; this.oy += (this.cssH - ph) / 2; }
    }
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    if (this._needFit) { this._needFit = false; this.fit(); }
    this.request();
  }

  // ---- 表示位置
  fit() {
    const d = this.doc;
    if (!d) return;
    if (this.cssW < 10) { this._needFit = true; return; }
    const pad = 24;
    const s = Math.min((this.cssW - pad * 2) / d.width, (this.cssH - pad * 2) / d.height);
    this.setScale(Math.min(s, 8));
    this.ox = (this.cssW - d.width * this.scale) / 2;
    this.oy = (this.cssH - d.height * this.scale) / 2;
    this.fitted = true;
    this.request();
  }
  actualSize() {
    const d = this.doc;
    if (!d) return;
    this.zoomAt(1 / this.scale, this.cssW / 2, this.cssH / 2);
  }
  setScale(s) { this.scale = clamp(s, 0.02, 64); }
  zoomAt(factor, cx, cy) {
    this.fitted = false;
    const old = this.scale;
    this.setScale(old * factor);
    const k = this.scale / old;
    this.ox = cx - (cx - this.ox) * k;
    this.oy = cy - (cy - this.oy) * k;
    this.showZoom();
    this.request();
  }
  zoomStep(dir) {
    const steps = [0.05, 0.1, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
    const s = this.scale;
    const next = dir > 0 ? steps.find((v) => v > s * 1.01) || s * 1.5 : [...steps].reverse().find((v) => v < s * 0.99) || s / 1.5;
    this.zoomAt(next / s, this.cssW / 2, this.cssH / 2);
  }
  showZoom() {
    const b = $('#zoomBadge');
    b.textContent = Math.round(this.scale * 100) + '%';
    b.hidden = false;
    clearTimeout(this._zt);
    this._zt = setTimeout(() => { b.hidden = true; }, 900);
  }
  toDoc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - this.ox) / this.scale, y: (clientY - r.top - this.oy) / this.scale };
  }
  toScreen(x, y) { return { x: x * this.scale + this.ox, y: y * this.scale + this.oy }; }
  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---- 描画
  request() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }
  render() {
    const g = this.g, d = this.doc;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#151618';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!d) return;
    const comp = d.composite();
    const k = this.dpr * this.scale;
    g.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy);
    // 透明部分の市松模様（画面上で一定の大きさ）
    const pat = checkerPattern(g);
    if (pat.setTransform) pat.setTransform(new DOMMatrix().scale(this.dpr / k));
    g.fillStyle = pat;
    g.fillRect(0, 0, d.width, d.height);
    g.imageSmoothingEnabled = this.scale < 2;
    g.imageSmoothingQuality = 'medium';
    g.drawImage(comp, 0, 0);
    // 文書の枠
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const p0 = this.toScreen(0, 0);
    g.strokeStyle = 'rgba(0,0,0,.6)';
    g.lineWidth = 1;
    g.strokeRect(Math.round(p0.x) - 0.5, Math.round(p0.y) - 0.5, Math.round(d.width * this.scale) + 1, Math.round(d.height * this.scale) + 1);
    // 選択範囲の点線
    if (d.sel && !(this.app.tool && this.app.tool.hideAnts)) {
      const path = Sel.outline(d.sel, d.width, d.height);
      g.setTransform(k, 0, 0, k, this.dpr * this.ox, this.dpr * this.oy);
      g.lineWidth = 1 / this.scale;
      g.setLineDash([]);
      g.strokeStyle = '#000';
      g.stroke(path);
      g.setLineDash([4 / this.scale, 4 / this.scale]);
      g.lineDashOffset = -this.ants / this.scale;
      g.strokeStyle = '#fff';
      g.stroke(path);
      g.setLineDash([]);
    }
    // ツールの補助表示（画面座標）
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const tool = this.app.tool;
    if (tool && tool.drawOverlay) tool.drawOverlay(g, this);
    if (this.pickAt) {          // 長押しスポイトの輪（指で隠れないよう少し上に）
      const s = this.toScreen(this.pickAt.x, this.pickAt.y);
      g.lineWidth = 12; g.strokeStyle = this.app.fg;
      g.beginPath(); g.arc(s.x, s.y - 70, 34, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1.5; g.strokeStyle = '#fff';
      g.beginPath(); g.arc(s.x, s.y - 70, 40.5, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(s.x, s.y - 70, 27.5, 0, Math.PI * 2); g.stroke();
    }
  }

  // ---- 入力
  pointInfo(e) {
    const p = this.toDoc(e.clientX, e.clientY);
    let pressure = 1;
    if (e.pointerType === 'pen') pressure = e.pressure > 0 ? e.pressure : 0.5;
    p.pressure = pressure;
    p.type = e.pointerType;
    p.shift = e.shiftKey; p.alt = e.altKey; p.ctrl = e.ctrlKey || e.metaKey;
    p.t = e.timeStamp;
    return p;
  }
  touchCount() { let n = 0; for (const p of this.pointers.values()) if (p.type === 'touch') n++; return n; }

  onDown(e) {
    if (!this.doc) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
    const lp = this.local(e);
    this.pointers.set(e.pointerId, { x: lp.x, y: lp.y, type: e.pointerType });
    if (e.pointerType === 'pen' && this.app.settings.fingerDraws !== false && !this.app.settings._penNoticed) {
      this.app.settings._penNoticed = true;
      if (this.app.settings.fingerDraws === 'auto') {
        this.app.settings.fingerDraws = false;
        this.app.saveSettings();
        toast('Apple Pencil を使ったので、指では描かない設定にしました\n（1本指 = 画面の移動。表示メニューで変更できます）', { ms: 4200 });
      }
    }
    if (e.pointerType === 'touch') {
      const n = this.touchCount();
      if (n >= 2) {
        // 指を置き始めて間もない描画は取り消してジェスチャーへ
        if (this.mode === 'tool' && this.toolPointer && this.toolPointer.type === 'touch') this.cancelTool();
        if (this.mode === 'pan' || this.mode === 'pinch' || this.mode === null || this.mode === 'tool') this.startPinch(e);
        return;
      }
      if (this.mode === 'tool') return;                          // ペンで描いている最中の手のひら
      const fingerDraws = this.app.settings.fingerDraws === true || this.app.settings.fingerDraws === 'auto';
      if (!fingerDraws || this.app.toolName === 'hand') { this.startPan(e); return; }
      this.startTool(e);
      return;
    }
    // ペン・マウス
    if (this.mode === 'pinch' || this.mode === 'pan') {
      if (e.pointerType === 'pen') { this.endGesture(); } else return;
    }
    if (e.button === 1 || e.button === 2 || this.spaceDown || this.app.toolName === 'hand') { this.startPan(e); return; }
    if (this.app.toolName === 'zoom') { const lp2 = this.local(e); this.zoomAt(e.altKey ? 0.5 : 2, lp2.x, lp2.y); return; }
    this.startTool(e);
  }

  startTool(e) {
    const tool = this.app.tool;
    if (!tool) return;
    if (this.app.adjust && this.app.adjust.open) { toast('補正パネルを閉じてから描いてください（OK かキャンセル）'); return; }
    if (this.app.layerUI && this.app.layerUI.open && this.app.toolName !== 'text') { toast('パネルを閉じてから描いてください（OK かキャンセル）'); return; }
    const why = this.app.cannotEdit(tool);
    if (why) { toast(why, { error: true }); return; }
    this.mode = 'tool';
    this.toolPointer = { id: e.pointerId, type: e.pointerType, t0: e.timeStamp };
    this.hover = null;
    tool.down(this.pointInfo(e), e);
    this.request();
  }
  cancelTool() {
    if (this.app.tool && this.app.tool.cancel) this.app.tool.cancel();
    this.mode = null;
    this.toolPointer = null;
    this.request();
  }
  startPan(e) {
    const lp = this.local(e);
    this.mode = 'pan';
    this.gesture = { sx: lp.x, sy: lp.y, ox: this.ox, oy: this.oy, id: e.pointerId };
    // 指を置いたまま止めるとスポイト（ペンで描く設定のとき。iPad の描画アプリと同じ操作）
    clearTimeout(this._holdT);
    if (e.pointerType === 'touch' && this.app.toolName !== 'hand') {
      const cx = e.clientX, cy = e.clientY;
      this._holdT = setTimeout(() => {
        if (this.mode !== 'pan' || !this.gesture || this.gesture.moved) return;
        this.mode = 'pick';
        this.pickAt = this.toDoc(cx, cy);
        this.app.pickColorAt(this.pickAt);
        this.request();
      }, 450);
    }
  }
  startPinch() {
    clearTimeout(this._holdT);
    if (this.mode === 'pick') { this.pickAt = null; }
    const pts = [...this.pointers.values()].filter((p) => p.type === 'touch');
    const [a, b] = pts;
    const prevTap = this.mode === 'pinch' && this.gesture ? this.gesture : null;
    this.mode = 'pinch';
    this.gesture = {
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      scale: this.scale, ox: this.ox, oy: this.oy,
      t0: prevTap ? prevTap.t0 : performance.now(), maxTouches: Math.max(pts.length, prevTap ? prevTap.maxTouches : 0),
      moved: prevTap ? prevTap.moved : 0,
    };
  }

  onMove(e) {
    const lp = this.local(e);
    const ptr = this.pointers.get(e.pointerId);
    if (ptr) { ptr.x = lp.x; ptr.y = lp.y; }
    if (this.mode === 'pinch') {
      if (e.pointerType !== 'touch') return;
      const pts = [...this.pointers.values()].filter((p) => p.type === 'touch');
      if (pts.length < 2) return;
      const [a, b] = pts;
      const G = this.gesture;
      G.maxTouches = Math.max(G.maxTouches, pts.length);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      G.moved = Math.max(G.moved, Math.hypot(cx - G.cx, cy - G.cy), Math.abs(dist - G.dist));
      if (G.moved < 6) return;                               // タップかもしれない間は動かさない
      this.fitted = false;
      this.setScale(G.scale * (dist / G.dist));
      const k = this.scale / G.scale;
      this.ox = cx - (G.cx - G.ox) * k;
      this.oy = cy - (G.cy - G.oy) * k;
      this.showZoom();
      this.request();
      return;
    }
    if (this.mode === 'pick') {
      this.pickAt = this.toDoc(e.clientX, e.clientY);
      this.app.pickColorAt(this.pickAt);
      this.request();
      return;
    }
    if (this.mode === 'pan') {
      if (this.gesture && e.pointerId === this.gesture.id) {
        if (Math.hypot(lp.x - this.gesture.sx, lp.y - this.gesture.sy) > 8) { this.gesture.moved = true; clearTimeout(this._holdT); }
        if (!this.gesture.moved) return;
        this.fitted = false;
        this.ox = this.gesture.ox + lp.x - this.gesture.sx;
        this.oy = this.gesture.oy + lp.y - this.gesture.sy;
        this.request();
      }
      return;
    }
    if (this.mode === 'tool') {
      if (!this.toolPointer || e.pointerId !== this.toolPointer.id) return;
      const tool = this.app.tool;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (evs.length > 1) for (const ce of evs) tool.move(this.pointInfo(ce), ce);
      else tool.move(this.pointInfo(e), e);
      this.request();
      return;
    }
    if (e.pointerType !== 'touch') {           // 押していない時の位置（ブラシの輪郭）
      this.hover = this.toDoc(e.clientX, e.clientY);
      if (this.app.tool && this.app.tool.showsHover) this.request();
    }
  }

  onUp(e, cancelled = false) {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!had) return;
    if (this.mode === 'pinch') {
      if (this.touchCount() === 0) this.endGesture();
      else if (this.touchCount() === 1) {
        // 1本残った: 取り消し判定のため記録だけ残し、移動はしない
      }
      return;
    }
    if (this.mode === 'pick') {
      this.mode = null; this.gesture = null; this.pickAt = null;
      this.app.addRecent(this.app.fg);
      this.request();
      return;
    }
    if (this.mode === 'pan') {
      clearTimeout(this._holdT);
      if (this.gesture && e.pointerId === this.gesture.id) { this.mode = null; this.gesture = null; }
      return;
    }
    if (this.mode === 'tool' && this.toolPointer && e.pointerId === this.toolPointer.id) {
      const tool = this.app.tool;
      if (cancelled && tool.cancel) tool.cancel();
      else tool.up(this.pointInfo(e), e);
      this.mode = null;
      this.toolPointer = null;
      this.request();
    }
  }
  endGesture() {
    const G = this.gesture;
    this.mode = null;
    this.gesture = null;
    if (!G || G.moved >= 12) return;
    const dt = performance.now() - G.t0;
    if (dt > 350) return;
    if (G.maxTouches === 2) this.app.undo();
    else if (G.maxTouches >= 3) this.app.redo();
  }

  onWheel(e) {
    if (!this.doc) return;
    e.preventDefault();
    const lp = this.local(e);
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
      this.zoomAt(f, lp.x, lp.y);
    } else {
      this.ox -= e.deltaX; this.oy -= e.deltaY;
      this.fitted = false;
      this.request();
    }
  }
}
