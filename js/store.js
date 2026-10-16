'use strict';
/* 作品の保存（IndexedDB "saikobo-web"）。
   works: {id, name, width, height, created, updated, thumb, bytes}
   data : {id, meta, files: {パス: 画像}}  meta は exe 版 .sko の document.json と同じ形
   画像は {type, buf: ArrayBuffer} で入れる（Blob のままだと iPad の Safari で
   「Error preparing Blob/File data」で保存に失敗することがある）。古い Blob の保存分も読める。 */

/** 保存用の形 ⇔ Blob */
async function packBlob(blob) { return { type: blob.type || 'image/png', buf: await blob.arrayBuffer() }; }
function unpackBlob(v) {
  if (!v) return null;
  if (v instanceof Blob) return v;
  return new Blob([v.buf], { type: v.type || 'image/png' });
}

const SKO_FORMAT_VERSION = 4;

const Store = {
  db: null,
  blobCache: new Map(),      // layer.id → {canvas, ver, packed}（変わっていないレイヤーは PNG を作り直さない）

  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const rq = indexedDB.open('saikobo-web', 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains('works')) db.createObjectStore('works', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('data')) db.createObjectStore('data', { keyPath: 'id' });
      };
      rq.onsuccess = () => {
        const db = rq.result;
        db.onclose = () => { if (this.db === db) this.db = null; };          // iOS は裏に回ると接続を切ることがある
        db.onversionchange = () => { db.close(); if (this.db === db) this.db = null; };
        this.db = db;
        res(db);
      };
      rq.onerror = () => rej(rq.error || new Error('保存領域を開けません'));
    });
  },
  /** 1回分の処理。接続が切れていたら開き直して1回だけやり直す */
  async tx(stores, mode, fn) {
    try { return await this._tx(stores, mode, fn); } catch (e) {
      if (e && (e.name === 'InvalidStateError' || e.name === 'UnknownError' || /connection|closing|lost/i.test(e.message || ''))) {
        try { this.db && this.db.close(); } catch { /* 閉じられなくてよい */ }
        this.db = null;
        return this._tx(stores, mode, fn);
      }
      throw e;
    }
  },
  _tx(stores, mode, fn) {
    return this.open().then((db) => new Promise((res, rej) => {
      let t;
      try { t = db.transaction(stores, mode); } catch (e) { rej(e); return; }
      let out, reqErr = null;
      t.oncomplete = () => res(out);
      t.onerror = (ev) => { reqErr = (ev && ev.target && ev.target.error) || reqErr; };
      t.onabort = () => {
        const e = t.error || reqErr;
        rej(e || new Error('保存が中断されました（容量不足の可能性）'));
      };
      try { out = fn(...stores.map((s) => t.objectStore(s))); } catch (e) { try { t.abort(); } catch { /* */ } rej(e); }
    }));
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },

  async list() {
    const all = await this.tx(['works'], 'readonly', (w) => this.req(w.getAll()));
    return (await all).sort((a, b) => b.updated - a.updated);
  },
  async getWork(id) { return this.tx(['works'], 'readonly', (w) => this.req(w.get(id))).then((p) => p); },

  newId() { return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); },

  /** 文書を保存する（画素が変わったレイヤーだけ PNG にし直す） */
  async saveDoc(doc, { fg, bg } = {}) {
    if (!doc.workId) doc.workId = this.newId();
    const meta = {
      format: 'saikobo', version: SKO_FORMAT_VERSION, width: doc.width, height: doc.height,
      active: null, layers: [], web: { fg, bg, saved: Date.now() },
    };
    const files = {};
    let bytes = 0;
    const packCached = async (key, canvas, ver, toPng) => {
      let c = this.blobCache.get(key);
      if (!c || c.canvas !== canvas || c.ver !== ver) {
        c = { canvas, ver, packed: await packBlob(await canvasToBlob(toPng ? toPng(canvas) : canvas)) };
        this.blobCache.set(key, c);
      }
      bytes += c.packed.buf.byteLength;
      return c.packed;
    };
    for (let i = 0; i < doc.layers.length; i++) {
      const l = doc.layers[i];
      const num = String(i).padStart(4, '0');
      const entry = { ...l.extra };
      for (const k of LAYER_PROPS) entry[k] = l[k];
      entry.id = l.id;
      entry.file = l.canvas ? `layers/${num}.png` : null;          // グループ・調整レイヤーは画素なし（exe と同じ）
      if (entry.file) files[entry.file] = await packCached(l.id, l.canvas, l.ver);
      if (l.mask) {                                                // マスクは exe と同じ灰色の PNG（白 = 見える）
        entry.mask_file = `masks/${num}.png`;
        files[entry.mask_file] = await packCached(l.id + ':m', l.mask, l.ver, maskToGray);
      }
      meta.layers.push(entry);
      if (l.id === doc.activeId) meta.active = i;
    }
    if (doc.sel) {
      files['selection.png'] = await packBlob(await canvasToBlob(maskToGray(doc.sel.canvas)));
      meta.selection = 'selection.png';
    }
    const thumb = await packBlob(await this.makeThumb(doc));
    const now = Date.now();
    const prev = await this.getWork(doc.workId);
    const work = {
      id: doc.workId, name: doc.name, width: doc.width, height: doc.height,
      created: prev ? prev.created : now, updated: now, thumb, bytes: bytes + thumb.buf.byteLength,
    };
    await this.tx(['works', 'data'], 'readwrite', (w, d) => {
      w.put(work);
      d.put({ id: doc.workId, meta, files });
    });
    return work;
  },
  async makeThumb(doc) {
    const flat = doc.flattened();
    const s = Math.min(1, 360 / Math.max(doc.width, doc.height));
    const c = newCanvas(Math.max(1, Math.round(doc.width * s)), Math.max(1, Math.round(doc.height * s)));
    const g = ctx2d(c);
    g.imageSmoothingQuality = 'high';
    g.drawImage(flat, 0, 0, c.width, c.height);
    return canvasToBlob(c);
  },

  async loadDoc(id) {
    const [work, data] = await this.tx(['works', 'data'], 'readonly', (w, d) => Promise.all([this.req(w.get(id)), this.req(d.get(id))]));
    if (!work || !data) throw new Error('作品が見つかりません');
    const files = {};
    for (const [k, v] of Object.entries(data.files || {})) files[k] = unpackBlob(v);
    const doc = await docFromMeta(data.meta, files, { name: work.name });
    doc.workId = id;
    for (const l of doc.layers) this.blobCache.delete(l.id);
    return { doc, web: data.meta.web || {} };
  },
  async remove(id) {
    await this.tx(['works', 'data'], 'readwrite', (w, d) => { w.delete(id); d.delete(id); });
  },
  async rename(id, name) {
    const work = await this.getWork(id);
    if (!work) return;
    work.name = name;
    await this.tx(['works'], 'readwrite', (w) => w.put(work));
  },
  async duplicate(id) {
    const [work, data] = await this.tx(['works', 'data'], 'readonly', (w, d) => Promise.all([this.req(w.get(id)), this.req(d.get(id))]));
    if (!work) return null;
    const nid = this.newId();
    const now = Date.now();
    await this.tx(['works', 'data'], 'readwrite', (w, d) => {
      w.put({ ...work, id: nid, name: work.name + ' のコピー', created: now, updated: now });
      d.put({ ...data, id: nid });
    });
    return nid;
  },
  async estimate() {
    try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
  },
};

