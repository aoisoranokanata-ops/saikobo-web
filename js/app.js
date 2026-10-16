'use strict';
/* アプリ本体: 画面の切り替え・コマンド・メニュー・キーボード・自動保存 */

const APP_VERSION = '0.2.0';

class App {
  constructor() {
    this.settings = { fingerDraws: 'auto', ...LS.get('settings', {}) };
    this.fg = LS.get('fg', '#1a1a1a');
    this.bg = LS.get('bg', '#ffffff');
    this.recent = LS.get('recent', ['#1a1a1a', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa']);
    this.doc = null;
    this.screen = 'gallery';
    this.toolList = makeTools(this);
    this.tools = Object.fromEntries(this.toolList.filter(Boolean).map((t) => [t.name, t]));
    this.toolName = this.tools[LS.get('tool', 'brush')] ? LS.get('tool', 'brush') : 'brush';
    this.view = new View(this, $('#view'));
    this.layersPanel = new LayersPanel(this);
    this.colorPanel = new ColorPanel(this);
    this.adjust = new AdjustPanel(this);
    this.lastFilter = null;
    this.prevTool = null;
    this._scratch = {};
    this.clip = null;
    this.autosave = debounce(() => this.saveNow(), 1800);
    buildToolbar(this);
    this.selectTool(this.toolName);
    this.bindUI();
    this.bindKeys();
    $('#appVersion').textContent = 'v' + APP_VERSION;
  }

  get tool() { return this.tools[this.toolName]; }
  saveSettings() { const { _penNoticed, ...s } = this.settings; LS.set('settings', s); }

  /** 文書と同じ大きさの作業用 canvas（使い回す） */
  scratch(name) {
    const d = this.doc;
    let c = this._scratch[name];
    if (!c || c.width !== d.width || c.height !== d.height) {
      c = newCanvas(d.width, d.height);
      this._scratch[name] = c;
    }
    return c;
  }

  // ---- 色
  setFg(hex, { recent = true } = {}) {
    this.fg = hex.toLowerCase();
    LS.set('fg', this.fg);
    if (recent) this.addRecent(this.fg);
    updateToolbar(this);
    this.colorPanel.sync();
  }
  setBg(hex) {
    this.bg = hex.toLowerCase();
    LS.set('bg', this.bg);
    updateToolbar(this);
    this.colorPanel.sync();
  }
  swapColors() { const f = this.fg; this.fg = this.bg; this.setBg(f); this.setFg(this.fg, { recent: false }); }
  resetColors() { this.setBg('#ffffff'); this.setFg('#000000', { recent: false }); }
  addRecent(hex) {
    this.recent = [hex, ...this.recent.filter((c) => c !== hex)].slice(0, 16);
    LS.set('recent', this.recent);
    this.colorPanel.draw();
  }
  openColorTab(target) {
    this.colorPanel.target = target;
    this.showSide(true);
    this.showTab('color');
    this.colorPanel.sync();
  }

  // ---- ツール
  selectTool(name) {
    const next = this.tools[name];
    if (!next || this.view.mode === 'tool') return;
    const cur = this.tool;
    if (cur === next) { if (next.activate && !next.state && !next.rect && this.doc) next.activate(); updateToolbar(this); buildOptbar(this); return; }
    if (cur && cur.deactivate) cur.deactivate();
    if (next.activate && this.doc) {
      if (this.adjust.open) this.adjust.cancel();
      if (next.activate() === false) { updateToolbar(this); return; }
    }
    if (cur && !cur.activate) this.prevTool = cur.name;
    this.toolName = name;
    if (!next.activate) LS.set('tool', name);
    updateToolbar(this);
    buildOptbar(this);
    this.view.request();
  }
  /** 変形中・補正パネル表示中なら、ほかの操作の前に確定（変形）・取り消し（補正）する */
  settle({ commit = true } = {}) {
    if (this.adjust.open) this.adjust.cancel();
    const t = this.tool;
    if (t && t.state) { if (commit) t.commit(); else t.cancelAll(); }
  }
  cannotEdit(tool) {
    const d = this.doc;
    if (!d) return '作品が開かれていません';
    if (!tool.needsLayer()) return null;
    const l = d.active;
    if (!l) return 'レイヤーを選んでください';
    if (l.locked) return 'このレイヤーはロックされています（レイヤーパネルの「すべてロック」）';
    if (!l.visible) return '非表示のレイヤーには描けません';
    return null;
  }
  brushSize(dir) {
    const t = this.tool;
    if (!(t instanceof BrushTool)) return;
    const s = t.opts.size;
    const step = s < 10 ? 1 : s < 50 ? 5 : s < 200 ? 10 : 25;
    t.setOpt('size', clamp(s + dir * step, 1, 500));
    buildOptbar(this);
    this.view.request();
  }

  // ---- 画面
  showSide(on) {
    $('#editor').classList.toggle('side-hidden', !on);
    LS.set('side', on);
    setTimeout(() => this.view.resize(), 0);
  }
  showTab(name) {
    for (const b of $$('.side-tab')) b.classList.toggle('on', b.dataset.tab === name);
    for (const t of ['layers', 'color', 'history']) $('#tab-' + t).hidden = t !== name;
    if (name === 'color') this.colorPanel.sync();
    if (name === 'history') renderHistory(this);
    if (name === 'layers') this.layersPanel.render();
  }
  async showGallery() {
    if (this.doc) await this.closeDoc();
    this.screen = 'gallery';
    $('#editor').hidden = true;
    $('#gallery').hidden = false;
    await this.renderGallery();
  }
  openDoc(doc) {
    this.doc = doc;
    this._scratch = {};
    doc._savedRev = doc.workId ? doc.rev : -1;
    doc.on('*', (type, data) => this.onDocEvent(type, data));
    this.screen = 'editor';
    $('#gallery').hidden = true;
    $('#editor').hidden = false;
    $('#editor').classList.toggle('side-hidden', !LS.get('side', innerWidth > 760));
    $('#docTitle').textContent = doc.name;
    this.layersPanel.thumbs.clear();
    this.layersPanel.render();
    updateToolbar(this);
    buildOptbar(this);
    this.updateUndo();
    renderHistory(this);
    this.view._needFit = true;
    this.view.resize();
    this.view.fit();
    LS.set('lastWork', doc.workId);
    if (!doc.workId) this.saveNow();
  }
  async closeDoc() {
    this.settle({ commit: false });
    if (this.tool && this.tool.deactivate) { this.tool.deactivate(); this.toolName = this.prevTool || 'brush'; }
    this.autosave.cancel();
    await this.saveNow();
    this.doc = null;
    this._scratch = {};
    Store.blobCache.clear();
  }
  onDocEvent(type, data) {
    if (type === 'view') return;
    if (type === 'pixels' || type === 'live') {
      this.view.request();
      if (type === 'pixels') { this.layersPanel.refreshThumbs(); this.autosave(); }
      return;
    }
    if (type === 'structure') {
      this.view.request();
      this.layersPanel.render();
      if (data && data.resized) this.view.fit();
      this.autosave();
      return;
    }
    if (type === 'layers') { this.layersPanel.render(); return; }
    if (type === 'history') {
      this.updateUndo();
      renderHistory(this);
      this.layersPanel.updateProps();
      this.autosave();
    }
  }
  updateUndo() {
    const h = this.doc && this.doc.history;
    $('#btnUndo').disabled = !h || !h.canUndo;
    $('#btnRedo').disabled = !h || !h.canRedo;
  }
  hint(text) {
    const h = $('#hint');
    h.textContent = text;
    h.hidden = false;
    clearTimeout(this._hintT);
    this._hintT = setTimeout(() => { h.hidden = true; }, 1100);
  }
  undo() {
    if (!this.doc || this.view.mode === 'tool') return;
    if (this.adjust.open) { this.adjust.cancel(); return; }
    if (this.tool && this.tool.state) { this.tool.cancelAll(); this.hint('変形を取り消しました'); return; }
    const l = this.doc.history.undo();
    if (l) this.hint('取り消し: ' + l);
  }
  redo() {
    if (!this.doc || this.view.mode === 'tool') return;
    if (this.adjust.open || (this.tool && this.tool.state)) return;
    const l = this.doc.history.redo();
    if (l) this.hint('やり直し: ' + l);
  }

  // ---- 保存
  /** 保存は順番待ち（前の保存が終わってから）。戻り値は「この時点までの変更」が書き終わったら解決する */
  saveNow() {
    const doc = this.doc;
    if (!doc) return this._saveChain || Promise.resolve();
    this._saveChain = (this._saveChain || Promise.resolve()).then(() => this._save(doc));
    return this._saveChain;
  }
  isDirty(doc = this.doc) { return !!doc && doc.rev !== doc._savedRev; }
  async _save(doc) {
    if (!this.isDirty(doc) && doc.workId) return;
    const rev = doc.rev;
    try {
      await Store.saveDoc(doc, { fg: this.fg, bg: this.bg });
      doc._savedRev = rev;
      if (this.doc === doc) LS.set('lastWork', doc.workId);
    } catch (e) {
      console.error(e);
      toast('保存できませんでした: ' + (e && e.message ? e.message : e) + '\n（容量が足りない場合は、作品一覧から古い作品を書き出して削除してください）', { error: true });
    }
  }

  // ---- ギャラリー
  async renderGallery() {
    const grid = $('#galGrid');
    for (const u of this._thumbUrls || []) URL.revokeObjectURL(u);
    this._thumbUrls = [];
    let works = [];
    try { works = await Store.list(); } catch (e) { toast('保存領域を開けません: ' + e.message, { error: true }); }
    grid.replaceChildren();
    $('#galEmpty').hidden = works.length > 0;
    for (const w of works) {
      const url = w.thumb ? URL.createObjectURL(w.thumb) : '';
      if (url) this._thumbUrls.push(url);
      const more = el('button', { class: 'more', 'aria-label': 'その他' }, '⋯');
      const card = el('div', { class: 'work' },
        el('div', { class: 'thumb' }, url ? el('img', { src: url, alt: '' }) : null),
        el('div', { class: 'meta' }, el('span', { class: 'name' }, w.name), more),
        el('div', { class: 'sub' }, `${w.width}×${w.height} · ${fmtDate(w.updated)}`));
      card.addEventListener('click', (e) => { if (!e.target.closest('.more')) this.openWork(w.id); });
      more.addEventListener('click', () => this.workMenu(w, more));
      grid.append(card);
    }
    const est = await Store.estimate();
    $('#galStorage').textContent = est && est.usage != null ? `使用量 ${fmtBytes(est.usage)}` + (est.quota ? ` / 上限 約${fmtBytes(est.quota)}` : '') : '';
  }
  async openWork(id) {
    try {
      const { doc, web } = await Store.loadDoc(id);
      if (web.fg) this.setFg(web.fg, { recent: false });
      if (web.bg) this.setBg(web.bg);
      this.openDoc(doc);
    } catch (e) {
      console.error(e);
      toast('開けませんでした: ' + e.message, { error: true });
    }
  }
  workMenu(w, anchor) {
    openMenu(anchor, [
      { label: '開く', action: () => this.openWork(w.id) },
      { label: '名前を変更', action: async () => { const n = await promptDialog('作品名', w.name); if (n) { await Store.rename(w.id, n.trim() || w.name); this.renderGallery(); } } },
      { label: '複製', action: async () => { await Store.duplicate(w.id); this.renderGallery(); } },
      { label: 'PNG で書き出す', action: async () => {
        const { doc } = await Store.loadDoc(w.id);
        const blob = await canvasToBlob(doc.flattened());
        await saveBlob(blob, safeName(w.name) + '.png');
      } },
      '-',
      { label: '削除', action: async () => {
        if (await confirmDialog(`「${w.name}」を削除します。元に戻せません。`, { title: '作品の削除', ok: '削除', danger: true })) {
          await Store.remove(w.id);
          this.renderGallery();
        }
      } },
    ]);
  }
  async newWorkDialog() {
    const presets = [['iPad 画面', 2732, 2048], ['正方形', 2048, 2048], ['フル HD', 1920, 1080], ['A4 縦 (200dpi)', 1654, 2339], ['はがき (300dpi)', 1181, 1748], ['SNS 縦', 1080, 1350]];
    const box = el('div', { class: 'presets' });
    const r0 = openDialog({
      title: '新規作成',
      fields: [
        { key: 'name', label: '名前', value: '名称未設定' },
        { key: 'w', label: '幅', type: 'number', value: LS.get('newW', 2048), min: 1, max: 8192, suffix: 'px' },
        { key: 'h', label: '高さ', type: 'number', value: LS.get('newH', 1536), min: 1, max: 8192, suffix: 'px' },
        { key: 'bg', label: '背景', type: 'select', value: LS.get('newBg', 'white'), options: [['white', '白'], ['transparent', '透明'], ['bgcolor', '背景色']] },
      ],
      extra: box,
      buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: '作成', value: 'ok', primary: true }],
      init: (inputs) => {
        for (const [l, w, h] of presets) {
          box.append(el('button', { type: 'button', onclick: () => { inputs.w.value = w; inputs.h.value = h; } }, `${l} ${w}×${h}`));
        }
        box.append(el('button', { type: 'button', onclick: () => { const t = inputs.w.value; inputs.w.value = inputs.h.value; inputs.h.value = t; } }, '縦横を入れ替え'));
      },
    });
    const r = await r0;
    if (!r) return;
    const w = Math.round(r.values.w), h = Math.round(r.values.h);
    if (!sizeOk(w, h)) { toast('大きさは 1〜8192px、面積 1,677 万画素までにしてください', { error: true }); return; }
    if (Math.max(w, h) > MAX_SIDE && IS_IOS) toast('大きな作品は iPad のメモリを多く使います。レイヤーは少なめに', { ms: 4000 });
    LS.set('newW', w); LS.set('newH', h); LS.set('newBg', r.values.bg);
    const bg = r.values.bg === 'white' ? '#ffffff' : r.values.bg === 'bgcolor' ? this.bg : null;
    const doc = new Doc(w, h, { name: r.values.name.trim() || '名称未設定', background: bg });
    doc.history.clear('新規');
    this.openDoc(doc);
  }
  pickFile(accept = 'image/*') {
    return new Promise((resolve) => {
      const input = $('#fileInput');
      input.accept = accept;
      input.value = '';
      const done = () => { input.removeEventListener('change', on); resolve(input.files && input.files[0] ? input.files[0] : null); };
      const on = () => done();
      input.addEventListener('change', on);
      input.click();
    });
  }
  async newFromPhoto() {
    const file = await this.pickFile();
    if (!file) return;
    try {
      const { doc, note } = await docFromImageFile(file);
      if (this.doc) await this.closeDoc();
      this.openDoc(doc);
      if (note) toast(note, { ms: 4000 });
    } catch (e) {
      toast('画像を読み込めませんでした: ' + e.message, { error: true });
    }
  }

