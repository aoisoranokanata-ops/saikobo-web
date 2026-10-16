'use strict';
/* 共通の小道具: 矩形・色・canvas・トースト・ダイアログ・メニュー */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const IS_IOS = /iP(ad|hone|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const MOD_KEY = /Mac|iP/.test(navigator.platform) ? '⌘' : 'Ctrl+';

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

// ---- 矩形 {x, y, w, h}（整数） ----------------------------------------------------
const Rect = {
  make(x, y, w, h) { return { x, y, w, h }; },
  empty(r) { return !r || r.w <= 0 || r.h <= 0; },
  union(a, b) {
    if (Rect.empty(a)) return b ? { ...b } : null;
    if (Rect.empty(b)) return { ...a };
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  },
  intersect(a, b) {
    if (Rect.empty(a) || Rect.empty(b)) return null;
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  },
  /** 小数の範囲を外側の整数へ広げ、文書の内側に収める */
  clampTo(r, W, H, pad = 0) {
    if (!r) return null;
    const x0 = Math.max(0, Math.floor(r.x - pad)), y0 = Math.max(0, Math.floor(r.y - pad));
    const x1 = Math.min(W, Math.ceil(r.x + r.w + pad)), y1 = Math.min(H, Math.ceil(r.y + r.h + pad));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  },
  fromPoints(x0, y0, x1, y1) {
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  },
};

// ---- 色 --------------------------------------------------------------------------
const Color = {
  hexToRgb(hex) {
    let h = String(hex).trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(h)) return null;
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  },
  rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  },
  rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, mx ? d / mx : 0, mx];
  },
  hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  },
};

// ---- canvas ----------------------------------------------------------------------
function newCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
  return c;
}
function ctx2d(c) { return c.getContext('2d'); }
function cloneCanvas(src) {
  const c = newCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}
