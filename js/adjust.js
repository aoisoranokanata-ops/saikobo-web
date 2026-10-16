'use strict';
/* 色調補正とフィルター（exe 版 core/adjust.py と同じキー・同じ引数）。
   どれも fn(src: Uint8ClampedArray RGBA, w, h, params) → 新しい Uint8ClampedArray。
   フェーズ3の調整レイヤーもこの表を使う（.sko の adjustment: {key, params} と同じ形）。 */

// ---- 道具 ------------------------------------------------------------------------
function rgbLut(src, lr, lg = lr, lb = lr) {
  const out = new Uint8ClampedArray(src.length);
  const R = Uint8ClampedArray.from(lr), G = Uint8ClampedArray.from(lg), B = Uint8ClampedArray.from(lb);     // Uint8ClampedArray は代入時に四捨五入する（+0.5 は不要）
  for (let i = 0; i < src.length; i += 4) {
    out[i] = R[src[i]]; out[i + 1] = G[src[i + 1]]; out[i + 2] = B[src[i + 2]]; out[i + 3] = src[i + 3];
  }
  return out;
}
const range256 = () => Float32Array.from({ length: 256 }, (_, i) => i);
function channelLut(lut, channel) {
  if (channel === 'rgb') return [lut, lut, lut];
  const id = range256();
  return ['red', 'green', 'blue'].map((c) => (c === channel ? lut : id));
}
function eachRGB(src, fn) {        // fn(r, g, b, i) → [r, g, b]（浮動小数でよい）
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const v = fn(src[i], src[i + 1], src[i + 2], i);
    out[i] = v[0]; out[i + 1] = v[1]; out[i + 2] = v[2]; out[i + 3] = src[i + 3];
  }
  return out;
}
const lum = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114;
function premul(src) {
  const f = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] / 255;
    f[i] = src[i] * a; f[i + 1] = src[i + 1] * a; f[i + 2] = src[i + 2] * a; f[i + 3] = src[i + 3];
  }
  return f;
}
function unpremul(f) {
  const out = new Uint8ClampedArray(f.length);
  for (let i = 0; i < f.length; i += 4) {
    const a = f[i + 3];
    if (a <= 0.5) continue;
    const k = 255 / a;
    out[i] = f[i] * k; out[i + 1] = f[i + 1] * k; out[i + 2] = f[i + 2] * k; out[i + 3] = a;
  }
  return out;
}
/** 1 チャンネルずつ箱型ぼかし（端は折り返し）。f は Float32Array（ch 本のチャンネルが交互） */
function boxBlurCh(f, w, h, ch, r, horizontal) {
  const n = horizontal ? w : h, lines = horizontal ? h : w;
  r = Math.min(Math.round(r), n - 1);
  if (r < 1) return;
  const line = new Float32Array(n), outLine = new Float32Array(n);
  const win = 2 * r + 1;
  const refl = (i) => (i < 0 ? -i - 1 : i >= n ? 2 * n - i - 1 : i);     // r < n なので1回の折り返しで足りる
  for (let c = 0; c < ch; c++) {
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < n; i++) line[i] = f[((horizontal ? l * w + i : i * w + l) * ch) + c];
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += line[refl(i)];
      for (let i = 0; i < n; i++) {
        outLine[i] = acc / win;
        acc += line[refl(i + r + 1)] - line[refl(i - r)];
      }
      for (let i = 0; i < n; i++) f[((horizontal ? l * w + i : i * w + l) * ch) + c] = outLine[i];
    }
  }
}
/** ガウスぼかしの近似（箱型3回）。sigma = 半径（exe 版と同じ意味） */
function gaussBlurF(f, w, h, ch, sigma) {
  if (sigma <= 0) return f;
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  for (let i = 0; i < n; i++) {
    const r = ((i < m ? wl : wu) - 1) / 2;
    boxBlurCh(f, w, h, ch, r, true);
    boxBlurCh(f, w, h, ch, r, false);
  }
  return f;
}
function rgbFloat(src) {
  const f = new Float32Array((src.length / 4) * 3);
  for (let i = 0, j = 0; i < src.length; i += 4, j += 3) { f[j] = src[i]; f[j + 1] = src[i + 1]; f[j + 2] = src[i + 2]; }
  return f;
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hexRgb(hex) { return Color.hexToRgb(hex) || [0, 0, 0]; }

// HLS（OpenCV の HLS_FULL と同じ尺度: H 0..256, L 0..255, S 0..255）
function rgbToHls(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0, s = 0;
  const d = mx - mn;
  if (d > 1e-6) {
    s = l < 0.5 ? d / (mx + mn) : d / (2 - mx - mn);
    if (mx === r) h = (g - b) / d; else if (mx === g) h = 2 + (b - r) / d; else h = 4 + (r - g) / d;
    h = (h * 60 + 360) % 360;
  }
  return [h / 360 * 256, l * 255, s * 255];
}
function hlsToRgb(h, l, s) {
  h = ((h / 256) * 360 + 360) % 360; l /= 255; s /= 255;
  if (s <= 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 360) % 360; return t < 60 ? p + (q - p) * t / 60 : t < 180 ? q : t < 240 ? p + (q - p) * (240 - t) / 60 : p; };
  return [f(h + 120) * 255, f(h) * 255, f(h - 120) * 255];
}

