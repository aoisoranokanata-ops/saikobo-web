'use strict';
/* 画面の部品: ツールバー・オプションバー・レイヤーパネル・カラーパネル・ヒストリー */

// ---- ツールバー ------------------------------------------------------------------
function buildToolbar(app) {
  const bar = $('#toolbar');
  bar.replaceChildren();
  for (const t of app.toolList) {
    if (!t) { bar.append(el('div', { class: 'tool-sep' })); continue; }
    const key = TOOL_KEYS[t.name];
    const b = el('button', { class: 'tool', 'data-tool': t.name, title: t.label + (key ? `（${key}）` : ''), 'aria-label': t.label });
    b.innerHTML = `<svg viewBox="0 0 24 24">${TOOL_ICONS[t.name] || ''}</svg>`;
    b.addEventListener('click', () => app.selectTool(t.name));
    bar.append(b);
  }
  const colors = el('div', { class: 'colors' },
    el('button', { class: 'fgc', id: 'fgSwatch', title: '描画色', 'aria-label': '描画色', onclick: () => app.openColorTab('fg') }),
    el('button', { class: 'bgc', id: 'bgSwatch', title: '背景色', 'aria-label': '背景色', onclick: () => app.openColorTab('bg') }),
    el('button', { class: 'swap', title: '描画色と背景色を入れ替え（X）', onclick: () => app.swapColors() }, '⇄'),
    el('button', { class: 'reset', title: '初期の色に戻す（D）', onclick: () => app.resetColors() }, '◩'),
  );
  bar.append(colors);
}
function updateToolbar(app) {
  for (const b of $$('#toolbar .tool')) b.classList.toggle('on', b.dataset.tool === app.toolName);
  $('#fgSwatch').style.background = app.fg;
  $('#bgSwatch').style.background = app.bg;
}

// ---- オプションバー ----------------------------------------------------------------
function buildOptbar(app) {
  const bar = $('#optbar');
  const tool = app.tool;
  bar.replaceChildren(el('span', { class: 'opt-title' }, tool.label));
  for (const s of tool.spec()) {
    if (s.type === 'note') { bar.append(el('span', { class: 'opt' }, s.text)); continue; }
    if (s.type === 'preset') {
      const b = el('button', { class: 'opt-btn preset-btn' }, el('span', { class: 'opt-dim' }, tool.eraser ? '種類 ' : 'ペン '), tool.preset.label, ' ▾');
      b.addEventListener('click', () => openPresetPicker(app, tool, b));
      bar.append(b);
      continue;
    }
    if (s.type === 'buttons') {
      for (const [label, fn, cls] of s.items) {
        const b = el('button', { class: 'opt-btn' + (cls ? ' ' + cls : '') }, label);
        b.addEventListener('click', fn);
        bar.append(b);
      }
      continue;
    }
    if (s.type === 'seg') {
      const seg = el('div', { class: 'seg' });
      for (const [v, l] of s.items) {
        const b = el('button', { class: tool.opts[s.key] === v ? 'on' : '' }, l);
        b.addEventListener('click', () => { tool.setOpt(s.key, v); tool.optChanged && tool.optChanged(s.key); buildOptbar(app); });
        seg.append(b);
      }
      bar.append(seg);
      continue;
    }
    if (s.type === 'check') {
      const cb = el('input', { type: 'checkbox', checked: !!tool.opts[s.key] });
      cb.addEventListener('change', () => { tool.setOpt(s.key, cb.checked); tool.optChanged && tool.optChanged(s.key); });
      bar.append(el('label', { class: 'opt' }, cb, s.label));
      continue;
    }
    if (s.type === 'select') {
      const sel = el('select', {});
      for (const [v, l] of s.items) sel.append(el('option', { value: v, selected: tool.opts[s.key] === v }, l));
      sel.addEventListener('change', () => { tool.setOpt(s.key, sel.value); tool.optChanged && tool.optChanged(s.key); buildOptbar(app); });
      bar.append(el('label', { class: 'opt' }, s.label, sel));
      continue;
    }
    if (s.type === 'range') {
      const curve = s.curve || 1;
      const toT = (v) => Math.round(Math.pow((v - s.min) / (s.max - s.min), 1 / curve) * 1000);
      const fromT = (t) => Math.round(s.min + Math.pow(t / 1000, curve) * (s.max - s.min));
      const input = el('input', { type: 'range', min: 0, max: 1000, value: toT(tool.opts[s.key]) });
      const val = el('span', { class: 'val' }, tool.opts[s.key] + s.unit);
      input.addEventListener('input', () => {
        const v = fromT(Number(input.value));
        tool.setOpt(s.key, v);
        val.textContent = v + s.unit;
        app.view.request();
        if (app.edgeSliders) app.edgeSliders.update();
      });
      val.addEventListener('click', async () => {
        const r = await openDialog({ title: s.label, fields: [{ key: 'v', label: s.label, type: 'number', value: tool.opts[s.key], min: s.min, max: s.max }] });
        if (!r) return;
        const v = clamp(Math.round(r.values.v) || s.min, s.min, s.max);
        tool.setOpt(s.key, v);
        buildOptbar(app);
      });
      bar.append(el('label', { class: 'opt' }, s.label, input, val));
    }
  }
  if (tool instanceof BrushTool) {
    const b = el('button', { class: 'opt-btn', title: '[ ] キーでも変えられます' }, '−');
    const p = el('button', { class: 'opt-btn' }, '＋');
    b.addEventListener('click', () => app.brushSize(-1));
    p.addEventListener('click', () => app.brushSize(1));
    bar.children[2].after(b, p);
  }
}

