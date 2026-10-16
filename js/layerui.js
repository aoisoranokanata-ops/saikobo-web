'use strict';
/* レイヤーの非破壊編集の画面: レイヤースタイル・テキスト・調整レイヤーの作成と変更。
   どれも「開いた時の写し before」を取り、値を変えるたびに直接レイヤーに入れて画面に出す。
   OK で before からの1手（doc.commitFrom）、キャンセルで before に戻す（履歴に残さない）。 */

/** 1つの値の入力欄（数値はスライダー＋数字）。戻り値 {node, set(v)} */
function paramField(q, values, onChange) {
  const v0 = values[q.key];
  if (q.type === 'bool') {
    const cb = el('input', { type: 'checkbox', checked: !!v0 });
    cb.addEventListener('change', () => { values[q.key] = cb.checked; onChange(q.key); });
    return { node: el('label', { class: 'adj-row adj-check' }, cb, ' ', q.label), set: (v) => { cb.checked = !!v; } };
  }
  if (q.type === 'choice') {
    const sel = el('select', {});
    for (const [v, l] of q.choices) sel.append(el('option', { value: v, selected: v === v0 }, l));
    sel.addEventListener('change', () => { values[q.key] = sel.value; onChange(q.key); });
    return { node: el('div', { class: 'adj-row' }, el('label', {}, q.label), sel), set: (v) => { sel.value = v; } };
  }
  if (q.type === 'color') {
    const c = el('input', { type: 'color', value: v0 });
    c.addEventListener('input', () => { values[q.key] = c.value; onChange(q.key); });
    return { node: el('div', { class: 'adj-row' }, el('label', {}, q.label), c), set: (v) => { c.value = v; } };
  }
  const digits = q.type === 'float' ? (q.digits ?? 1) : 0;
  const curve = q.curve || 1;
  const toT = (v) => Math.round(Math.pow(clamp((v - q.min) / (q.max - q.min), 0, 1), 1 / curve) * 1000);
  const fromT = (t) => q.min + Math.pow(t / 1000, curve) * (q.max - q.min);
  const fix = (v) => Number(clamp(v, q.min, q.max).toFixed(digits));
  const range = el('input', { type: 'range', min: 0, max: 1000, value: toT(v0) });
  const num = el('input', { type: 'number', value: v0, min: q.min, max: q.max, step: digits ? 1 / 10 ** digits : 1, inputmode: 'decimal' });
  range.addEventListener('input', () => { values[q.key] = fix(fromT(Number(range.value))); num.value = values[q.key]; onChange(q.key); });
  num.addEventListener('change', () => { const v = Number(num.value); values[q.key] = Number.isFinite(v) ? fix(v) : q.def; num.value = values[q.key]; range.value = toT(values[q.key]); onChange(q.key); });
  return {
    node: el('div', { class: 'adj-row' }, el('label', {}, q.label), range, el('span', { class: 'adj-num' }, num, q.suffix ? el('span', { class: 'adj-suf' }, q.suffix) : null)),
    set: (v) => { num.value = v; range.value = toT(v); },
  };
}

class LayerUI {
  constructor(app) {
    this.app = app;
    this.root = $('#adjPanel');
    this.session = null;           // {kind, layer, before, label}
  }
  get doc() { return this.app.doc; }
  get open() { return !!this.session; }