/** 制御点を通る単調な曲線（exe と同じ Fritsch–Carlson） */
function curveLut(points) {
  const map = new Map();
  for (const p of points || []) map.set(Math.round(p[0]), Number(p[1]));
  const pts = [...map.entries()].sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return range256();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const n = xs.length;
  const d = []; for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(xs[i + 1] - xs[i], 1e-9));
  const m = new Array(n).fill(0);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  const out = new Float32Array(256);
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) { out[x] = ys[0]; continue; }
    if (x >= xs[n - 1]) { out[x] = ys[n - 1]; continue; }
    let i = 0; while (x > xs[i + 1]) i++;
    const hh = xs[i + 1] - xs[i], t = (x - xs[i]) / hh;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1, h10 = t ** 3 - 2 * t ** 2 + t, h01 = -2 * t ** 3 + 3 * t ** 2, h11 = t ** 3 - t ** 2;
    out[x] = clamp(h00 * ys[i] + h10 * hh * m[i] + h01 * ys[i + 1] + h11 * hh * m[i + 1], 0, 255);
  }
  return out;
}
function percentile(hist, total, q) {
  const target = total * q / 100;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
  return 255;
}

// ---- 色調補正 --------------------------------------------------------------------
const AdjFns = {
  brightness_contrast(src, w, h, p) {
    const k = p.contrast >= 0 ? 1 + p.contrast / 100 * 1.5 : 1 + p.contrast / 100;
    const e = 1 / Math.pow(2, p.brightness / 150 * 1.2);
    const lut = Float32Array.from({ length: 256 }, (_, i) => (255 * Math.pow(i / 255, e) - 127.5) * k + 127.5);
    return rgbLut(src, lut);
  },
  levels(src, w, h, p) {
    const inW = Math.max(p.in_white, p.in_black + 1);
    const lut = Float32Array.from({ length: 256 }, (_, x) => {
      const t = Math.pow(clamp((x - p.in_black) / (inW - p.in_black), 0, 1), 1 / Math.max(p.gamma, 0.01));
      return p.out_black + t * (p.out_white - p.out_black);
    });
    return rgbLut(src, ...channelLut(lut, p.channel || 'rgb'));
  },
  curves(src, w, h, p) {
    return rgbLut(src, ...channelLut(curveLut(p.points || [[0, 0], [255, 255]]), p.channel || 'rgb'));
  },
  exposure(src, w, h, p) {
    const lut = Float32Array.from({ length: 256 }, (_, i) => {
      const x = i / 255;
      let lin = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      lin = Math.pow(Math.max(0, lin * Math.pow(2, p.exposure) + p.offset), 1 / Math.max(p.gamma, 0.01));
      return (lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(Math.min(lin, 1e6), 1 / 2.4) - 0.055) * 255;
    });
    return rgbLut(src, lut);
  },
  vibrance(src, w, h, p) {
    return eachRGB(src, (r, g, b) => {
      const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
      const L = lum(r, g, b);
      const amt = p.vibrance / 100 * (1 - (mx - mn)) + p.saturation / 100;
      return [L + (r - L) * (1 + amt), L + (g - L) * (1 + amt), L + (b - L) * (1 + amt)];
    });
  },
  hue_saturation(src, w, h, p) {
    return eachRGB(src, (r, g, b) => {
      let [H, L, S] = rgbToHls(r, g, b);
      if (p.colorize) {
        H = (((p.hue % 360) + 360) % 360) / 360 * 256;
        S = clamp(25 + p.saturation * 0.75, 0, 100) / 100 * 255;
      } else {
        H = (H + p.hue / 360 * 256 + 256) % 256;
        if (p.saturation >= 0) S = S + (255 - S) * (p.saturation / 100) * Math.pow(S / 255, 0.25);
        else S = S * (1 + p.saturation / 100);
      }
      if (p.lightness > 0) L = L + (255 - L) * p.lightness / 100;
      else if (p.lightness < 0) L = L * (1 + p.lightness / 100);
      return hlsToRgb(clamp(Math.round(H), 0, 255), clamp(Math.round(L), 0, 255), clamp(Math.round(S), 0, 255));
    });
  },
  color_balance(src, w, h, p) {
    const add = [p.cyan_red, p.magenta_green, p.yellow_blue];
    return eachRGB(src, (r, g, b) => {
      const l0 = lum(r, g, b);
      const v = [r, g, b].map((c, k) => { const x = c / 255; return c + add[k] * 1.28 * (1 - (2 * x - 1) ** 2); });
      if (p.preserve_luminosity) { const dl = l0 - lum(...v); v[0] += dl; v[1] += dl; v[2] += dl; }
      return v;
    });
  },
  invert(src) { return eachRGB(src, (r, g, b) => [255 - r, 255 - g, 255 - b]); },
  desaturate(src) { return eachRGB(src, (r, g, b) => { const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2; return [l, l, l]; }); },
  black_white(src, w, h, p) {
    return eachRGB(src, (r, g, b) => {
      const mn = Math.min(r, g, b);
      const r1 = r - mn, g1 = g - mn, b1 = b - mn;
      const y = Math.min(r1, g1), c = Math.min(g1, b1), m = Math.min(r1, b1);
      const rr = r1 - y - m, gg = g1 - y - c, bb = b1 - c - m;
      const v = mn + rr * p.reds / 100 + gg * p.greens / 100 + bb * p.blues / 100 + y * p.yellows / 100 + c * p.cyans / 100 + m * p.magentas / 100;
      return [v, v, v];
    });
  },
  threshold(src, w, h, p) { return eachRGB(src, (r, g, b) => { const v = lum(r, g, b) >= p.level ? 255 : 0; return [v, v, v]; }); },
  posterize(src, w, h, p) {
    const n = Math.max(2, p.levels | 0);
    return rgbLut(src, Float32Array.from({ length: 256 }, (_, x) => Math.round(Math.floor(x / 256 * n) * 255 / (n - 1))));
  },
  auto_tone(src, w, h, p) {
    const hs = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
    let total = 0;
    for (let i = 0; i < src.length; i += 4) if (src[i + 3]) { hs[0][src[i]]++; hs[1][src[i + 1]]++; hs[2][src[i + 2]]++; total++; }
    if (!total) return Uint8ClampedArray.from(src);
    const luts = hs.map((hist) => {
      const lo = percentile(hist, total, p.clip), hi = Math.max(percentile(hist, total, 100 - p.clip), lo + 1);
      return Float32Array.from({ length: 256 }, (_, x) => clamp((x - lo) * 255 / (hi - lo), 0, 255));
    });
    return rgbLut(src, ...luts);
  },
  auto_contrast(src, w, h, p) {
    const hist = new Float64Array(256);
    let total = 0;
    for (let i = 0; i < src.length; i += 4) if (src[i + 3]) { hist[src[i]]++; hist[src[i + 1]]++; hist[src[i + 2]]++; total += 3; }
    if (!total) return Uint8ClampedArray.from(src);
    const lo = percentile(hist, total, p.clip), hi = Math.max(percentile(hist, total, 100 - p.clip), lo + 1);
    return rgbLut(src, Float32Array.from({ length: 256 }, (_, x) => clamp((x - lo) * 255 / (hi - lo), 0, 255)));
  },
  photo_filter(src, w, h, p) {
    const c = hexRgb(p.color), d = p.density / 100;
    return eachRGB(src, (r, g, b) => {
      let v = [r * (1 - d) + r * c[0] / 255 * d, g * (1 - d) + g * c[1] / 255 * d, b * (1 - d) + b * c[2] / 255 * d];
      if (p.preserve_luminosity) { const k = lum(r, g, b) / Math.max(lum(...v), 1e-3); v = v.map((x) => x * k); }
      return v;
    });
  },
  color_temperature(src, w, h, p) {           // Web 版の追加（iPad 向け）: 色温度・色かぶり
    const t = p.temperature / 100, n = p.tint / 100;
    return eachRGB(src, (r, g, b) => {
      const l0 = lum(r, g, b);
      const v = [r * (1 + 0.18 * t) , g * (1 - 0.12 * n), b * (1 - 0.22 * t)];
      v[0] *= 1 + 0.06 * n; v[2] *= 1 + 0.06 * n;
      const dl = l0 - lum(...v);
      return [v[0] + dl, v[1] + dl, v[2] + dl];
    });
  },
};