/** ペンの種類を、筆跡の見本つきで選ぶ */
function openPresetPicker(app, tool, anchor) {
  const grid = el('div', { class: 'preset-grid' });
  let close = null;
  for (const key of tool.presetKeys()) {
    const p = BRUSH_PRESETS[key];
    const c = el('canvas', { width: 300, height: 84 });
    drawPresetSample(c, p);
    const b = el('button', { class: 'preset-item' + (tool.opts.kind === key ? ' on' : '') }, c, el('span', {}, p.label));
    b.addEventListener('click', () => { tool.setPreset(key); buildOptbar(app); close && close(); });
    grid.append(b);
  }
  close = openPopover(anchor, grid);
}
/** 見本の筆跡（S字・入り抜きのある筆圧）を描く */
function drawPresetSample(c, p) {
  const g = ctx2d(c);
  const W = c.width, H = c.height;
  const buf = newCanvas(W, H), bg = ctx2d(buf);
  const S = 64, tip = newCanvas(S, S), tg = ctx2d(tip);
  const h = p.hardness / 100, inner = Math.min(0.97, h);
  const grad = tg.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, '#eeeeee'); grad.addColorStop(inner, '#eeeeee');
  for (let i = 1; i <= 6; i++) { const t = i / 6; grad.addColorStop(Math.min(1, inner + (1 - inner) * t), `rgba(238,238,238,${(1 - t * t * (3 - 2 * t)).toFixed(3)})`); }
  tg.fillStyle = grad; tg.fillRect(0, 0, S, S);
  const base = 9;
  let last = null;
  for (let i = 0; i <= 400; i++) {
    const t = i / 400;
    const x = 18 + t * (W - 36);
    const y = H / 2 + Math.sin(t * Math.PI * 2) * (H * 0.22);
    const pr = Math.sin(t * Math.PI);                         // 入り抜き
    const r = p.pressureSize ? Math.max(0.4, base * (p.min + (1 - p.min) * Math.pow(pr, p.gamma))) : base;
    if (last && Math.hypot(x - last.x, y - last.y) < Math.max(0.5, r * 2 * p.spacing)) continue;
    bg.globalAlpha = p.flow * (p.pressureOpacity ? Math.max(0.05, pr) : 1);
    bg.drawImage(tip, x - r, y - r, r * 2, r * 2);
    last = { x, y };
  }
  if (p.grain > 0) {
    bg.globalAlpha = 1;
    bg.globalCompositeOperation = 'destination-out';
    bg.fillStyle = bg.createPattern(grainTexture(p.grain, p.grainScale), 'repeat');
    bg.fillRect(0, 0, W, H);
  }
  g.clearRect(0, 0, W, H);
  g.globalAlpha = (p.opacity || 100) / 100;
  g.drawImage(buf, 0, 0);
}