  begin(kind, layer, label) {
    if (this.app.adjust.open) this.app.adjust.cancel();
    if (this.open) this.cancel();
    this.session = { kind, layer, label, before: this.doc.snapshot() };
  }
  shell(title, body, { onReset } = {}) {
    const root = this.root;
    root.replaceChildren();
    root.append(el('div', { class: 'adj-head' }, el('span', { class: 'adj-title' }, title),
      el('button', { class: 'adj-x', 'aria-label': '小さくする', onclick: () => root.classList.toggle('mini') }, '▾')));
    const foot = el('div', { class: 'adj-foot' }, el('span', { style: 'flex:1' }),
      onReset ? el('button', { class: 'btn', onclick: onReset }, '初期値') : null,
      el('button', { class: 'btn', onclick: () => this.cancel() }, 'キャンセル'),
      el('button', { class: 'btn primary', onclick: () => this.ok() }, 'OK'));
    root.append(el('div', { class: 'adj-body' }, body, foot));
    root.classList.remove('mini');
    root.hidden = false;
  }
  close() {
    this.session = null;
    this.root.hidden = true;
    this.root.replaceChildren();
  }
  ok() {
    const s = this.session;
    if (!s) return;
    if (s.kind === 'text' && !String(s.layer.text.text).trim()) { this.cancel(); return; }      // 空の文字は作らない
    if (s.onOk) s.onOk();
    this.close();
    this.doc.commitFrom(s.label, s.before);
  }
  cancel() {
    const s = this.session;
    if (!s) return;
    this.close();
    this.doc.restore(s.before);
  }
  changed() { this.doc.invalidate(null, 'live'); }

  // ---- 調整レイヤー
  newAdjustment(key) {
    const d = this.doc, spec = ADJUSTMENTS[key];
    const before = d.snapshot();
    const l = new Layer(d.width, d.height, spec.label, null, { kind: 'adjustment' });
    l.adjustment = { key, params: defaultParams(spec) };
    d.insertAbove(l, d.active);
    d.activeId = l.id;
    d.editingMask = false;
    d.compDirty = d.fullRect;
    d.emit('layers');
    if (spec.noDialog || !spec.params.length) { d.commitFrom('新規調整レイヤー（' + spec.label + '）', before); return; }
    this.app.adjust.startLayer(l, { before, label: '新規調整レイヤー（' + spec.label + '）' });
  }
  editLayer(layer) {
    if (!layer) return;
    if (layer.isAdjustment) {
      if (this.open) this.cancel();
      this.app.adjust.startLayer(layer, { before: this.doc.snapshot(), label: '調整レイヤーを変更' });
    } else if (layer.isText) this.openText(layer);
    else if (layer.canvas) this.openStyles(layer);
  }

  // ---- レイヤースタイル
  openStyles(layer = this.doc.active) {
    if (!layer || !layer.canvas) { toast('スタイルは画素のあるレイヤー（テキストを含む）に付けられます'); return; }
    this.begin('styles', layer, 'レイヤースタイル');
    const cur = layer.styles || {};
    const vals = {};
    for (const k of STYLE_ORDER) vals[k] = { ...styleDefaults(k), enabled: false, ...(cur[k] || {}) };
    if (cur && Object.keys(cur).length) for (const k of STYLE_ORDER) if (cur[k]) vals[k].enabled = cur[k].enabled !== false;
    const apply = () => {
      const out = {};
      for (const k of STYLE_ORDER) if (vals[k].enabled || (cur[k])) out[k] = { ...vals[k] };
      const any = Object.values(out).some((v) => v.enabled);
      layer.styles = any || Object.keys(out).length ? out : null;
      this.changed();
    };
    const body = el('div', { class: 'style-list' });
    for (const k of STYLE_ORDER) {
      const sec = el('div', { class: 'style-sec' + (vals[k].enabled ? ' on' : '') });
      const cb = el('input', { type: 'checkbox', checked: vals[k].enabled });
      const params = el('div', { class: 'style-params' });
      for (const q of STYLE_SPECS[k].params) params.append(paramField(q, vals[k], () => { if (!vals[k].enabled) { vals[k].enabled = true; cb.checked = true; sec.classList.add('on'); } apply(); }).node);
      cb.addEventListener('change', () => { vals[k].enabled = cb.checked; sec.classList.toggle('on', cb.checked); apply(); });
      sec.append(el('label', { class: 'style-head' }, cb, ' ', STYLE_SPECS[k].label), params);
      body.append(sec);
    }
    this.shell('レイヤースタイル: ' + layer.name, body, {
      onReset: () => {             // すべて外す（開いた時の写しは保ったまま画面を作り直す）
        const before = this.session.before;
        layer.styles = null;
        this.changed();
        this.session = null;
        this.openStyles(layer);
        this.session.before = before;
      },
    });
  }