/** document.json（.sko と同じ形）と PNG から文書を作る */
async function docFromMeta(meta, files, { name } = {}) {
  if (meta.format !== 'saikobo') throw new Error('彩工房のファイルではありません');
  if ((meta.version || 0) > SKO_FORMAT_VERSION) throw new Error('新しい版の彩工房で保存されたファイルです');
  const W = meta.width, H = meta.height;
  const doc = new Doc(W, H, { name: name || '名称未設定', empty: true });
  let maxId = 0;
  const idMap = new Map();
  for (let i = 0; i < meta.layers.length; i++) {
    const e = meta.layers[i];
    const kind = e.group ? 'group' : e.adjustment ? 'adjustment' : 'pixel';
    const l = new Layer(W, H, e.name || `レイヤー ${i + 1}`, null, { kind });
    if (kind === 'pixel' && e.file && files[e.file]) {
      const img = await blobToImage(files[e.file]);
      l.ctx.drawImage(img, 0, 0);
      if (img.close) img.close();
    }
    for (const k of LAYER_PROPS) if (k in e) l[k] = e[k];
    if (l.text) l.text = { ...TEXT_DEFAULTS, ...l.text };
    if (e.mask_file && files[e.mask_file]) l.mask = await maskFromImage(files[e.mask_file], W, H);
    const extra = {};
    for (const [k, v] of Object.entries(e)) {
      if (!LAYER_PROPS.includes(k) && !['id', 'file', 'mask_file'].includes(k) && v != null && v !== false) extra[k] = v;
    }
    l.extra = extra;
    idMap.set(e.id, l.id);
    maxId = Math.max(maxId, l.id);
    doc.layers.push(l);
    if (meta.active === i) doc.activeId = l.id;
  }
  for (const l of doc.layers) if (l.parent != null) l.parent = idMap.get(l.parent) ?? null;   // 保存時の id → 読み込んだ id
  if (!doc.layers.length) {
    const l = new Layer(W, H, '背景');
    doc.layers.push(l);
  }
  if (doc.activeId == null) doc.activeId = doc.layers[doc.layers.length - 1].id;
  if (meta.selection && files[meta.selection]) doc.sel = Sel.fromCanvas(await maskFromImage(files[meta.selection], W, H));
  bumpLayerId(maxId);
  doc.compDirty = doc.fullRect;
  doc.history.clear('開く');
  return doc;
}

/** マスク・選択範囲（白・アルファ）→ exe と同じ灰色の画像（白 = 見える） */
function maskToGray(m) {
  const c = newCanvas(m.width, m.height), g = ctx2d(c);
  g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(m, 0, 0);
  return c;
}
/** 灰色の画像（exe の L）も、白・アルファの画像（古い Web 版）も、マスク（白・アルファ）にする */
async function maskFromImage(blob, W, H) {
  const img = await blobToImage(blob);
  const c = newCanvas(W, H), g = ctx2d(c);
  g.drawImage(img, 0, 0);
  if (img.close) img.close();
  const data = g.getImageData(0, 0, W, H);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.min(d[i + 3], d[i]);
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = v;
  }
  g.putImageData(data, 0, 0);
  return c;
}

/** 画像ファイル → 文書（大きすぎれば縮める） */
async function docFromImageFile(file) {
  const img = await blobToImage(file);
  let w = img.width, h = img.height;
  let note = '';
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  if (s < 1) {
    note = `大きい画像なので ${w}×${h} → ${Math.round(w * s)}×${Math.round(h * s)} に縮めました`;
    w = Math.round(w * s); h = Math.round(h * s);
  }
  const name = (file.name || '写真').replace(/\.[^.]+$/, '') || '写真';
  const doc = new Doc(w, h, { name, background: null });
  doc.layers[0].name = '背景';
  const g = doc.layers[0].ctx;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, w, h);
  if (img.close) img.close();
  doc.history.clear('開く');
  return { doc, note };
}