// ---- レイヤーパネル ----------------------------------------------------------------
class LayersPanel {
  constructor(app) {
    this.app = app;
    this.list = $('#layerList');
    this.blend = $('#lyBlend');
    this.opacity = $('#lyOpacity');
    this.opacityV = $('#lyOpacityV');
    this.blend.addEventListener('change', () => {
      const l = this.app.doc.active;
      if (l) this.app.doc.setLayerProps(l, { blend: this.blend.value }, '描画モード');
      if (BLEND[this.blend.value] && !BLEND[this.blend.value].exact) toast('このモードは Web 版では近い式で表示します（exe 版では正確）');
    });
    this.opacity.addEventListener('input', () => {
      const l = this.app.doc.active;
      if (!l) return;
      if (this._opBefore == null) this._opBefore = l.opacity;
      l.opacity = Number(this.opacity.value) / 100;
      this.opacityV.textContent = this.opacity.value + '%';
      this.app.doc.invalidate(null, 'live');
    });
    this.opacity.addEventListener('change', () => {
      const l = this.app.doc.active;
      if (!l || this._opBefore == null) return;
      const v = Number(this.opacity.value) / 100;
      l.opacity = this._opBefore;
      this._opBefore = null;
      this.app.doc.setLayerProps(l, { opacity: v }, '不透明度');
    });
    $('#lyAlphaLock').addEventListener('change', (e) => {
      const l = this.app.doc.active;
      if (l) this.app.doc.setLayerProps(l, { alpha_locked: e.target.checked }, '透明部分をロック');
    });
    $('#lyLock').addEventListener('change', (e) => {
      const l = this.app.doc.active;
      if (l) this.app.doc.setLayerProps(l, { locked: e.target.checked }, 'すべてロック');
    });
    this.thumbs = new Map();       // key（layer.id か id:m）→ {canvas, ref, ver, w, h}
    this.refreshThumbs = debounce(() => this.updateThumbs(), 250);
  }
  /** 折りたたんだグループの中は出さない */
  hiddenByCollapse(doc, l) {
    for (let p = doc.parentOf(l); p; p = doc.parentOf(p)) if (p.group && p.group.collapsed) return true;
    return false;
  }
  render() {
    const doc = this.app.doc;
    if (!doc) return;
    this.list.replaceChildren();
    const keys = new Set();
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (this.hiddenByCollapse(doc, l)) continue;
      const depth = doc.depth(l);
      const eye = el('button', { class: 'eye' + (l.visible ? '' : ' off'), 'aria-label': '表示', title: '表示・非表示' }, '👁');
      eye.addEventListener('click', (e) => { e.stopPropagation(); doc.setLayerProps(l, { visible: !l.visible }, l.visible ? 'レイヤーを非表示' : 'レイヤーを表示'); });
      const parts = [eye];
      if (depth) parts.push(el('span', { class: 'indent', style: `width:${depth * 14}px` }));
      if (l.isGroup) {
        const tw = el('button', { class: 'twisty', 'aria-label': '開く・閉じる' }, l.group.collapsed ? '▸' : '▾');
        tw.addEventListener('click', (e) => {          // 折りたたみは履歴に残さない（exe と同じ）
          e.stopPropagation();
          l.group = { ...l.group, collapsed: !l.group.collapsed };
          doc.emit('layers');
        });
        parts.push(tw);
      }
      if (l.clip) parts.push(el('span', { class: 'clip-mark', title: 'クリッピングマスク' }, '↳'));
      const main = this.thumb(l);
      keys.add(String(l.id));
      const onMain = doc.activeId === l.id && !doc.editingMask;
      main.classList.toggle('sel', onMain && !!l.mask);
      main.addEventListener('click', (e) => {
        e.stopPropagation();
        if (doc.activeId === l.id && doc.editingMask) { doc.editingMask = false; doc.emit('layers'); return; }
        if (doc.activeId === l.id) { this.app.cmd(l.isText || l.isAdjustment ? 'layer.edit' : 'layer.rename'); return; }
        doc.editingMask = false;
        doc.setActive(l);
      });
      parts.push(main);
      if (l.mask) {
        const mt = this.maskThumb(l);
        keys.add(l.id + ':m');
        mt.classList.toggle('sel', doc.activeId === l.id && doc.editingMask);
        mt.classList.toggle('off', l.mask_enabled === false);
        mt.addEventListener('click', (e) => {
          e.stopPropagation();
          doc.setActive(l);
          doc.editingMask = true;
          doc.emit('layers');
          this.app.hint('マスクを編集中（黒で隠す・白で見せる）');
        });
        parts.push(mt);
      }
      const sub = [];
      if (l.isGroup) sub.push('グループ');
      if (l.isAdjustment) sub.push('調整');
      if (l.isText) sub.push('テキスト');
      if (l.blend !== 'normal' && !(l.isGroup && l.blend === 'pass_through')) sub.push(BLEND[l.blend] ? BLEND[l.blend].label : l.blend);
      if (l.opacity < 1) sub.push(Math.round(l.opacity * 100) + '%');
      if (l.hasStyles()) sub.push('fx');
      if (l.locked) sub.push('🔒');
      else if (l.alpha_locked) sub.push('▦ロック');
      parts.push(el('div', { class: 'lname' }, el('div', {}, l.name), sub.length ? el('div', { class: 'lsub' }, sub.join(' · ')) : null));
      parts.push(el('span', { class: 'handle', title: 'ドラッグで並べ替え' }, '≡'));
      const li = el('li', { class: 'layer-item' + (l.id === doc.activeId ? ' on' : '') + (l.isGroup ? ' grp' : ''), 'data-id': l.id }, ...parts);
      li.addEventListener('click', () => {
        if (l.id === doc.activeId) this.app.cmd(l.isText || l.isAdjustment ? 'layer.edit' : 'layer.rename');
        else { doc.editingMask = false; doc.setActive(l); }
      });
      li.addEventListener('contextmenu', (e) => { e.preventDefault(); this.menu(l, li); });
      this.longPress(li, () => this.menu(l, li));
      this.dragHandle(li.querySelector('.handle'), l);
      this.list.append(li);
    }
    for (const k of [...this.thumbs.keys()]) if (!keys.has(k)) this.thumbs.delete(k);
    this.updateProps();
  }
  updateProps() {
    const l = this.app.doc && this.app.doc.active;
    if (!l) return;
    // 描画モードの一覧（グループだけ「通過」がある）
    const want = l.isGroup ? 'group' : 'layer';
    if (this.blend.dataset.kind !== want) {
      this.blend.replaceChildren();
      if (l.isGroup) this.blend.append(el('option', { value: 'pass_through' }, '通過'));
      for (const [k, label, , exact] of BLEND_MODES) this.blend.append(el('option', { value: k }, (exact ? '' : '≈ ') + label));
      this.blend.dataset.kind = want;
    }
    this.blend.value = l.blend in BLEND ? l.blend : 'normal';
    if (this._opBefore == null) {
      this.opacity.value = Math.round(l.opacity * 100);
      this.opacityV.textContent = Math.round(l.opacity * 100) + '%';
    }
    $('#lyAlphaLock').checked = !!l.alpha_locked;
    $('#lyAlphaLock').disabled = !l.canvas || l.isText;
    $('#lyLock').checked = !!l.locked;
  }
  thumb(l) {
    const key = String(l.id);
    if (l.isGroup || l.isAdjustment) {
      const icon = el('div', { class: 'lthumb icon' }, l.isGroup ? '📁' : '◐');
      if (l.isAdjustment) icon.title = (ADJUSTMENTS[l.adjustment.key] || {}).label || '調整レイヤー';
      return icon;
    }
    let t = this.thumbs.get(key);
    if (!t) { t = { canvas: el('canvas', { class: 'lthumb', width: 96, height: 80 }), ref: null, ver: -1 }; this.thumbs.set(key, t); }
    this.drawThumb(l.canvas, l.ver, t, false);
    const wrap = el('div', { class: 'lthumb-wrap' }, t.canvas);
    if (l.isText) wrap.append(el('span', { class: 'tbadge' }, 'T'));
    return wrap;
  }
  maskThumb(l) {
    const key = l.id + ':m';
    let t = this.thumbs.get(key);
    if (!t) { t = { canvas: el('canvas', { class: 'lthumb mthumb', width: 96, height: 80 }), ref: null, ver: -1 }; this.thumbs.set(key, t); }
    this.drawThumb(l.mask, l.ver, t, true);
    return el('div', { class: 'lthumb-wrap mask' }, t.canvas);
  }
  drawThumb(src, ver, t, isMask) {
    const doc = this.app.doc;
    if (!src || (t.ref === src && t.ver === ver && t.w === doc.width && t.h === doc.height)) return;
    const c = t.canvas, g = ctx2d(c);
    g.clearRect(0, 0, c.width, c.height);
    const s = Math.min(c.width / doc.width, c.height / doc.height);
    const w = doc.width * s, h = doc.height * s;
    g.imageSmoothingQuality = 'medium';
    if (isMask) { g.fillStyle = '#000'; g.fillRect((c.width - w) / 2, (c.height - h) / 2, w, h); }
    g.drawImage(src, (c.width - w) / 2, (c.height - h) / 2, w, h);
    t.ref = src; t.ver = ver; t.w = doc.width; t.h = doc.height;
  }
  updateThumbs() {
    const doc = this.app.doc;
    if (!doc) return;
    for (const l of doc.layers) {
      const t = this.thumbs.get(String(l.id));
      if (t && l.canvas) this.drawThumb(l.canvas, l.ver, t, false);
      const m = this.thumbs.get(l.id + ':m');
      if (m && l.mask) this.drawThumb(l.mask, l.ver, m, true);
    }
  }
  menu(l, anchor) {
    const doc = this.app.doc;
    doc.setActive(l);
    const c = (cmd) => () => this.app.cmd(cmd);
    openMenu(anchor, [
      l.isText ? { label: '文字を直す', action: c('layer.edit') } : l.isAdjustment ? { label: '調整を直す', action: c('layer.edit') } : null,
      { label: '名前を変更', action: c('layer.rename') },
      { label: '複製', action: c('layer.duplicate') },
      { label: '下と結合', action: c('layer.mergeDown'), disabled: doc.siblings(l)[0] === l || l.isGroup },
      '-',
      { label: 'レイヤースタイル…', action: c('layer.styles'), disabled: !l.canvas },
      { label: l.clip ? 'クリッピングマスクを解除' : 'クリッピングマスクを作成', action: c('layer.clip') },
      l.mask ? { label: 'マスクを削除', action: c('mask.delete') } : { label: 'マスクを追加', action: c('mask.add') },
      l.isGroup ? { label: 'グループ解除', action: c('layer.ungroup') } : { label: 'グループ化', action: c('layer.group') },
      (l.isText || l.hasStyles()) ? { label: 'ラスタライズ', action: c('layer.rasterize') } : null,
      '-',
      { label: '左右反転', action: c('layer.flipH') },
      { label: '上下反転', action: c('layer.flipV') },
      { label: 'レイヤーの不透明部分を選択', action: c('select.layerAlpha') },
      '-',
      { label: '削除', action: c('layer.delete') },
    ].filter((x) => x !== null));
  }
  longPress(node, fn) {
    let t = 0, sx = 0, sy = 0;
    node.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || e.target.closest('.handle, .eye, .twisty')) return;
      sx = e.clientX; sy = e.clientY;
      t = setTimeout(() => { t = 0; node._longPressed = true; fn(); }, 550);
    });
    const stop = (e) => { if (t && (!e || e.type !== 'pointermove' || Math.hypot(e.clientX - sx, e.clientY - sy) > 8)) { clearTimeout(t); t = 0; } };
    node.addEventListener('pointermove', stop);
    node.addEventListener('pointerup', () => stop());
    node.addEventListener('pointercancel', () => stop());
    node.addEventListener('click', (e) => { if (node._longPressed) { node._longPressed = false; e.stopImmediatePropagation(); } }, true);
  }
  /** ≡ をつかんで上下に動かすと並べ替え（開いたグループの見出しの下半分に落とすとグループの中へ） */
  dragHandle(h, layer) {
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { h.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
      const li = h.closest('.layer-item');
      li.classList.add('dragging');
      let target = null, place = null;
      const items = $$('.layer-item', this.list);
      const move = (ev) => {
        for (const it of items) it.classList.remove('drop-above', 'drop-below');
        target = null;
        for (const it of items) {
          const r = it.getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY < r.bottom) {
            target = it;
            place = ev.clientY < r.top + r.height / 2 ? 'above' : 'below';
            if (it !== li) it.classList.add(place === 'above' ? 'drop-above' : 'drop-below');
            break;
          }
        }
        const lr = this.list.getBoundingClientRect();     // 端で自動スクロール
        if (ev.clientY < lr.top + 24) this.list.scrollTop -= 8;
        else if (ev.clientY > lr.bottom - 24) this.list.scrollTop += 8;
      };
      const up = () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
        li.classList.remove('dragging');
        for (const it of items) it.classList.remove('drop-above', 'drop-below');
        if (!target || target === li) return;
        const doc = this.app.doc;
        const other = doc.layerById(Number(target.dataset.id));
        if (!other || other === layer || doc.isInside(other, layer)) return;
        // リストは上が前面。見出しの下 = グループの中の一番上（開いているグループ）
        if (place === 'below' && other.isGroup && !other.group.collapsed) doc.placeLayer(layer, other, 'into');
        else doc.placeLayer(layer, other, place === 'above' ? 'above' : 'below');
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
  }
}