  // ---- テキスト
  /** layer = 直すテキストレイヤー。null なら at の位置に新しく作る */
  openText(layer, at = null) {
    const d = this.doc;
    const opts = LS.get('textOpts', { font: '', size: 64, bold: false, italic: false, align: 'left', line_spacing: 1.2 });
    let creating = false;
    if (!layer) {
      const before = d.snapshot();
      layer = new Layer(d.width, d.height, 'テキスト');
      layer.text = makeTextSpec('', at.x, at.y - opts.size * 0.5, { ...opts, color: this.app.fg });
      d.insertAbove(layer, d.active);
      d.activeId = layer.id;
      d.editingMask = false;
      this.begin('text', layer, 'テキストを追加');
      this.session.before = before;
      creating = true;
      d.emit('layers');
    } else this.begin('text', layer, 'テキストを編集');
    const v = { ...layer.text };
    const apply = () => {
      layer.text = { ...layer.text, ...v, size: Number(v.size), line_spacing: Number(v.line_spacing) };
      layer.canvas = renderTextSpec(layer.text, d.width, d.height);
      if (creating || layer._autoName) { layer.name = String(v.text).split('\n')[0].slice(0, 24) || 'テキスト'; layer._autoName = true; }
      this.changed();
      this.app.layersPanel.refreshThumbs();
    };
    this.session.onOk = () => { LS.set('textOpts', { font: v.font, size: v.size, bold: v.bold, italic: v.italic, align: v.align, line_spacing: v.line_spacing }); };
    const ta = el('textarea', { class: 'text-input', rows: 3, placeholder: '文字を入力' });
    ta.value = v.text;
    ta.addEventListener('input', () => { v.text = ta.value; apply(); });
    const fonts = FONT_CHOICES.some(([f]) => f === v.font) ? FONT_CHOICES : [[v.font, v.font], ...FONT_CHOICES];
    const fields = [
      { key: 'font', label: 'フォント', type: 'choice', choices: fonts },
      { key: 'size', label: '大きさ', type: 'int', min: 4, max: 1000, def: 64, suffix: 'px', curve: 2 },
      { key: 'color', label: '色', type: 'color' },
      { key: 'bold', label: '太字', type: 'bool' },
      { key: 'italic', label: '斜体', type: 'bool' },
      { key: 'align', label: '揃え', type: 'choice', choices: [['left', '左揃え'], ['center', '中央揃え'], ['right', '右揃え']] },
      { key: 'line_spacing', label: '行間', type: 'float', min: 0.5, max: 5, def: 1.2, digits: 2 },
    ];
    const body = el('div', {}, ta, ...fields.map((q) => paramField(q, v, apply).node));
    this.shell(creating ? '文字を入れる' : '文字を直す', body);
    if (creating) apply();
    setTimeout(() => { ta.focus(); }, 50);
  }
}

// ---- 文字ツール --------------------------------------------------------------------
class TextTool extends Tool {
  constructor(app) { super(app, 'text', '文字', {}); }
  spec() { return [{ type: 'note', text: 'タップした所に文字を入れる。文字をタップすると直せる（移動は移動ツールで）' }]; }
  needsLayer() { return false; }
  down(p) { this.p = p; }
  up(p) {
    if (!this.p) return;
    this.p = null;
    const d = this.doc;
    if (this.app.layerUI.open) { this.app.layerUI.ok(); return; }        // 入力中に外をタップ = 確定
    const hit = [...d.layers].reverse().find((l) => l.isText && l.visible && pointInQuad(p, textQuad(l.text)));
    if (hit) { d.setActive(hit); this.app.layerUI.openText(hit); }
    else this.app.layerUI.openText(null, p);
  }
  cancel() { this.p = null; }
}