// ---- フィルター ------------------------------------------------------------------
const FilterFns = {
  gaussian_blur(src, w, h, p) { return unpremul(gaussBlurF(premul(src), w, h, 4, p.radius)); },
  box_blur(src, w, h, p) {
    const f = premul(src);
    boxBlurCh(f, w, h, 4, p.radius | 0, true); boxBlurCh(f, w, h, 4, p.radius | 0, false);
    return unpremul(f);
  },
  motion_blur(src, w, h, p) {
    // 回転して横方向にぼかし、戻す（canvas を使う）
    const n = Math.max(1, p.distance | 0);
    const D = Math.ceil(Math.hypot(w, h)) + n * 2 + 4;
    const a = (p.angle * Math.PI) / 180;
    const srcC = newCanvas(w, h); ctx2d(srcC).putImageData(new ImageData(Uint8ClampedArray.from(src), w, h), 0, 0);
    const rot = newCanvas(D, D), rg = ctx2d(rot);
    rg.translate(D / 2, D / 2); rg.rotate(a); rg.drawImage(srcC, -w / 2, -h / 2);
    const img = rg.getImageData(0, 0, D, D);
    const f = premul(img.data);
    boxBlurCh(f, D, D, 4, Math.max(1, Math.round(n / 2)), true);
    img.data.set(unpremul(f));
    rg.setTransform(1, 0, 0, 1, 0, 0); rg.clearRect(0, 0, D, D); rg.putImageData(img, 0, 0);
    const back = newCanvas(w, h), bg = ctx2d(back);
    bg.translate(w / 2, h / 2); bg.rotate(-a); bg.drawImage(rot, -D / 2, -D / 2);
    const out = bg.getImageData(0, 0, w, h).data;
    for (let i = 3; i < out.length; i += 4) if (src[i] === 255 && out[i] >= 250) out[i] = 255;   // 端の丸め誤差
    return out;
  },
  median(src, w, h, p) {
    const r = Math.max(1, p.radius | 0);
    const out = new Uint8ClampedArray(src.length);
    const hist = new Uint32Array(256);
    const half = ((2 * r + 1) ** 2 + 1) >> 1;
    for (let c = 0; c < 4; c++) {
      for (let y = 0; y < h; y++) {
        hist.fill(0);
        let cnt = 0;
        const addCol = (x, s) => { if (x < 0 || x >= w) return; for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) { hist[src[(yy * w + x) * 4 + c]] += s; cnt += s; } };
        for (let x = -r; x <= r; x++) addCol(x, 1);
        for (let x = 0; x < w; x++) {
          const k = Math.min(half, (cnt + 1) >> 1);
          let acc = 0, v = 0;
          for (; v < 256; v++) { acc += hist[v]; if (acc >= k) break; }
          out[(y * w + x) * 4 + c] = v;
          addCol(x - r, -1); addCol(x + r + 1, 1);
        }
      }
    }
    return out;
  },
  add_noise(src, w, h, p) {
    const rnd = mulberry32(p.seed || ((Math.random() * 1e9) | 0));
    const scale = p.amount / 100 * 255;
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const one = () => (p.distribution === 'uniform' ? (rnd() - 0.5) * 2 * scale : gauss() * scale * 0.5);
    return eachRGB(src, (r, g, b) => {
      if (p.monochrome) { const n = one(); return [r + n, g + n, b + n]; }
      return [r + one(), g + one(), b + one()];
    });
  },
  unsharp_mask(src, w, h, p) {
    const f = rgbFloat(src), bl = gaussBlurF(Float32Array.from(f), w, h, 3, Math.max(p.radius, 0.1));
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
      for (let k = 0; k < 3; k++) {
        let d = f[j + k] - bl[j + k];
        if (p.threshold > 0 && Math.abs(d) * 2 < p.threshold) d = 0;
        out[i + k] = f[j + k] + d * p.amount / 100;
      }
      out[i + 3] = src[i + 3];
    }
    return out;
  },
  sharpen(src, w, h) { return FilterFns.unsharp_mask(src, w, h, { amount: 60, radius: 0.8, threshold: 0 }); },
  high_pass(src, w, h, p) {
    const f = rgbFloat(src), bl = gaussBlurF(Float32Array.from(f), w, h, 3, Math.max(p.radius, 0.1));
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0, j = 0; i < src.length; i += 4, j += 3) {
      out[i] = f[j] - bl[j] + 128; out[i + 1] = f[j + 1] - bl[j + 1] + 128; out[i + 2] = f[j + 2] - bl[j + 2] + 128; out[i + 3] = src[i + 3];
    }
    return out;
  },
  minimum(src, w, h, p) { return morph(src, w, h, Math.max(1, p.radius | 0), Math.min); },
  maximum(src, w, h, p) { return morph(src, w, h, Math.max(1, p.radius | 0), Math.max); },
  mosaic(src, w, h, p) {
    const c = Math.max(1, p.cell | 0);
    const f = premul(src);
    const out = new Float32Array(f.length);
    for (let y0 = 0; y0 < h; y0 += c) {
      for (let x0 = 0; x0 < w; x0 += c) {
        const s = [0, 0, 0, 0]; let n = 0;
        for (let y = y0; y < Math.min(h, y0 + c); y++) for (let x = x0; x < Math.min(w, x0 + c); x++) { const i = (y * w + x) * 4; s[0] += f[i]; s[1] += f[i + 1]; s[2] += f[i + 2]; s[3] += f[i + 3]; n++; }
        for (let y = y0; y < Math.min(h, y0 + c); y++) for (let x = x0; x < Math.min(w, x0 + c); x++) { const i = (y * w + x) * 4; out[i] = s[0] / n; out[i + 1] = s[1] / n; out[i + 2] = s[2] / n; out[i + 3] = s[3] / n; }
      }
    }
    return unpremul(out);
  },
  emboss(src, w, h, p) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = lum(src[i], src[i + 1], src[i + 2]);
    const a = (p.angle * Math.PI) / 180, dx = Math.cos(a) * p.height, dy = -Math.sin(a) * p.height;
    const at = (x, y) => {           // 端は折り返し・双線形
      x = clamp(x, 0, w - 1); y = clamp(y, 0, h - 1);
      const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = x - x0, fy = y - y0;
      return (g[y0 * w + x0] * (1 - fx) + g[y0 * w + x1] * fx) * (1 - fy) + (g[y1 * w + x0] * (1 - fx) + g[y1 * w + x1] * fx) * fy;
    };
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = clamp(128 + (g[y * w + x] - at(x - dx, y - dy)) * p.amount / 100, 0, 255);
      out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = src[i + 3];
    }
    return out;
  },
  find_edges(src, w, h) {
    const out = new Uint8ClampedArray(src.length);
    const px = (x, y, c) => src[(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)) * 4 + c];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const gx = -px(x - 1, y - 1, c) - 2 * px(x - 1, y, c) - px(x - 1, y + 1, c) + px(x + 1, y - 1, c) + 2 * px(x + 1, y, c) + px(x + 1, y + 1, c);
        const gy = -px(x - 1, y - 1, c) - 2 * px(x, y - 1, c) - px(x + 1, y - 1, c) + px(x - 1, y + 1, c) + 2 * px(x, y + 1, c) + px(x + 1, y + 1, c);
        out[i + c] = 255 - Math.sqrt(gx * gx + gy * gy) / 4;
      }
      out[i + 3] = src[i + 3];
    }
    return out;
  },
  vignette(src, w, h, p, ctx) {
    // 文書全体を基準にする（選択範囲の一部だけ処理するときも、中心は文書の中心）
    const W = ctx ? ctx.docW : w, H = ctx ? ctx.docH : h, ox = ctx ? ctx.x : 0, oy = ctx ? ctx.y : 0;
    const start = p.midpoint / 100, soft = Math.max(p.feather / 100, 0.01), k = p.amount / 100;
    return eachRGB(src, (r, g, b, i) => {
      const q = i / 4, x = ox + (q % w), y = oy + Math.floor(q / w);
      const xs = (x + 0.5) / W * 2 - 1, ys = (y + 0.5) / H * 2 - 1;
      let t = clamp((Math.sqrt(xs * xs + ys * ys) / Math.SQRT2 - start * (1 - soft)) / soft, 0, 1);
      t = t * t * (3 - 2 * t);
      return k < 0 ? [r * (1 + k * t), g * (1 + k * t), b * (1 + k * t)] : [r + (255 - r) * k * t, g + (255 - g) * k * t, b + (255 - b) * k * t];
    });
  },
  clouds(src, w, h, p) {
    const rnd = mulberry32(p.seed | 0 || 1);
    const acc = new Float32Array(w * h);
    let s = Math.max(p.scale, 2), amp = 1, total = 0;
    while (s >= 1.5) {
      const gw = Math.max(2, Math.floor(w / s) + 2), gh = Math.max(2, Math.floor(h / s) + 2);
      const grid = Float32Array.from({ length: gw * gh }, rnd);
      for (let y = 0; y < h; y++) {
        const gy = y / h * (gh - 1), y0 = Math.min(gh - 2, Math.floor(gy)), fy = gy - y0, sy = fy * fy * (3 - 2 * fy);
        for (let x = 0; x < w; x++) {
          const gx = x / w * (gw - 1), x0 = Math.min(gw - 2, Math.floor(gx)), fx = gx - x0, sx = fx * fx * (3 - 2 * fx);
          const top = grid[y0 * gw + x0] * (1 - sx) + grid[y0 * gw + x0 + 1] * sx;
          const bot = grid[(y0 + 1) * gw + x0] * (1 - sx) + grid[(y0 + 1) * gw + x0 + 1] * sx;
          acc[y * w + x] += amp * (top * (1 - sy) + bot * sy);
        }
      }
      total += amp; s /= 2; amp *= 0.5;
    }
    const c0 = hexRgb(p.fg), c1 = hexRgb(p.bg);
    const out = new Uint8ClampedArray(src.length);
    for (let j = 0, i = 0; j < acc.length; j++, i += 4) {
      const t = clamp(acc[j] / total, 0, 1);
      out[i] = c0[0] * (1 - t) + c1[0] * t; out[i + 1] = c0[1] * (1 - t) + c1[1] * t; out[i + 2] = c0[2] * (1 - t) + c1[2] * t; out[i + 3] = 255;
    }
    return out;
  },
};
/** 正方形の窓での最小値・最大値（RGB のみ） */
function morph(src, w, h, r, op) {
  const tmp = Uint8ClampedArray.from(src), out = Uint8ClampedArray.from(src);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      let v = src[i + c];
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = op(v, src[(y * w + k) * 4 + c]);
      tmp[i + c] = v;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      let v = tmp[i + c];
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = op(v, tmp[(k * w + x) * 4 + c]);
      out[i + c] = v;
    }
  }
  return out;
}