  // ---- 画像をレイヤーとして置く
  async placeImage(blobOrFile, name = '画像') {
    const d = this.doc;
    let img;
    try { img = await blobToImage(blobOrFile); } catch (e) { toast('画像を読み込めませんでした', { error: true }); return; }
    const s = Math.min(1, d.width / img.width, d.height / img.height);
    const w = img.width * s, h = img.height * s;
    const c = newCanvas(d.width, d.height);
    const g = ctx2d(c);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (d.width - w) / 2, (d.height - h) / 2, w, h);
    d.change('画像を配置', () => {
      const l = new Layer(d.width, d.height, name, c);
      d.layers.splice(d.indexOf(d.active) + 1, 0, l);
      d.activeId = l.id;
    });
    if (s < 1) toast('画像を作品の大きさに合わせて縮めました');
    this.selectTool('move');
  }

  // ---- コピー・貼り付け
  selectionContent(layer) {
    const d = this.doc;
    const b = d.sel ? d.sel.bounds : d.fullRect;
    const c = newCanvas(b.w, b.h);
    const g = ctx2d(c);
    g.drawImage(layer ? layer.canvas : d.flattened(), -b.x, -b.y);
    if (d.sel) { g.globalCompositeOperation = 'destination-in'; g.drawImage(d.sel.canvas, -b.x, -b.y); }
    return { canvas: c, x: b.x, y: b.y };
  }
  copy(merged = false) {
    const d = this.doc;
    if (!d) return;
    this.clip = this.selectionContent(merged ? null : d.active);
    toast(merged ? '結合部分をコピーしました' : 'コピーしました', { ms: 1200 });
    try {        // システムのクリップボードにも（できる環境だけ）
      if (navigator.clipboard && window.ClipboardItem) {
        navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToBlob(this.clip.canvas) })]).catch(() => {});
      }
    } catch { /* 無視 */ }
  }
  cut() {
    const d = this.doc;
    if (!d || this.cannotEdit(this.tools.brush)) { toast(this.cannotEdit(this.tools.brush) || '', { error: true }); return; }
    this.copy();
    this.clearSelection('切り取り');
  }
  paste() {
    const d = this.doc;
    if (!d || !this.clip) { toast('コピーした画像がありません'); return; }
    const { canvas, x, y } = this.clip;
    const c = newCanvas(d.width, d.height);
    const inside = x + canvas.width <= d.width && y + canvas.height <= d.height;
    ctx2d(c).drawImage(canvas, inside ? x : Math.round((d.width - canvas.width) / 2), inside ? y : Math.round((d.height - canvas.height) / 2));
    d.change('ペースト', () => {
      const l = new Layer(d.width, d.height, d.nextLayerName(), c);
      d.layers.splice(d.indexOf(d.active) + 1, 0, l);
      d.activeId = l.id;
    });
    this.selectTool('move');
  }
  clearSelection(label = '消去') {
    const d = this.doc;
    const l = d.active;
    const why = this.cannotEdit(this.tools.brush);
    if (why) { toast(why, { error: true }); return; }
    const rect = d.sel ? d.sel.bounds : d.fullRect;
    d.editPixels(label, l, rect, (g) => {
      if (l.alpha_locked) {
        g.globalCompositeOperation = 'source-atop';
        const tmp = this.selFilled(this.bg);
        g.drawImage(tmp, 0, 0);
      } else if (d.sel) {
        g.globalCompositeOperation = 'destination-out';
        g.drawImage(d.sel.canvas, 0, 0);
      } else g.clearRect(0, 0, d.width, d.height);
    });
  }
  /** 選択範囲（無ければ全体）を色で塗った canvas */
  selFilled(color) {
    const d = this.doc;
    const c = newCanvas(d.width, d.height), g = ctx2d(c);
    g.fillStyle = color;
    g.fillRect(0, 0, d.width, d.height);
    if (d.sel) { g.globalCompositeOperation = 'destination-in'; g.drawImage(d.sel.canvas, 0, 0); }
    return c;
  }
  fillSelection(color, label) {
    const d = this.doc, l = d.active;
    const why = this.cannotEdit(this.tools.brush);
    if (why) { toast(why, { error: true }); return; }
    const c = this.selFilled(color);
    d.editPixels(label, l, d.sel ? d.sel.bounds : d.fullRect, (g) => {
      g.globalCompositeOperation = l.alpha_locked ? 'source-atop' : 'source-over';
      g.drawImage(c, 0, 0);
    });
  }
  layerVia(cut) {
    const d = this.doc, l = d.active;
    if (!l) return;
    if (cut && l.locked) { toast('このレイヤーはロックされています', { error: true }); return; }
    const W = d.width, H = d.height;
    d.change(cut ? 'カットしたレイヤー' : 'コピーしたレイヤー', () => {
      const c = cloneCanvas(l.canvas);
      if (d.sel) {
        const g = ctx2d(c); g.globalCompositeOperation = 'destination-in'; g.drawImage(d.sel.canvas, 0, 0);
        if (cut) {
          const rest = cloneCanvas(l.canvas), rg = ctx2d(rest);
          rg.globalCompositeOperation = 'destination-out'; rg.drawImage(d.sel.canvas, 0, 0);
          l.canvas = rest;
        }
      } else if (cut) l.canvas = newCanvas(W, H);
      const nl = new Layer(W, H, cut ? l.name + '（カット）' : l.name + '（コピー）', c);
      d.layers.splice(d.indexOf(l) + 1, 0, nl);
      d.activeId = nl.id;
    });
  }
  /** 透明部分を除いた範囲で切り抜く */
  trim() {
    const d = this.doc;
    const flat = d.flattened();
    const b = alphaBounds(flat);
    if (!b) { toast('すべて透明です'); return; }
    if (b.w === d.width && b.h === d.height) { toast('切り抜く透明部分がありません'); return; }
    d.crop(b);
  }

  // ---- ダイアログ付きの操作
  async imageSizeDialog() {
    const d = this.doc;
    const ratio = d.width / d.height;
    const r = await openDialog({
      title: '画像解像度（拡大・縮小）',
      fields: [
        { key: 'w', label: '幅', type: 'number', value: d.width, min: 1, max: 8192, suffix: 'px' },
        { key: 'h', label: '高さ', type: 'number', value: d.height, min: 1, max: 8192, suffix: 'px' },
        { key: 'keep', label: '縦横比を固定', type: 'check', value: true },
      ],
      init: (inp) => {
        inp.w.addEventListener('input', () => { if (inp.keep.checked) inp.h.value = Math.max(1, Math.round(Number(inp.w.value) / ratio)); });
        inp.h.addEventListener('input', () => { if (inp.keep.checked) inp.w.value = Math.max(1, Math.round(Number(inp.h.value) * ratio)); });
      },
    });
    if (!r) return;
    const w = Math.round(r.values.w), h = Math.round(r.values.h);
    if (!sizeOk(w, h)) { toast('大きさが範囲外です（最大 8192px・1,677 万画素）', { error: true }); return; }
    if (w !== d.width || h !== d.height) d.resizeImage(w, h);
  }
  async canvasSizeDialog() {
    const d = this.doc;
    const anchors = [['0,0', '左上'], ['0.5,0', '上'], ['1,0', '右上'], ['0,0.5', '左'], ['0.5,0.5', '中央'], ['1,0.5', '右'], ['0,1', '左下'], ['0.5,1', '下'], ['1,1', '右下']];
    const r = await openDialog({
      title: 'カンバスサイズ',
      fields: [
        { key: 'w', label: '幅', type: 'number', value: d.width, min: 1, max: 8192, suffix: 'px' },
        { key: 'h', label: '高さ', type: 'number', value: d.height, min: 1, max: 8192, suffix: 'px' },
        { key: 'a', label: '基準位置', type: 'select', value: '0.5,0.5', options: anchors },
      ],
    });
    if (!r) return;
    const w = Math.round(r.values.w), h = Math.round(r.values.h);
    if (!sizeOk(w, h)) { toast('大きさが範囲外です', { error: true }); return; }
    const [ax, ay] = r.values.a.split(',').map(Number);
    if (w !== d.width || h !== d.height) d.resizeCanvas(w, h, ax, ay);
  }
  async selNumberDialog(title, label, def, fn) {
    const r = await openDialog({ title, fields: [{ key: 'v', label, type: 'number', value: LS.get('selnum.' + title, def), min: 1, max: 500, suffix: 'px' }] });
    if (!r) return;
    const v = clamp(Math.round(r.values.v) || 1, 1, 500);
    LS.set('selnum.' + title, v);
    const d = this.doc;
    d.setSelection(fn(v), title);
  }
  async exportDialog(fmt) {
    const d = this.doc;
    const fields = [{ key: 'scale', label: '大きさ', type: 'select', value: '1', options: [['1', '100%（原寸）'], ['0.5', '50%'], ['0.25', '25%'], ['2', '200%']] }];
    if (fmt === 'jpeg') fields.push({ key: 'q', label: '画質', type: 'range', value: 90, min: 30, max: 100, suffix: '' });
    const r = await openDialog({ title: fmt === 'png' ? 'PNG で書き出し' : 'JPEG で書き出し', fields,
      message: IS_IOS ? '共有シートが開きます。「画像を保存」で写真に、「ファイルに保存」でファイルに入ります。' : '',
      buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: '書き出す', value: 'ok', primary: true }] });
    if (!r) return;
    const s = Number(r.values.scale);
    let c = d.flattened({ background: fmt === 'jpeg' ? '#ffffff' : null });
    if (s !== 1) {
      const w = Math.max(1, Math.round(d.width * s)), h = Math.max(1, Math.round(d.height * s));
      if (!sizeOk(w, h)) { toast('大きすぎて書き出せません', { error: true }); return; }
      const c2 = newCanvas(w, h), g = ctx2d(c2);
      g.imageSmoothingQuality = 'high';
      g.drawImage(c, 0, 0, w, h);
      c = c2;
    }
    const blob = await canvasToBlob(c, fmt === 'png' ? 'image/png' : 'image/jpeg', fmt === 'jpeg' ? r.values.q / 100 : undefined);
    const res = await saveBlob(blob, safeName(d.name) + (fmt === 'png' ? '.png' : '.jpg'));
    if (res === 'downloaded') toast('書き出しました');
  }

  // ---- コマンド
  cmd(name) {
    const d = this.doc;
    const C = {
      'file.new': () => this.newWorkDialog(),
      'file.photo': () => this.newFromPhoto(),
      'file.place': async () => { const f = await this.pickFile(); if (f) this.placeImage(f, (f.name || '画像').replace(/\.[^.]+$/, '')); },
      'file.png': () => this.exportDialog('png'),
      'file.jpeg': () => this.exportDialog('jpeg'),
      'file.rename': async () => { const n = await promptDialog('作品名', d.name); if (n && n.trim()) { d.name = n.trim(); $('#docTitle').textContent = d.name; d.emit('meta'); this.saveNow(); } },
      'file.duplicate': async () => { await this.saveNow(); const id = await Store.duplicate(d.workId); if (id) { await this.closeDoc(); this.openWork(id); toast('複製を開きました'); } },
      'file.save': () => this.saveNow().then(() => toast('保存しました', { ms: 1000 })),
      'file.gallery': () => this.showGallery(),
      'edit.undo': () => this.undo(),
      'edit.redo': () => this.redo(),
      'edit.cut': () => this.cut(),
      'edit.copy': () => this.copy(false),
      'edit.copyMerged': () => this.copy(true),
      'edit.paste': () => this.paste(),
      'edit.clear': () => this.clearSelection(),
      'edit.fillFg': () => this.fillSelection(this.fg, '塗りつぶし（描画色）'),
      'edit.fillBg': () => this.fillSelection(this.bg, '塗りつぶし（背景色）'),
      'edit.transform': () => this.selectTool('transform'),
      'image.cropTool': () => this.selectTool('crop'),
      'filter.last': () => { if (this.lastFilter) this.adjust.applyNow(findSpec(this.lastFilter.key), this.lastFilter.params); else toast('まだフィルターを使っていません'); },
      'image.size': () => this.imageSizeDialog(),
      'image.canvas': () => this.canvasSizeDialog(),
      'image.rot90': () => d.rotate(90),
      'image.rot270': () => d.rotate(270),
      'image.rot180': () => d.rotate(180),
      'image.flipH': () => d.flip(true),
      'image.flipV': () => d.flip(false),
      'image.crop': () => { if (d.sel) d.crop(d.sel.bounds); else toast('先に範囲を選択してください'); },
      'image.trim': () => this.trim(),
      'image.flatten': () => d.flatten(),
      'layer.new': () => d.addLayer(),
      'layer.duplicate': () => d.duplicateLayer(),
      'layer.delete': () => { if (!d.deleteLayer()) toast('最後のレイヤーは削除できません'); },
      'layer.rename': async () => { const l = d.active; const n = await promptDialog('レイヤー名', l.name); if (n && n.trim() && n.trim() !== l.name) d.setLayerProps(l, { name: n.trim() }, 'レイヤー名の変更'); },
      'layer.up': () => d.moveLayer(d.active, d.indexOf(d.active) + 1),
      'layer.down': () => d.moveLayer(d.active, d.indexOf(d.active) - 1),
      'layer.top': () => d.moveLayer(d.active, d.layers.length - 1),
      'layer.bottom': () => d.moveLayer(d.active, 0),
      'layer.mergeDown': () => { if (!d.mergeDown()) toast('下にレイヤーがありません'); },
      'layer.mergeVisible': () => d.flatten({ visibleOnly: true }),
      'layer.viaCopy': () => this.layerVia(false),
      'layer.viaCut': () => this.layerVia(true),
      'layer.flipH': () => d.flipLayer(d.active, true),
      'layer.flipV': () => d.flipLayer(d.active, false),
      'select.all': () => d.setSelection(Sel.all(d.width, d.height), 'すべてを選択'),
      'select.none': () => d.setSelection(null, '選択を解除'),
      'select.invert': () => { if (d.sel) d.setSelection(Sel.invert(d.sel, d.width, d.height), '選択範囲を反転'); },
      'select.feather': () => this.selNumberDialog('境界をぼかす', 'ぼかしの半径', 8, (v) => Sel.feather(d.sel, v, d.width, d.height)),
      'select.grow': () => this.selNumberDialog('選択範囲を拡張', '拡張量', 4, (v) => Sel.grow(d.sel, v, d.width, d.height)),
      'select.shrink': () => this.selNumberDialog('選択範囲を縮小', '縮小量', 4, (v) => Sel.grow(d.sel, -v, d.width, d.height)),
      'select.layerAlpha': () => {
        const c = cloneCanvas(d.active.canvas);
        const g = ctx2d(c); g.globalCompositeOperation = 'source-in'; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        d.setSelection(Sel.fromCanvas(c), '不透明部分を選択');
      },
      'view.fit': () => this.view.fit(),
      'view.actual': () => this.view.actualSize(),
      'view.zoomIn': () => this.view.zoomStep(1),
      'view.zoomOut': () => this.view.zoomStep(-1),
      'view.side': () => this.showSide($('#editor').classList.contains('side-hidden')),
    };
    let fn = C[name];
    if (!fn && name.startsWith('adj.')) fn = () => this.adjust.start(name.slice(4));
    if (!fn) { console.warn('unknown command', name); return; }
    if (!d && !name.startsWith('file.new') && name !== 'file.photo') return;
    if (!name.startsWith('view.') && name !== 'edit.undo' && name !== 'edit.redo') this.settle();
    try {
      const r = fn();
      if (r && r.catch) r.catch((e) => { console.error(e); toast('エラー: ' + e.message, { error: true }); });
    } catch (e) {
      console.error(e);
      toast('エラー: ' + e.message, { error: true });
    }
  }
  menuItems(name) {
    const d = this.doc;
    const M = MOD_KEY;
    const hasSel = !!(d && d.sel);
    const it = (label, cmd, key, extra = {}) => ({ label, key, action: () => this.cmd(cmd), ...extra });
    switch (name) {
      case 'file': return [
        it('新規…', 'file.new'), it('写真から新しい作品…', 'file.photo'), '-',
        it('画像をレイヤーとして配置…', 'file.place'), '-',
        it('PNG で書き出し…', 'file.png'), it('JPEG で書き出し…', 'file.jpeg'), '-',
        it('作品名を変更…', 'file.rename'), it('作品を複製', 'file.duplicate'), it('今すぐ保存', 'file.save', M + 'S'), '-',
        it('作品一覧へ', 'file.gallery'),
      ];
      case 'edit': return [
        it('取り消し', 'edit.undo', M + 'Z', { disabled: !d.history.canUndo }),
        it('やり直し', 'edit.redo', '⇧' + M + 'Z', { disabled: !d.history.canRedo }), '-',
        it('切り取り', 'edit.cut', M + 'X'), it('コピー', 'edit.copy', M + 'C'), it('結合部分をコピー', 'edit.copyMerged', '⇧' + M + 'C'),
        it('ペースト', 'edit.paste', M + 'V', { disabled: !this.clip }), it('消去', 'edit.clear', 'Delete'), '-',
        it('描画色で塗りつぶし', 'edit.fillFg', '⌥⌫'), it('背景色で塗りつぶし', 'edit.fillBg', M + '⌫'), '-',
        it('自由変形', 'edit.transform', M + 'T'),
      ];
      case 'image': return [
        it('画像解像度（拡大・縮小）…', 'image.size'), it('カンバスサイズ…', 'image.canvas'), '-',
        it('90° 回転（時計回り）', 'image.rot90'), it('90° 回転（反時計回り）', 'image.rot270'), it('180° 回転', 'image.rot180'),
        it('左右反転', 'image.flipH'), it('上下反転', 'image.flipV'), '-',
        it('切り抜きツール', 'image.cropTool', 'C'), it('選択範囲で切り抜き', 'image.crop', '', { disabled: !hasSel }), it('透明部分を切り抜き', 'image.trim'), '-',
        it('画像を統合', 'image.flatten'),
      ];
      case 'adjust': {
        const keys = { levels: M + 'L', curves: M + 'M', hue_saturation: M + 'U', color_balance: M + 'B', invert: M + 'I', desaturate: '⇧' + M + 'U', auto_tone: '⇧' + M + 'L' };
        const order = [['brightness_contrast', 'levels', 'curves', 'exposure'], ['vibrance', 'hue_saturation', 'color_balance', 'color_temperature', 'black_white', 'photo_filter'],
          ['invert', 'desaturate', 'posterize', 'threshold'], ['auto_tone', 'auto_contrast']];
        const out = [];
        order.forEach((grp, i) => {
          if (i) out.push('-');
          for (const k of grp) out.push(it(ADJUSTMENTS[k].label + (ADJUSTMENTS[k].noDialog ? '' : '…'), 'adj.' + k, keys[k] || ''));
        });
        return out;
      }
      case 'filter': {
        const out = [it('前回のフィルター' + (this.lastFilter ? `（${findSpec(this.lastFilter.key).label}）` : ''), 'filter.last', '⌥' + M + 'F', { disabled: !this.lastFilter })];
        let group = null;
        for (const s of Object.values(FILTERS)) {
          if (s.group !== group) { out.push('-'); out.push({ head: s.group }); group = s.group; }
          out.push(it(s.label + (s.noDialog ? '' : '…'), 'adj.' + s.key));
        }
        return out;
      }
      case 'layer': return [
        it('新規レイヤー', 'layer.new', '⇧' + M + 'N'), it('レイヤーを複製', 'layer.duplicate'), it('レイヤーを削除', 'layer.delete'),
        it('名前を変更…', 'layer.rename'), '-',
        it('選択範囲をコピーしたレイヤー', 'layer.viaCopy', M + 'J'), it('選択範囲をカットしたレイヤー', 'layer.viaCut', '⇧' + M + 'J'), '-',
        it('下のレイヤーと結合', 'layer.mergeDown', M + 'E'), it('表示レイヤーを結合', 'layer.mergeVisible', '⇧' + M + 'E'), '-',
        it('最前面へ', 'layer.top'), it('前面へ', 'layer.up', M + ']'), it('背面へ', 'layer.down', M + '['), it('最背面へ', 'layer.bottom'), '-',
        it('レイヤーを左右反転', 'layer.flipH'), it('レイヤーを上下反転', 'layer.flipV'),
      ];
      case 'select': return [
        it('すべてを選択', 'select.all', M + 'A'), it('選択を解除', 'select.none', M + 'D', { disabled: !hasSel }),
        it('選択範囲を反転', 'select.invert', '⇧' + M + 'I', { disabled: !hasSel }), '-',
        it('境界をぼかす…', 'select.feather', '', { disabled: !hasSel }),
        it('選択範囲を拡張…', 'select.grow', '', { disabled: !hasSel }), it('選択範囲を縮小…', 'select.shrink', '', { disabled: !hasSel }), '-',
        it('レイヤーの不透明部分を選択', 'select.layerAlpha'),
      ];
      case 'view': {
        const fd = this.settings.fingerDraws;
        const setFd = (v, msg) => () => { this.settings.fingerDraws = v; this.saveSettings(); toast(msg); };
        return [
          it('画面に合わせる', 'view.fit', M + '0'), it('100%（実際の大きさ）', 'view.actual', M + '1'),
          it('ズームイン', 'view.zoomIn', M + '+'), it('ズームアウト', 'view.zoomOut', M + '−'), '-',
          { head: '指での操作' },
          { label: '指でも描く（Pencil を使ったら切り替え）', checked: fd === 'auto', action: setFd('auto', '指でも描きます（Apple Pencil を使ったら自動で切り替え）') },
          { label: '指でも描く（常に）', checked: fd === true, action: setFd(true, '指でも描きます') },
          { label: '指では描かない（1本指で移動）', checked: fd === false, action: setFd(false, '指では描きません（1本指 = 画面の移動）') },
          '-',
          it('パネルの表示切替', 'view.side'),
        ];
      }
    }
    return [];
  }

  // ---- 画面の部品をつなぐ
  bindUI() {
    $('#galNew').addEventListener('click', () => this.cmd('file.new'));
    $('#galPhoto').addEventListener('click', () => this.cmd('file.photo'));
    $('#galMenu').addEventListener('click', (e) => openMenu(e.currentTarget, [
      { label: '保存領域を確保する（消されにくくする）', action: async () => {
        const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
        toast(ok ? '作品が消されにくい設定になりました' : 'このブラウザでは設定できませんでした（ホーム画面に追加すると消されにくくなります）');
      } },
      { label: `彩工房 Web v${APP_VERSION} について`, action: () => openDialog({
        title: '彩工房 Web', message: `v${APP_VERSION}\niPad 向けの画像編集アプリ（exe 版のモバイル版）。\n作品はこの端末のブラウザの中に保存されます。\n大事な作品は書き出しておいてください。\n\n2本指タップ = 取り消し、3本指タップ = やり直し、2本指でつまむ = 拡大縮小・移動`,
        buttons: [{ label: '閉じる', value: 'ok', primary: true }] }) },
    ]));
    $('#btnBack').addEventListener('click', () => this.showGallery());
    $('#btnUndo').addEventListener('click', () => this.undo());
    $('#btnRedo').addEventListener('click', () => this.redo());
    $('#btnSide').addEventListener('click', () => this.cmd('view.side'));
    for (const b of $$('#menubar [data-menu]')) b.addEventListener('click', () => { if (this.doc) openMenu(b, this.menuItems(b.dataset.menu)); });
    for (const b of $$('.side-tab')) b.addEventListener('click', () => this.showTab(b.dataset.tab));
    for (const b of $$('.layer-btns [data-cmd]')) b.addEventListener('click', () => this.cmd(b.dataset.cmd));
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.isDirty()) this.saveNow(); });
    window.addEventListener('pagehide', () => { if (this.isDirty()) this.saveNow(); });
    document.addEventListener('paste', (e) => {
      if (!this.doc || this.isTyping(e)) return;
      const f = [...(e.clipboardData ? e.clipboardData.files : [])].find((x) => x.type.startsWith('image/'));
      if (f) { e.preventDefault(); this.placeImage(f, '貼り付けた画像'); }
      else if (this.clip) { e.preventDefault(); this.paste(); }
    });
    // ファイルを落としたら配置（PC 用）
    $('#viewport').addEventListener('dragover', (e) => e.preventDefault());
    $('#viewport').addEventListener('drop', (e) => {
      e.preventDefault();
      const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
      if (f && this.doc) this.placeImage(f, f.name.replace(/\.[^.]+$/, ''));
    });
  }
  isTyping(e) {
    const t = e.target;
    return $('#dlg').open || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
  }
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (this.isTyping(e) || !this.doc || this.screen !== 'editor') return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const run = (c) => { e.preventDefault(); this.cmd(c); };
      if (k === ' ') { if (!this.view.spaceDown) { this.view.spaceDown = true; this.view.canvas.style.cursor = 'grab'; } e.preventDefault(); return; }
      if (mod) {
        if (k === 'z') return run(e.shiftKey ? 'edit.redo' : 'edit.undo');
        if (k === 't') return run('edit.transform');
        if (k === 'l') return run(e.shiftKey ? 'adj.auto_tone' : 'adj.levels');
        if (k === 'm') return run('adj.curves');
        if (k === 'u') return run(e.shiftKey ? 'adj.desaturate' : 'adj.hue_saturation');
        if (k === 'b') return run('adj.color_balance');
        if (k === 'i' && !e.shiftKey) return run('adj.invert');
        if (k === 'f' && e.altKey) return run('filter.last');
        if (k === 'y') return run('edit.redo');
        if (k === 'a') return run('select.all');
        if (k === 'd') return run('select.none');
        if (k === 'i' && e.shiftKey) return run('select.invert');
        if (k === 'c') return run(e.shiftKey ? 'edit.copyMerged' : 'edit.copy');
        if (k === 'x') return run('edit.cut');
        if (k === 'v') return;                 // paste イベントで扱う
        if (k === 'j') return run(e.shiftKey ? 'layer.viaCut' : 'layer.viaCopy');
        if (k === 'e') return run(e.shiftKey ? 'layer.mergeVisible' : 'layer.mergeDown');
        if (k === 'n' && e.shiftKey) return run('layer.new');
        if (k === 's') return run('file.save');
        if (k === '0') return run('view.fit');
        if (k === '1') return run('view.actual');
        if (k === '=' || k === '+' || k === ';') return run('view.zoomIn');
        if (k === '-') return run('view.zoomOut');
        if (k === ']') return run('layer.up');
        if (k === '[') return run('layer.down');
        if (k === 'Backspace') return run('edit.fillBg');
        return;
      }
      if (e.altKey && (k === 'Backspace' || k === 'Delete')) return run('edit.fillFg');
      if (k === 'Delete' || k === 'Backspace') return run('edit.clear');
      if (k === '[') { e.preventDefault(); this.brushSize(-1); return; }
      if (k === ']') { e.preventDefault(); this.brushSize(1); return; }
      if (k === 'x') { this.swapColors(); return; }
      if (k === 'd') { this.resetColors(); return; }
      if (k === 'Escape') {
        if (this.view.mode === 'tool') this.view.cancelTool();
        else if (this.adjust.open) this.adjust.cancel();
        else if (this.tool.state) this.tool.cancelAll();
        return;
      }
      if (k === 'Enter') {
        if (this.adjust.open) { e.preventDefault(); this.adjust.ok(); return; }
        if (this.tool.state) { e.preventDefault(); this.tool.commit(); return; }
        if (this.toolName === 'crop') { e.preventDefault(); this.tool.commit(); return; }
        return;
      }
      if (k.startsWith('Arrow') && this.toolName === 'move') {
        e.preventDefault();
        const s = e.shiftKey ? 10 : 1;
        const dx = k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0;
        const dy = k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0;
        this.tools.move.nudge(dx, dy);
        return;
      }
      const map = { c: 'crop', v: 'move', m: 'marquee_rect', l: 'lasso', w: 'wand', b: 'brush', e: 'eraser', g: 'fill', i: 'eyedropper', h: 'hand', z: 'zoom' };
      if (map[k]) {
        if (k === 'm' && this.toolName === 'marquee_rect') return this.selectTool('marquee_ellipse');
        if (k === 'g' && this.toolName === 'fill') return this.selectTool('gradient');
        this.selectTool(map[k]);
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ') { this.view.spaceDown = false; this.view.canvas.style.cursor = ''; }
    });
  }
}

function safeName(s) { return String(s || '作品').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80); }

// ---- 起動 ------------------------------------------------------------------------
let app;
window.addEventListener('DOMContentLoaded', async () => {
  app = new App();
  window.app = app;
  await app.renderGallery();
  registerSW();
});

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (location.protocol === 'file:' || (local && !/[?&]sw=1/.test(location.search))) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('sw', e));
}