// ---- カラーパネル ------------------------------------------------------------------
class ColorPanel {
  constructor(app) {
    this.app = app;
    this.target = 'fg';
    this.hsv = [0, 0, 0];
    this.sv = $('#svBox');
    this.hue = $('#hueBar');
    this.hex = $('#hexInput');
    this.native = $('#nativeColor');
    this.dragArea(this.sv, (x, y) => { this.hsv[1] = x; this.hsv[2] = 1 - y; this.apply(); });
    this.dragArea(this.hue, (x) => { this.hsv[0] = Math.min(359.9, x * 360); this.apply(); });
    this.hex.addEventListener('change', () => {
      const rgb = Color.hexToRgb(this.hex.value);
      if (rgb) this.set(Color.rgbToHex(...rgb)); else this.sync();
    });
    this.native.addEventListener('input', () => this.set(this.native.value));
  }
  dragArea(c, fn) {
    const at = (e) => {
      const r = c.getBoundingClientRect();
      fn(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
    };
    c.addEventListener('pointerdown', (e) => {
      try { c.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
      at(e);
      const mv = (ev) => at(ev);
      const up = () => {
        c.removeEventListener('pointermove', mv); c.removeEventListener('pointerup', up); c.removeEventListener('pointercancel', up);
        if (this.target === 'fg') this.app.addRecent(this.app.fg);
      };
      c.addEventListener('pointermove', mv); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    });
  }
  current() { return this.target === 'bg' ? this.app.bg : this.app.fg; }
  set(hex) {
    if (this.target === 'bg') this.app.setBg(hex); else this.app.setFg(hex);
  }
  apply() {
    const hex = Color.rgbToHex(...Color.hsvToRgb(...this.hsv));
    this._internal = true;
    if (this.target === 'bg') this.app.setBg(hex); else this.app.setFg(hex, { recent: false });
    this._internal = false;
    this.draw();
  }
  /** 外から色が変わったら HSV を合わせる（自分で動かしている間は色相を保つ） */
  sync() {
    if (!this._internal) {
      const rgb = Color.hexToRgb(this.current());
      const hsv = Color.rgbToHsv(...rgb);
      if (hsv[1] === 0 || hsv[2] === 0) hsv[0] = this.hsv[0];
      this.hsv = hsv;
    }
    this.draw();
  }
  draw() {
    if ($('#tab-color').hidden) return;
    const [h, s, v] = this.hsv;
    const sv = this.sv, g = ctx2d(sv);
    const W = sv.width, H = sv.height;
    g.fillStyle = `hsl(${h},100%,50%)`; g.fillRect(0, 0, W, H);
    const wg = g.createLinearGradient(0, 0, W, 0); wg.addColorStop(0, '#fff'); wg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = wg; g.fillRect(0, 0, W, H);
    const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, 'rgba(0,0,0,0)'); bg.addColorStop(1, '#000');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.lineWidth = 2; g.strokeStyle = v > 0.6 && s < 0.4 ? '#000' : '#fff';
    g.beginPath(); g.arc(s * W, (1 - v) * H, 7, 0, Math.PI * 2); g.stroke();
    const hb = this.hue, hg = ctx2d(hb);
    const grad = hg.createLinearGradient(0, 0, hb.width, 0);
    for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
    hg.fillStyle = grad; hg.fillRect(0, 0, hb.width, hb.height);
    const x = (h / 360) * hb.width;
    hg.lineWidth = 3; hg.strokeStyle = '#fff';
    hg.strokeRect(x - 3, 1, 6, hb.height - 2);
    const cur = this.current();
    $('#pickSwatch').style.background = cur;
    if (document.activeElement !== this.hex) this.hex.value = cur;
    this.native.value = cur;
    const rc = $('#recentColors');
    rc.replaceChildren(...this.app.recent.map((c) => {
      const b = el('button', { title: c, 'aria-label': c, style: `background:${c}` });
      b.addEventListener('click', () => this.set(c));
      return b;
    }));
  }
}

// ---- ヒストリー --------------------------------------------------------------------
function renderHistory(app) {
  const ol = $('#historyList');
  if ($('#tab-history').hidden || !app.doc) return;
  const h = app.doc.history;
  ol.replaceChildren();
  const add = (label, n) => {
    const li = el('li', { class: n === h.pos ? 'cur' : n > h.pos ? 'redo' : '' }, label);
    li.addEventListener('click', () => { h.jump(n); });
    ol.append(li);
  };
  add('（' + h.base + '）', 0);
  h.list.forEach((c, i) => add(c.label, i + 1));
  const cur = ol.querySelector('.cur');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}

// ---- 画面の端のスライダー（ブラシ・消しゴムのサイズと不透明度。iPad で絵から目を離さずに変える） ----
class EdgeSliders {
  constructor(app) {
    this.app = app;
    this.root = el('div', { class: 'edge-sliders', hidden: true });
    this.size = this.slider('サイズ', (t) => {
      const tool = this.app.tool;
      tool.setOpt('size', Math.max(1, Math.round(1 + Math.pow(t, 2) * 499)));
      this.app.view.request();
      return tool.opts.size + 'px';
    });
    this.op = this.slider('不透明度', (t) => {
      const tool = this.app.tool;
      tool.setOpt('opacity', Math.max(1, Math.round(t * 100)));
      return tool.opts.opacity + '%';
    });
    this.root.append(this.size.node, this.op.node);
    $('#viewport').append(this.root);
  }
  slider(label, onChange) {
    const fill = el('div', { class: 'es-fill' }), knob = el('div', { class: 'es-knob' });
    const tip = el('div', { class: 'es-tip', hidden: true });
    const track = el('div', { class: 'es-track', 'aria-label': label, role: 'slider' }, fill, knob, tip);
    const node = el('div', { class: 'es' }, track, el('div', { class: 'es-label' }, label === 'サイズ' ? '太さ' : '濃さ'));
    const set = (t) => {
      t = clamp(t, 0, 1);
      fill.style.height = (t * 100) + '%';
      knob.style.bottom = `calc(${t * 100}% - 8px)`;
      return t;
    };
    const at = (e) => { const r = track.getBoundingClientRect(); return clamp(1 - (e.clientY - r.top) / r.height, 0, 1); };
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { track.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
      const go = (ev) => { const t = set(at(ev)); tip.textContent = label + ' ' + onChange(t); tip.hidden = false; };
      go(e);
      const up = () => { track.removeEventListener('pointermove', go); track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up); tip.hidden = true; buildOptbar(this.app); };
      track.addEventListener('pointermove', go); track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
    });
    return { node, set };
  }
  update() {
    const t = this.app.tool;
    const show = !!this.app.doc && t instanceof BrushTool && this.app.settings.edgeSliders !== false;
    this.root.hidden = !show;
    if (!show) return;
    this.size.set(Math.sqrt((t.opts.size - 1) / 499));
    this.op.set(t.opts.opacity / 100);
  }
}