// ---- 登録表（exe と同じキー・引数名・範囲） ----------------------------------------
const P = (key, label, type, min, max, def, extra = {}) => ({ key, label, type, min, max, def, ...extra });
const CHANNELS = [['rgb', 'RGB'], ['red', 'レッド'], ['green', 'グリーン'], ['blue', 'ブルー']];
const ADJUSTMENTS = {
  brightness_contrast: { label: '明るさ・コントラスト', params: [P('brightness', '明るさ', 'int', -150, 150, 0), P('contrast', 'コントラスト', 'int', -50, 100, 0)] },
  levels: { label: 'レベル補正', ui: 'levels', params: [P('channel', 'チャンネル', 'choice', 0, 0, 'rgb', { choices: CHANNELS }),
    P('in_black', '入力 シャドウ', 'int', 0, 253, 0), P('gamma', '入力 中間調', 'float', 0.1, 9.99, 1.0, { digits: 2 }),
    P('in_white', '入力 ハイライト', 'int', 2, 255, 255), P('out_black', '出力 シャドウ', 'int', 0, 255, 0), P('out_white', '出力 ハイライト', 'int', 0, 255, 255)] },
  curves: { label: 'トーンカーブ', ui: 'curves', params: [P('channel', 'チャンネル', 'choice', 0, 0, 'rgb', { choices: CHANNELS }),
    P('points', '制御点', 'points', 0, 0, [[0, 0], [255, 255]])] },
  exposure: { label: '露光量', params: [P('exposure', '露光量', 'float', -5, 5, 0, { digits: 2 }), P('offset', 'オフセット', 'float', -0.5, 0.5, 0, { digits: 3 }), P('gamma', 'ガンマ', 'float', 0.1, 9.99, 1, { digits: 2 })] },
  vibrance: { label: '自然な彩度', params: [P('vibrance', '自然な彩度', 'int', -100, 100, 0), P('saturation', '彩度', 'int', -100, 100, 0)] },
  hue_saturation: { label: '色相・彩度', params: [P('hue', '色相', 'int', -180, 180, 0), P('saturation', '彩度', 'int', -100, 100, 0),
    P('lightness', '明度', 'int', -100, 100, 0), P('colorize', '色彩の統一', 'bool', 0, 0, false)] },
  color_balance: { label: 'カラーバランス', params: [P('cyan_red', 'シアン ⇔ レッド', 'int', -100, 100, 0), P('magenta_green', 'マゼンタ ⇔ グリーン', 'int', -100, 100, 0),
    P('yellow_blue', 'イエロー ⇔ ブルー', 'int', -100, 100, 0), P('preserve_luminosity', '輝度を保持', 'bool', 0, 0, true)] },
  color_temperature: { label: '色温度・色かぶり', webOnly: true, params: [P('temperature', '色温度（青 ⇔ 黄）', 'int', -100, 100, 0), P('tint', '色かぶり（緑 ⇔ 赤紫）', 'int', -100, 100, 0)] },
  black_white: { label: '白黒', params: [P('reds', 'レッド系', 'int', -200, 300, 40), P('yellows', 'イエロー系', 'int', -200, 300, 60), P('greens', 'グリーン系', 'int', -200, 300, 40),
    P('cyans', 'シアン系', 'int', -200, 300, 60), P('blues', 'ブルー系', 'int', -200, 300, 20), P('magentas', 'マゼンタ系', 'int', -200, 300, 80)] },
  photo_filter: { label: 'レンズフィルター', params: [P('color', '色', 'color', 0, 0, '#ec8a00'), P('density', '適用量', 'int', 1, 100, 25), P('preserve_luminosity', '輝度を保持', 'bool', 0, 0, true)] },
  invert: { label: '階調の反転', params: [], noDialog: true },
  desaturate: { label: '彩度を下げる', params: [], noDialog: true },
  posterize: { label: 'ポスタリゼーション', params: [P('levels', '階調数', 'int', 2, 255, 4)] },
  threshold: { label: '2階調化', params: [P('level', 'しきい値', 'int', 1, 255, 128)] },
  auto_tone: { label: '自動トーン補正', params: [P('clip', 'クリップ %', 'float', 0, 10, 0.1, { digits: 2 })], noDialog: true },
  auto_contrast: { label: '自動コントラスト', params: [P('clip', 'クリップ %', 'float', 0, 10, 0.1, { digits: 2 })], noDialog: true },
};
const FILTERS = {
  gaussian_blur: { label: 'ぼかし（ガウス）', group: 'ぼかし', pad: (p) => p.radius * 3, params: [P('radius', '半径', 'float', 0.1, 250, 2, { digits: 1, suffix: 'px', curve: 2 })] },
  box_blur: { label: 'ぼかし（ボックス）', group: 'ぼかし', pad: (p) => p.radius + 1, params: [P('radius', '半径', 'int', 1, 200, 3, { suffix: 'px', curve: 2 })] },
  motion_blur: { label: 'ぼかし（移動）', group: 'ぼかし', pad: (p) => p.distance + 2, params: [P('angle', '角度', 'int', -180, 180, 0, { suffix: '°' }), P('distance', '距離', 'int', 1, 500, 10, { suffix: 'px', curve: 2 })] },
  median: { label: 'メディアン', group: 'ノイズ', pad: (p) => p.radius + 1, params: [P('radius', '半径', 'int', 1, 20, 2, { suffix: 'px' })] },
  add_noise: { label: 'ノイズを加える', group: 'ノイズ', params: [P('amount', '量', 'float', 0.1, 400, 10, { digits: 1, suffix: '%', curve: 2 }),
    P('distribution', '分布方法', 'choice', 0, 0, 'gaussian', { choices: [['uniform', '均等に分布'], ['gaussian', 'ガウス分布']] }),
    P('monochrome', 'グレースケールノイズ', 'bool', 0, 0, false), P('seed', '乱数の種（0=毎回変える）', 'int', 0, 99999, 0)] },
  unsharp_mask: { label: 'アンシャープマスク', group: 'シャープ', pad: (p) => p.radius * 3, params: [P('amount', '量', 'int', 1, 500, 100, { suffix: '%' }),
    P('radius', '半径', 'float', 0.1, 100, 1, { digits: 1, suffix: 'px', curve: 2 }), P('threshold', 'しきい値', 'int', 0, 255, 0)] },
  sharpen: { label: 'シャープ', group: 'シャープ', pad: () => 3, params: [], noDialog: true },
  high_pass: { label: 'ハイパス', group: 'その他', pad: (p) => p.radius * 3, params: [P('radius', '半径', 'float', 0.1, 250, 10, { digits: 1, suffix: 'px', curve: 2 })] },
  minimum: { label: '明るさの最小値', group: 'その他', pad: (p) => p.radius + 1, params: [P('radius', '半径', 'int', 1, 100, 1, { suffix: 'px' })] },
  maximum: { label: '明るさの最大値', group: 'その他', pad: (p) => p.radius + 1, params: [P('radius', '半径', 'int', 1, 100, 1, { suffix: 'px' })] },
  mosaic: { label: 'モザイク', group: 'ピクセレート', pad: (p) => p.cell, params: [P('cell', 'セルの大きさ', 'int', 2, 200, 10, { suffix: 'px', curve: 2 })] },
  emboss: { label: 'エンボス', group: '表現手法', pad: (p) => p.height + 2, params: [P('angle', '角度', 'int', -180, 180, 135, { suffix: '°' }), P('height', '高さ', 'int', 1, 100, 3, { suffix: 'px' }), P('amount', '量', 'int', 1, 500, 100, { suffix: '%' })] },
  find_edges: { label: '輪郭検出', group: '表現手法', pad: () => 2, params: [], noDialog: true },
  vignette: { label: '周辺光量', group: '表現手法', params: [P('amount', '適用量', 'int', -100, 100, -50), P('midpoint', '中心点', 'int', 0, 100, 50), P('feather', 'ぼかし', 'int', 1, 100, 50)] },
  clouds: { label: '雲模様', group: '描画', params: [P('scale', '大きさ', 'int', 4, 1024, 64, { suffix: 'px', curve: 2 }), P('seed', '乱数の種', 'int', 1, 99999, 1),
    P('fg', '暗い色', 'color', 0, 0, '#000000'), P('bg', '明るい色', 'color', 0, 0, '#ffffff')] },
};
for (const [k, s] of Object.entries(ADJUSTMENTS)) { s.key = k; s.kind = 'adjust'; s.fn = AdjFns[k]; }
for (const [k, s] of Object.entries(FILTERS)) { s.key = k; s.kind = 'filter'; s.fn = FilterFns[k]; }
function findSpec(key) { return ADJUSTMENTS[key] || FILTERS[key] || null; }
function defaultParams(spec) {
  const p = {};
  for (const q of spec.params) p[q.key] = Array.isArray(q.def) ? q.def.map((x) => x.slice()) : q.def;
  return p;
}