function canvasToBlob(c, type = 'image/png', quality) {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('画像を作れませんでした'))), type, quality));
}
async function blobToImage(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch (e) { /* 下の方法で */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}
let _checker = null;
function checkerPattern(ctx) {
  if (!_checker) {
    _checker = newCanvas(16, 16);
    const g = ctx2d(_checker);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#d6d6d6'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
  }
  return ctx.createPattern(_checker, 'repeat');
}
/** canvas の上限（iOS Safari は面積 16.7M 画素まで・全体のメモリにも上限がある） */
const MAX_SIDE = 4096;
const MAX_AREA = 16777216;
function sizeOk(w, h) { return w >= 1 && h >= 1 && w <= 8192 && h <= 8192 && w * h <= MAX_AREA; }

// ---- 小物 ------------------------------------------------------------------------
function debounce(fn, ms) {
  let t = 0;
  const f = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  f.flush = () => { clearTimeout(t); fn(); };
  f.cancel = () => clearTimeout(t);
  return f;
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function fmtDate(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const LS = {
  get(k, def) { try { const v = localStorage.getItem('saikobo-web.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('saikobo-web.' + k, JSON.stringify(v)); } catch { /* 保存できなくても動かす */ } },
};

// ---- トースト --------------------------------------------------------------------
let _toastTimer = 0;
function toast(msg, { error = false, ms = 2600 } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!error);
  t.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.hidden = true; }, error ? Math.max(ms, 4500) : ms);
}

// ---- ダイアログ（<dialog> 1枚を使い回す） ----------------------------------------
/**
 * fields: [{key, label, type:'number'|'text'|'select'|'check'|'range', value, min, max, step, options:[[v,l]], suffix}]
 * buttons: [{label, value, primary, danger}]  戻り値: {button, values} / キャンセルは null
 */
function openDialog({ title, message, fields = [], buttons, extra, onInput, init } = {}) {
  const dlg = $('#dlg'), form = $('#dlgForm');
  if (dlg.open) dlg.close();
  form.replaceChildren();
  if (title) form.append(el('h2', { class: 'dlg-title' }, title));
  if (message) form.append(el('p', { class: 'dlg-msg' }, message));
  const inputs = {};
  for (const f of fields) {
    let input;
    if (f.type === 'select') {
      input = el('select', { name: f.key });
      for (const [v, l] of f.options) input.append(el('option', { value: v, selected: String(v) === String(f.value) }, l));
    } else if (f.type === 'check') {
      input = el('input', { type: 'checkbox', name: f.key, checked: !!f.value });
    } else {
      input = el('input', {
        type: f.type || 'text', name: f.key, value: f.value ?? '', min: f.min, max: f.max, step: f.step,
        inputmode: f.type === 'number' ? 'decimal' : null, autocomplete: 'off',
      });
    }
    inputs[f.key] = input;
    const row = el('div', { class: 'dlg-row' });
    if (f.type === 'check') row.append(el('label', {}, input, ' ', f.label));
    else {
      row.append(el('label', {}, f.label), input);
      if (f.type === 'range') {
        const v = el('span', { class: 'val' }, String(f.value));
        input.addEventListener('input', () => { v.textContent = input.value + (f.suffix || ''); });
        v.textContent = f.value + (f.suffix || '');
        row.append(v);
      } else if (f.suffix) row.append(el('span', {}, f.suffix));
    }
    form.append(row);
  }
  if (extra) form.append(extra);
  const btns = el('div', { class: 'dlg-btns' });
  const list = buttons || [{ label: 'キャンセル', value: 'cancel' }, { label: 'OK', value: 'ok', primary: true }];
  for (const b of list) {
    btns.append(el('button', {
      class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), value: b.value, type: 'submit',
    }, b.label));
  }
  form.append(btns);
  const read = () => {
    const values = {};
    for (const f of fields) {
      const i = inputs[f.key];
      values[f.key] = f.type === 'check' ? i.checked : (f.type === 'number' || f.type === 'range') ? Number(i.value) : i.value;
    }
    return values;
  };
  if (onInput) form.addEventListener('input', () => onInput(read(), inputs));
  return new Promise((resolve) => {
    let pressed = null;
    form.onsubmit = (e) => { pressed = e.submitter ? e.submitter.value : 'ok'; };
    dlg.onclose = () => {
      const values = read();
      dlg.onclose = null;
      resolve(pressed && pressed !== 'cancel' ? { button: pressed, values } : null);
    };
    dlg.showModal();
    if (init) init(inputs);
    const first = fields.find((f) => f.type !== 'select' && f.type !== 'check' && f.type !== 'range');
    if (first && !IS_IOS) { inputs[first.key].focus(); inputs[first.key].select?.(); }
  });
}
async function confirmDialog(message, { title = '確認', ok = 'OK', danger = false } = {}) {
  const r = await openDialog({ title, message, buttons: [{ label: 'キャンセル', value: 'cancel' }, { label: ok, value: 'ok', primary: !danger, danger }] });
  return !!r;
}
async function promptDialog(title, value = '', label = '名前') {
  const r = await openDialog({ title, fields: [{ key: 'v', label, value }] });
  return r ? r.values.v : null;
}

// ---- メニュー（ボタンの下に出す） ------------------------------------------------
/** items: [{label, key, action, disabled, checked} | '-' | {head}] */
function openMenu(anchor, items, { onClose } = {}) {
  const layer = $('#menuLayer'), pop = $('#menuPop');
  pop.replaceChildren();
  pop.classList.remove('pop-custom');
  for (const it of items) {
    if (it === '-') { pop.append(el('div', { class: 'menu-sep' })); continue; }
    if (it.head) { pop.append(el('div', { class: 'menu-head' }, it.head)); continue; }
    const b = el('button', { class: 'menu-item', role: 'menuitem', disabled: !!it.disabled },
      el('span', { class: 'chk' }, it.checked ? '✓' : ''), el('span', { class: 'lbl' }, it.label), el('span', { class: 'key' }, it.key || ''));
    b.addEventListener('click', () => { close(); setTimeout(() => it.action && it.action(), 0); });
    pop.append(b);
  }
  layer.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = r.left, y = r.bottom + 4;
  if (x + pw > innerWidth - 8) x = Math.max(8, innerWidth - 8 - pw);
  if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 4);
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  anchor.classList.add('open');
  function close() {
    layer.hidden = true;
    anchor.classList.remove('open');
    layer.onpointerdown = null;
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose();
  }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  layer.onpointerdown = (e) => { if (e.target === layer) close(); };
  document.addEventListener('keydown', onKey, true);
  return close;
}

/** ボタンの下に任意の中身を出す（ペンの種類など）。戻り値は閉じる関数 */
function openPopover(anchor, content) {
  const layer = $('#menuLayer'), pop = $('#menuPop');
  pop.replaceChildren(content);
  pop.classList.add('pop-custom');
  layer.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = r.left, y = r.bottom + 4;
  if (x + pw > innerWidth - 8) x = Math.max(8, innerWidth - 8 - pw);
  if (y + ph > innerHeight - 8) y = Math.max(8, r.top - ph - 4);
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  const close = () => {
    layer.hidden = true;
    pop.classList.remove('pop-custom');
    layer.onpointerdown = null;
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  layer.onpointerdown = (e) => { if (e.target === layer) close(); };
  document.addEventListener('keydown', onKey, true);
  return close;
}

/** ダウンロード（iPad は共有シートを優先） */
async function saveBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.share && IS_IOS && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return 'shared'; } catch (e) {
      if (e && e.name === 'AbortError') return 'aborted';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
