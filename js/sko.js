'use strict';
/* exe 版の作品ファイル .sko の読み書き。
   .sko = ZIP（無圧縮）: document.json ＋ layers/0000.png …（レイヤーの画素）＋ masks/0000.png …（灰色のマスク）
          ＋ selection.png（あれば）＋ composite.png（合成結果。exe の一覧用）。exe の core/fileio.py と同じ。 */

// ---- ZIP --------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
/** entries: [{name, data: Uint8Array}] → 無圧縮の ZIP（Blob） */
function zipStore(entries) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data), size = e.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);   // UTF-8 の名前
    lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, e.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
/** ZIP を読む → {名前: Blob}。無圧縮と deflate（ブラウザの DecompressionStream）に対応 */
async function unzip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP ではありません（.sko が壊れている可能性）');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = {};
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP の目次が読めません');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const loff = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const dstart = loff + 30 + dv.getUint16(loff + 26, true) + dv.getUint16(loff + 28, true);
    const raw = buf.subarray(dstart, dstart + csize);
    const type = name.endsWith('.png') ? 'image/png' : name.endsWith('.json') ? 'application/json' : '';
    if (method === 0) out[name] = new Blob([raw], { type });
    else if (method === 8) {
      if (!window.DecompressionStream) throw new Error('このブラウザでは圧縮された ZIP を開けません');
      const s = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out[name] = new Blob([await new Response(s).arrayBuffer()], { type });
    } else throw new Error('対応していない圧縮方式です（' + method + '）');
  }
  return out;
}

// ---- .sko ------------------------------------------------------------------------
async function canvasBytes(c) { return new Uint8Array(await (await canvasToBlob(c)).arrayBuffer()); }

/** 文書 → .sko（Blob）。exe の save_native と同じ中身 */
async function docToSko(doc) {
  const meta = { format: 'saikobo', version: SKO_FORMAT_VERSION, width: doc.width, height: doc.height, active: null, layers: [] };
  const entries = [];
  for (let i = 0; i < doc.layers.length; i++) {
    const l = doc.layers[i];
    const num = String(i).padStart(4, '0');
    const e = { ...l.extra };
    for (const k of LAYER_PROPS) e[k] = l[k];
    e.file = l.canvas ? `layers/${num}.png` : null;
    e.id = l.id;
    if (l.canvas) entries.push({ name: e.file, data: await canvasBytes(l.canvas) });
    if (l.mask) {
      e.mask_file = `masks/${num}.png`;
      entries.push({ name: e.mask_file, data: await canvasBytes(maskToGray(l.mask)) });
    }
    meta.layers.push(e);
    if (l.id === doc.activeId) meta.active = i;
  }
  if (doc.sel) {
    entries.push({ name: 'selection.png', data: await canvasBytes(maskToGray(doc.sel.canvas)) });
    meta.selection = 'selection.png';
  }
  entries.push({ name: 'composite.png', data: await canvasBytes(doc.flattened()) });
  const json = new TextEncoder().encode(JSON.stringify(meta, null, 1));
  return zipStore([{ name: 'document.json', data: json }, ...entries]);
}

/** .sko → 文書。exe が書いたものも Web 版が書いたものも読める */
async function docFromSko(blob, name) {
  const files = await unzip(blob);
  if (!files['document.json']) throw new Error('彩工房のファイルではありません（document.json がありません）');
  let meta;
  try { meta = JSON.parse(await files['document.json'].text()); } catch { throw new Error('document.json が読めません'); }
  const notes = [];
  for (const e of meta.layers || []) {
    if (e.adjustment && !ADJUSTMENTS[e.adjustment.key]) notes.push(`調整レイヤー「${e.name}」の種類（${e.adjustment.key}）は Web 版に無いので効きません`);
    if (e.styles) for (const k of Object.keys(e.styles)) if (!STYLE_SPECS[k]) notes.push(`「${e.name}」のスタイル ${k} は Web 版に無いので表示されません`);
    if (e.blend && BLEND[e.blend] && !BLEND[e.blend].exact) notes.push(`「${e.name}」の描画モード（${BLEND[e.blend].label}）は近い式で表示します`);
  }
  const doc = await docFromMeta(meta, files, { name });
  return { doc, notes: [...new Set(notes)] };
}

/** .sko の名前: 作品名 */
function skoName(fileName) { return (fileName || '作品').replace(/\.sko$/i, '') || '作品'; }