/**
 * レイヤーの rect の範囲に spec をかけた結果を返す（選択範囲のぼかしで元と混ぜる）。
 * 戻り値: {rect, data: ImageData}。rect は書き戻す範囲。
 */
function runSpec(spec, params, layer, sel, docW, docH) {
  const target = sel ? sel.bounds : { x: 0, y: 0, w: docW, h: docH };
  const pad = spec.pad ? Math.ceil(spec.pad(params)) : 0;
  const work = Rect.clampTo(target, docW, docH, pad);
  const g = layer.ctx;
  const img = g.getImageData(work.x, work.y, work.w, work.h);
  const res = spec.fn(img.data, work.w, work.h, params, { docW, docH, x: work.x, y: work.y });
  // 書き戻すのは target の範囲だけ（pad の部分は計算のために読んだだけ）
  const t = Rect.clampTo(target, docW, docH);
  const out = new ImageData(t.w, t.h);
  const o = out.data, src = img.data;
  const selA = sel ? ctx2d(sel.canvas).getImageData(t.x, t.y, t.w, t.h).data : null;
  const ox = t.x - work.x, oy = t.y - work.y;
  for (let y = 0; y < t.h; y++) {
    for (let x = 0; x < t.w; x++) {
      const j = ((y + oy) * work.w + (x + ox)) * 4, i = (y * t.w + x) * 4;
      if (!selA) { o[i] = res[j]; o[i + 1] = res[j + 1]; o[i + 2] = res[j + 2]; o[i + 3] = res[j + 3]; continue; }
      const a = selA[i + 3] / 255;
      for (let c = 0; c < 4; c++) o[i + c] = src[j + c] + (res[j + c] - src[j + c]) * a;
    }
  }
  return { rect: t, data: out };
}

/** ヒストグラム（輝度と RGB）。rect の範囲、選択範囲があればその中だけ */
function histogramOf(canvas, rect, sel) {
  const d = ctx2d(canvas).getImageData(rect.x, rect.y, rect.w, rect.h).data;
  const sa = sel ? ctx2d(sel.canvas).getImageData(rect.x, rect.y, rect.w, rect.h).data : null;
  const H = { rgb: new Float64Array(256), red: new Float64Array(256), green: new Float64Array(256), blue: new Float64Array(256) };
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3] || (sa && sa[i + 3] < 128)) continue;
    H.red[d[i]]++; H.green[d[i + 1]]++; H.blue[d[i + 2]]++;
    H.rgb[Math.round(lum(d[i], d[i + 1], d[i + 2]))]++;
  }
  return H;
}
