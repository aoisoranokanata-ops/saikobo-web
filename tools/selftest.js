/* ブラウザの開発者ツール（またはプレビュー）で読み込んで実行する自己テスト。
   疑似的なペン・タッチ入力で、描画・ジェスチャー・レイヤー・保存と読み込みを確かめる。
   使い方: await import('/tools/selftest.js') ではなく、<script> で読み込んでから await saikoboSelfTest() */
async function saikoboSelfTest() {
  const out = [];
  const ok = (cond, msg) => { out.push((cond ? 'OK   ' : 'FAIL ') + msg); };
  const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const frame = () => wait(20);   // 隠れたタブでは requestAnimationFrame が来ない
  const view = app.view, cv = view.canvas;
  const rect = () => cv.getBoundingClientRect();
  const scr = (x, y) => { const r = rect(); const s = view.toScreen(x, y); return { clientX: r.left + s.x, clientY: r.top + s.y }; };
  let pid = 100;
  const fire = (type, id, pointerType, pos, extra = {}) => cv.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType, bubbles: true, cancelable: true, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, button: 0,
    pressure: type === 'pointerup' ? 0 : (extra.pressure ?? 0.6), ...pos, ...extra,
  }));
  const stroke = async (pts, pointerType = 'pen', extra = {}) => {
    const id = ++pid;
    fire('pointerdown', id, pointerType, scr(...pts[0]), extra);
    for (const p of pts.slice(1)) { fire('pointermove', id, pointerType, scr(...p), extra); await wait(5); }
    fire('pointerup', id, pointerType, scr(...pts[pts.length - 1]), extra);
    await frame();
  };
  const alphaCount = (c, r) => {
    const d = c.getContext('2d').getImageData(r.x, r.y, r.w, r.h).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n;
  };

  // 1) 新しい文書
  if (app.doc) await app.closeDoc();
  const doc = new Doc(400, 300, { name: '自己テスト', background: '#ffffff' });
  doc.history.clear('新規');
  app.openDoc(doc);
  await wait(50);
  app.settings.fingerDraws = 'auto'; app.settings._penNoticed = false;
  ok(doc.layers.length === 1, '新規文書のレイヤーは1枚');

  // 2) 選択範囲の中だけに描ける（destination-in が他の筆跡を消さない）
  app.cmd('layer.new');
  const l2 = doc.active;
  doc.setSelection(Sel.combine(null, Sel.shape(400, 300, (g) => g.rect(100, 50, 200, 200)), 'replace', 400, 300));
  app.selectTool('brush');
  app.tools.brush.opts.size = 10; app.tools.brush.opts.smoothing = 0;
  await stroke([[20, 150], [100, 150], [200, 150], [300, 150], [380, 150]]);
  const drawn = alphaCount(l2.canvas, doc.fullRect);
  ok(alphaCount(l2.canvas, { x: 110, y: 140, w: 180, h: 20 }) > 180 * 5, 'ブラシ: 選択範囲の中に描けた（筆圧 0.6 で細め）');
  ok(alphaCount(l2.canvas, { x: 0, y: 0, w: 95, h: 300 }) === 0 && alphaCount(l2.canvas, { x: 305, y: 0, w: 95, h: 300 }) === 0, 'ブラシ: 選択範囲の外は描かれない');
  ok(app.settings.fingerDraws === false, 'ペンを使ったら「指では描かない」に切り替わる');

  // 3) 2本指タップ = 取り消し、3本指タップ = やり直し
  const before = doc.history.pos;
  const tap = async (n) => {
    const ids = Array.from({ length: n }, () => ++pid);
    ids.forEach((id, i) => fire('pointerdown', id, 'touch', scr(150 + i * 30, 100)));
    await wait(40);
    ids.forEach((id, i) => fire('pointerup', id, 'touch', scr(150 + i * 30, 100)));
    await frame();
  };
  await tap(2);
  ok(doc.history.pos === before - 1 && alphaCount(l2.canvas, doc.fullRect) === 0, '2本指タップで取り消し');
  await tap(3);
  ok(doc.history.pos === before && alphaCount(l2.canvas, doc.fullRect) === drawn, '3本指タップでやり直し');

  // 4) つまんで拡大
  const s0 = view.scale;
  {
    const a = ++pid, b = ++pid;
    fire('pointerdown', a, 'touch', scr(150, 150)); fire('pointerdown', b, 'touch', scr(250, 150));
    for (let k = 1; k <= 5; k++) { fire('pointermove', a, 'touch', scr(150 - k * 10, 150)); fire('pointermove', b, 'touch', scr(250 + k * 10, 150)); await wait(5); }
    fire('pointerup', a, 'touch', scr(100, 150)); fire('pointerup', b, 'touch', scr(300, 150));
    await frame();
  }
  ok(view.scale > s0 * 1.5 && doc.history.pos === before, 'つまんで拡大（取り消しにはならない）');
  view.fit();

  // 5) 指1本は移動（指では描かない設定）
  const ox = view.ox;
  const cnt = alphaCount(l2.canvas, doc.fullRect);
  await stroke([[50, 50], [80, 60], [120, 70]], 'touch');
  ok(view.ox !== ox && alphaCount(l2.canvas, doc.fullRect) === cnt, '指1本は画面の移動（描かない）');
  view.fit();

  // 6) 消しゴム・取り消し
  doc.setSelection(null);
  app.selectTool('eraser');
  app.tools.eraser.opts.size = 30; app.tools.eraser.opts.smoothing = 0;
  await stroke([[200, 100], [200, 200]]);
  ok(alphaCount(l2.canvas, { x: 196, y: 140, w: 8, h: 20 }) === 0, '消しゴムで消える');
  app.undo();
  ok(alphaCount(l2.canvas, { x: 196, y: 140, w: 8, h: 20 }) > 20, '消しゴムを取り消せる');

  // 7) 透明部分をロック
  doc.setLayerProps(l2, { alpha_locked: true });
  app.selectTool('brush'); app.setFg('#ff0000', { recent: false });
  app.tools.brush.opts.size = 60;
  const n0 = alphaCount(l2.canvas, doc.fullRect);
  await stroke([[150, 100], [150, 200]]);
  const px = l2.ctx.getImageData(150, 150, 1, 1).data;
  ok(alphaCount(l2.canvas, doc.fullRect) === n0 && px[0] > 200 && px[1] < 60, '透明部分をロック: 形はそのまま色だけ変わる');
  doc.setLayerProps(l2, { alpha_locked: false });

  // 8) 塗りつぶし・自動選択
  app.selectTool('fill'); app.tools.fill.opts.allLayers = false; app.tools.fill.opts.contiguous = true;
  app.setFg('#00ff00', { recent: false });
  doc.setActive(doc.layers[0]);
  await stroke([[10, 10], [10, 10]], 'mouse');
  const bgpx = doc.layers[0].ctx.getImageData(10, 10, 1, 1).data;
  ok(bgpx[1] > 200 && bgpx[0] < 50, '塗りつぶし（背景）');
  app.selectTool('wand'); app.tools.wand.opts.mode = 'replace'; app.tools.wand.opts.allLayers = true;
  await stroke([[10, 10], [10, 10]], 'mouse');
  ok(doc.sel && doc.sel.bounds.w === 400, '自動選択（全レイヤー）');
  app.cmd('select.invert');
  ok(doc.sel && doc.sel.bounds.x >= 95 && doc.sel.bounds.w < 220, '選択範囲を反転');
  app.cmd('select.none');

  // 9) なげなわ・楕円・追加
  app.selectTool('lasso'); app.tools.lasso.opts.mode = 'replace';
  await stroke([[20, 20], [120, 20], [120, 120], [20, 120]], 'mouse');
  ok(doc.sel && Math.abs(doc.sel.bounds.w - 100) <= 2, 'なげなわ選択');
  app.selectTool('marquee_ellipse'); app.tools.marquee_ellipse.opts.mode = 'add';
  await stroke([[200, 200], [300, 280]], 'mouse');
  ok(doc.sel && doc.sel.bounds.x <= 21 && doc.sel.bounds.x + doc.sel.bounds.w >= 299, '楕円形選択で追加');
  app.tools.marquee_ellipse.opts.mode = 'replace';
  doc.setSelection(Sel.grow(doc.sel, 5, 400, 300));
  ok(doc.sel.bounds.x <= 16, '選択範囲を拡張');

  // 10) 移動ツール（選択範囲の中身ごと）
  doc.setSelection(Sel.combine(null, Sel.shape(400, 300, (g) => g.rect(100, 50, 200, 200)), 'replace', 400, 300));
  doc.setActive(l2);
  app.selectTool('move');
  await stroke([[150, 150], [170, 160], [190, 170]], 'mouse');
  ok(doc.sel.bounds.x === 140 && doc.sel.bounds.y === 70, '移動: 選択範囲も一緒に動く');
  app.undo();
  ok(doc.sel.bounds.x === 100, '移動を取り消せる');
  doc.setSelection(null);

  // 11) レイヤー操作
  const nL = doc.layers.length;
  app.cmd('layer.duplicate');
  ok(doc.layers.length === nL + 1, 'レイヤーを複製');
  app.cmd('layer.mergeDown');
  ok(doc.layers.length === nL, '下と結合');
  doc.setLayerProps(doc.active, { blend: 'multiply', opacity: 0.5 });
  app.cmd('layer.down');
  ok(doc.indexOf(doc.active) === 0, '背面へ');
  app.undo(); app.undo(); app.undo(); app.undo();
  ok(doc.layers.length === nL, 'レイヤー操作を取り消せる');

  // 12) 画像全体の操作
  app.cmd('image.rot90');
  ok(doc.width === 300 && doc.height === 400, '90° 回転で縦横が入れ替わる');
  app.undo();
  ok(doc.width === 400 && doc.height === 300, '回転を取り消せる');
  doc.resizeImage(200, 150);
  ok(doc.width === 200 && doc.layers.every((l) => l.canvas.width === 200), '画像解像度');
  app.undo();
  doc.crop({ x: 10, y: 20, w: 100, h: 80 });
  ok(doc.width === 100 && doc.height === 80, '切り抜き');
  app.undo();

  // 13) 保存と読み込み
  doc.setLayerProps(l2, { blend: 'screen', opacity: 0.7, name: '上の層' });
  l2.extra = { future_prop: { size: 3 } };            // Web 版が知らない属性も失わない
  l2.styles = { stroke: { ...styleDefaults('stroke'), size: 3 } };
  await app.saveNow();
  const { doc: d2 } = await Store.loadDoc(doc.workId);
  ok(d2.layers.length === doc.layers.length && d2.width === 400, '保存して読み込める（レイヤー数・大きさ）');
  const L = d2.layers.find((l) => l.name === '上の層');
  ok(L && L.blend === 'screen' && Math.abs(L.opacity - 0.7) < 1e-6 && L.extra.future_prop && L.extra.future_prop.size === 3 && L.styles && L.styles.stroke.size === 3, '属性・スタイル・知らない属性（extra）も残る');
  ok(L && alphaCount(L.canvas, d2.fullRect) === alphaCount(l2.canvas, doc.fullRect), '画素も同じ');

  // 後片付け
  const id = doc.workId;
  await app.closeDoc();
  await Store.remove(id);
  await app.showGallery();
  app.settings.fingerDraws = 'auto';
  app.saveSettings();
  const fails = out.filter((l) => l.startsWith('FAIL')).length;
  return out.join('\n') + `\n---- ${out.length - fails} OK / ${fails} FAIL`;
}


/* フェーズ2: ペンの種類・色調補正パネル・フィルター・自由変形・切り抜き */
async function saikoboSelfTest2() {
  const out = [];
  const ok = (cond, msg) => { out.push((cond ? 'OK   ' : 'FAIL ') + msg); };
  const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const view = app.view, cv = view.canvas;
  const scr = (x, y) => { const r = cv.getBoundingClientRect(); const s = view.toScreen(x, y); return { clientX: r.left + s.x, clientY: r.top + s.y }; };
  let pid = 500;
  const fire = (type, id, pointerType, pos, extra = {}) => cv.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType, bubbles: true, cancelable: true, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, button: 0,
    pressure: type === 'pointerup' ? 0 : (extra.pressure ?? 0.7), ...pos, ...extra,
  }));
  const stroke = async (pts, pointerType = 'mouse', extra = {}) => {
    const id = ++pid;
    fire('pointerdown', id, pointerType, scr(...pts[0]), extra);
    for (const p of pts.slice(1)) { fire('pointermove', id, pointerType, scr(...p), extra); await wait(4); }
    fire('pointerup', id, pointerType, scr(...pts[pts.length - 1]), extra);
    await wait(20);
  };
  const px = (layer, x, y) => Array.from(layer.ctx.getImageData(x, y, 1, 1).data);
  const alphaCount = (c, r) => { const d = c.getContext('2d').getImageData(r.x, r.y, r.w, r.h).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; };

  if (app.doc) await app.closeDoc();
  const doc = new Doc(400, 300, { name: '自己テスト2', background: '#808080' });
  doc.history.clear('新規');
  app.openDoc(doc);
  await wait(50);
  const bg = doc.layers[0];

  // 1) ペンの種類
  app.cmd('layer.new');
  const ink = doc.active;
  app.selectTool('brush');
  const brush = app.tools.brush;
  const keep = { ...brush.opts };
  brush.setPreset('gpen'); brush.opts.size = 20; brush.opts.smoothing = 0;
  app.setFg('#000000', { recent: false });
  const pts = []; for (let i = 0; i <= 20; i++) pts.push([40 + i * 10, 60]);
  // 筆圧を入り抜きにする
  { const id = ++pid; fire('pointerdown', id, 'pen', scr(...pts[0]), { pressure: 0.02 });
    for (let i = 1; i < pts.length; i++) { fire('pointermove', id, 'pen', scr(...pts[i]), { pressure: Math.sin(i / 20 * Math.PI) }); await wait(3); }
    fire('pointerup', id, 'pen', scr(...pts[20])); await wait(20); }
  const thick = (x) => { let n = 0; for (let y = 40; y < 80; y++) if (px(ink, x, y)[3] > 128) n++; return n; };
  ok(thick(140) > thick(50) + 6 && thick(50) <= 4, `Gペン: 入り抜きで細く・中央で太い（端 ${thick(50)}px / 中央 ${thick(140)}px）`);
  brush.setPreset('pencil'); brush.opts.size = 30;
  await stroke([[40, 150], [360, 150]], 'pen', { pressure: 1 });
  let holes = 0, solid = 0;
  for (let x = 60; x < 340; x += 3) { const a = px(ink, x, 150)[3]; if (a < 200) holes++; else solid++; }
  ok(holes > 10 && solid > 10, `鉛筆: 紙の質感で塗りにむらがある（抜け ${holes} / 濃い ${solid}）`);
  brush.setPreset('marker');
  ok(brush.opts.opacity === 60 && brush.opts.pressureSize === false, 'マーカー: 不透明度 60%・筆圧でサイズ変えない');
  brush.setPreset('round');
  ok(brush.opts.opacity === 100, '標準ペンに戻すと不透明度 100%');
  Object.assign(brush.opts, keep); LS.set('tool.brush', brush.opts);

  // 2) 色調補正パネル（プレビュー → OK で1手）
  doc.setActive(bg);
  const n0 = doc.history.pos;
  app.cmd('adj.brightness_contrast');
  ok(app.adjust.open && !$('#adjPanel').hidden, '色調補正パネルが開く');
  app.adjust.params.brightness = 80;
  app.adjust.compute();
  const prevPx = Array.from(ctx2d(doc.live.canvas).getImageData(10, 10, 1, 1).data);
  ok(prevPx[0] > 160 && px(bg, 10, 10)[0] === 128, 'プレビューは作業用だけ（レイヤーはまだ変わらない）');
  app.adjust.ok();
  ok(px(bg, 10, 10)[0] > 160 && doc.history.pos === n0 + 1 && doc.history.list[doc.history.pos - 1].label === '明るさ・コントラスト', 'OK で反映・履歴1手');
  app.undo();
  ok(px(bg, 10, 10)[0] === 128, '取り消せる');
  app.cmd('adj.hue_saturation');
  app.adjust.params.saturation = 50;
  app.adjust.compute();
  app.adjust.cancel();
  ok(!app.adjust.open && px(bg, 10, 10)[0] === 128 && doc.live === null && doc.history.pos === n0, 'キャンセルで元のまま');
  // 選択範囲の中だけ
  doc.setSelection(Sel.combine(null, Sel.shape(400, 300, (g) => g.rect(0, 0, 200, 300)), 'replace', 400, 300));
  app.cmd('adj.invert');
  ok(px(bg, 10, 10)[0] === 127 && px(bg, 300, 10)[0] === 128, '階調の反転は選択範囲の中だけ');
  app.undo(); app.cmd('select.none');
  // トーンカーブ（点をつかんで動かす）
  app.cmd('adj.curves');
  app.adjust.params.points = [[0, 0], [128, 200], [255, 255]];
  app.adjust.ok();
  ok(px(bg, 10, 10)[0] > 190, 'トーンカーブ');
  app.undo();
  // フィルター（ぼかしは境目だけ変わる）
  ink.ctx.clearRect(0, 0, 400, 300); ink.ctx.fillStyle = '#ff0000'; ink.ctx.fillRect(100, 100, 100, 100); ink.ver++; doc.invalidate();
  doc.setActive(ink);
  app.cmd('adj.gaussian_blur');
  app.adjust.params.radius = 5;
  app.adjust.ok();
  const edge = px(ink, 100, 150), inside = px(ink, 150, 150);
  ok(edge[3] > 60 && edge[3] < 200 && inside[3] === 255 && inside[0] === 255, 'ぼかし（ガウス）: 境目だけなめらかに・色は赤のまま');
  ok(!!app.lastFilter && app.lastFilter.key === 'gaussian_blur', '前回のフィルターを覚える');
  app.undo();

  // 3) 自由変形
  app.selectTool('transform');
  const T = app.tools.transform;
  ok(!!T.state && T.state.bounds.w === 100, '自由変形: 中身の範囲で始まる');
  // 右下の角を外へ（縦横比固定で 2 倍）
  await stroke([[200, 200], [250, 250], [300, 300]]);
  const q = T.state.quad;
  ok(Math.abs(q[2].x - 300) < 1 && Math.abs(q[2].y - 300) < 1 && Math.abs(q[0].x - 100) < 1, '角をドラッグで拡大（反対の角は固定）');
  T.commit();
  ok(!T.state && app.toolName !== 'transform' && alphaCount(ink.canvas, { x: 0, y: 0, w: 400, h: 300 }) > 35000, '確定で反映して前の道具に戻る');
  app.undo();
  ok(alphaCount(ink.canvas, { x: 0, y: 0, w: 400, h: 300 }) === 10000, '自由変形を取り消せる');
  // 回転（外側をドラッグ）→ 90°
  app.selectTool('transform');
  await stroke([[150, 60], [240, 150]], 'mouse', { shiftKey: true });
  const ang = Math.atan2(T.state.quad[1].y - T.state.quad[0].y, T.state.quad[1].x - T.state.quad[0].x) * 180 / Math.PI;
  ok(Math.abs(ang - 90) < 0.01, `外側をドラッグで回転（Shift で 15° 刻み: ${ang.toFixed(2)}°）`);
  T.cancelAll();
  ok(!T.state && doc.live === null && alphaCount(ink.canvas, { x: 0, y: 0, w: 400, h: 300 }) === 10000, '変形のキャンセル');
  // 遠近
  app.selectTool('transform');
  T.setOpt('mode', 'distort');
  await stroke([[100, 100], [60, 80]]);
  T.commit();
  const area = alphaCount(ink.canvas, { x: 0, y: 0, w: 400, h: 300 });
  ok(area > 10500 && area < 14000, `自由な形（遠近）で角だけ動かせる（面積 ${area}）`);
  T.setOpt('mode', 'scale');
  app.undo();

  // 4) 切り抜きツール
  app.selectTool('crop');
  const C = app.tools.crop;
  ok(C.rect && C.rect.w === 400, '切り抜き: 最初は全体');
  await stroke([[400, 300], [300, 250]]);              // 右下の角を内側へ
  ok(Math.round(C.rect.w) === 300 && Math.round(C.rect.h) === 250, '角をドラッグで範囲を決める');
  C.setOpt('ratio', '1:1'); C.optChanged('ratio');
  ok(Math.round(C.rect.w) === Math.round(C.rect.h), '比率 1:1');
  C.commit();
  ok(doc.width === 300 && doc.height === 300, `切り抜いた（${doc.width}×${doc.height}）`);
  app.undo();
  C.setOpt('ratio', 'free');
  app.selectTool('brush');

  const id = doc.workId;
  await app.closeDoc();
  await Store.remove(id);
  await app.showGallery();
  const fails = out.filter((l) => l.startsWith('FAIL')).length;
  return out.join('\n') + `\n---- ${out.length - fails} OK / ${fails} FAIL`;
}


/* フェーズ3: マスク・クリッピング・グループ・調整レイヤー・スタイル・テキスト・保存の往復 */
async function saikoboSelfTest3() {
  const out = [];
  const ok = (cond, msg) => { out.push((cond ? 'OK   ' : 'FAIL ') + msg); };
  const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const view = app.view, cv = view.canvas;
  const scr = (x, y) => { const r = cv.getBoundingClientRect(); const s = view.toScreen(x, y); return { clientX: r.left + s.x, clientY: r.top + s.y }; };
  let pid = 900;
  const fire = (type, id, pointerType, pos, extra = {}) => cv.dispatchEvent(new PointerEvent(type, {
    pointerId: id, pointerType, bubbles: true, cancelable: true, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, button: 0,
    pressure: type === 'pointerup' ? 0 : 0.8, ...pos, ...extra,
  }));
  const stroke = async (pts, pointerType = 'mouse') => {
    const id = ++pid;
    fire('pointerdown', id, pointerType, scr(...pts[0]));
    for (const p of pts.slice(1)) { fire('pointermove', id, pointerType, scr(...p)); await wait(4); }
    fire('pointerup', id, pointerType, scr(...pts[pts.length - 1]));
    await wait(20);
  };
  const comp = (doc, x, y) => Array.from(ctx2d(doc.composite()).getImageData(x, y, 1, 1).data);
  const near = (a, b, t = 6) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  const fillRect = (l, color, x, y, w, h) => { l.ctx.fillStyle = color; l.ctx.fillRect(x, y, w, h); l.ver++; };

  if (app.doc) await app.closeDoc();
  const doc = new Doc(200, 160, { name: '自己テスト3', background: '#ffffff' });
  doc.history.clear('新規');
  app.openDoc(doc);
  await wait(50);
  const bg = doc.layers[0];

  // 1) レイヤーマスク
  app.cmd('layer.new');
  const red = doc.active; red.name = '赤';
  fillRect(red, '#ff0000', 0, 0, 200, 160); doc.invalidate();
  app.cmd('mask.hide');
  ok(!!red.mask && doc.editingMask && near(comp(doc, 50, 50), [255, 255, 255, 255]), 'マスク（すべて隠す）で下の白が見える');
  app.selectTool('brush');
  const b = app.tools.brush, keepB = { ...b.opts };
  b.setPreset('round'); b.opts.size = 30; b.opts.smoothing = 0; b.opts.opacity = 100; b.opts.hardness = 100;
  app.setFg('#ffffff', { recent: false });
  await stroke([[40, 80], [160, 80]]);
  ok(near(comp(doc, 100, 80), [255, 0, 0, 255]) && near(comp(doc, 100, 20), [255, 255, 255, 255]), '白いブラシでマスクに描くと、そこだけ見える');
  ok(doc.history.list[doc.history.pos - 1].label.includes('マスク') && px0(red.canvas, 100, 20)[0] === 255, 'マスクに描いても画素は変わらない（履歴は「…（マスク）」）');
  app.cmd('mask.toggle');
  ok(near(comp(doc, 100, 20), [255, 0, 0, 255]), 'マスクを無効にすると全部見える');
  app.undo();
  app.cmd('mask.apply');
  ok(!red.mask && red.ctx.getImageData(100, 20, 1, 1).data[3] === 0 && near(comp(doc, 100, 80), [255, 0, 0, 255]), 'マスクを適用（画素に焼き込み）');
  app.undo();
  ok(!!red.mask, '適用を取り消せる');
  Object.assign(b.opts, keepB); LS.set('tool.brush', b.opts);

  // 2) クリッピング
  app.cmd('mask.delete');
  doc.editingMask = false;
  red.ctx.clearRect(0, 0, 200, 160); red.ctx.beginPath(); red.ctx.arc(100, 80, 40, 0, Math.PI * 2); red.ctx.fill(); red.ver++;
  app.cmd('layer.new');
  const blue = doc.active; blue.name = '青';
  fillRect(blue, '#0000ff', 0, 0, 200, 160); doc.invalidate();
  app.cmd('layer.clip');
  ok(blue.clip && near(comp(doc, 100, 80), [0, 0, 255, 255]) && near(comp(doc, 10, 10), [255, 255, 255, 255]), 'クリッピング: 下の円の形で切り抜かれる');
  doc.setLayerProps(red, { visible: false });
  ok(near(comp(doc, 100, 80), [255, 255, 255, 255]), '土台を隠すとクリップしたレイヤーも消える');
  app.undo(); app.undo();
  ok(!blue.clip, 'クリッピングを取り消せる');

  // 3) グループ（通過と通常）・調整レイヤー
  doc.setActive(blue);
  app.cmd('layer.delete');
  doc.setActive(red);
  app.cmd('layer.group');
  const grp = doc.active;
  ok(grp.isGroup && red.parent === grp.id && !doc.checkTree(), 'グループ化（木の決まりも守る）');
  doc.setActive(red);
  app.layerUI.newAdjustment('invert');           // 値の無い補正はそのまま作られる
  const inv = doc.active;
  ok(inv.isAdjustment && inv.parent === grp.id, 'グループの中に調整レイヤー（反転）');
  ok(near(comp(doc, 10, 10), [0, 0, 0, 255]) && near(comp(doc, 100, 80), [0, 255, 255, 255]), '通過モード: グループの外（白い背景）にも効く');
  doc.setLayerProps(grp, { blend: 'normal' });
  ok(near(comp(doc, 10, 10), [255, 255, 255, 255]) && near(comp(doc, 100, 80), [0, 255, 255, 255]), '通常モード: グループの中だけに効く');
  doc.setLayerProps(grp, { opacity: 0.5 });
  ok(near(comp(doc, 100, 80), [128, 255, 255, 255], 8), 'グループの不透明度');
  doc.setLayerProps(grp, { opacity: 1, blend: 'pass_through' });
  // 調整レイヤーの値を変える（パネル）→ OK で1手、キャンセルで元通り
  doc.setActive(inv);
  doc.setLayerProps(inv, { adjustment: { key: 'levels', params: defaultParams(ADJUSTMENTS.levels) } });
  const before = doc.history.pos;
  app.layerUI.editLayer(inv);
  app.adjust.params.out_white = 100;
  app.adjust.compute();
  const darker = comp(doc, 10, 10)[0];
  app.adjust.cancel();
  ok(darker < 200 && comp(doc, 10, 10)[0] === 255 && doc.history.pos === before, '調整レイヤーの値: プレビュー → キャンセルで元通り');
  app.layerUI.editLayer(inv);
  app.adjust.params.out_white = 100;
  app.adjust.ok();
  ok(comp(doc, 10, 10)[0] < 200 && doc.history.pos === before + 1, '調整レイヤーの値: OK で1手');
  // 調整レイヤーのマスク（描くと自動でマスクを作る）
  app.cmd('mask.hide');
  ok(comp(doc, 10, 10)[0] === 255, '調整レイヤーのマスクで効く範囲を絞る');
  app.cmd('mask.delete');

  // 4) グループの結合・解除
  const nBefore = doc.layers.length;
  doc.setActive(grp);
  app.cmd('layer.ungroup');
  ok(doc.layers.length === nBefore - 1 && red.parent == null && inv.parent == null, 'グループ解除');
  app.undo();
  doc.setActive(grp);
  app.cmd('layer.mergeGroup');
  ok(doc.layers.length === nBefore - 2 && grp.canvas && !grp.isGroup, 'グループを結合（1枚の画素に）');
  app.undo();
  ok(doc.layers.length === nBefore && grp.isGroup && !doc.checkTree(), '結合を取り消せる');
  doc.setActive(inv); app.cmd('layer.delete');

  // 5) レイヤースタイル
  doc.setActive(red);
  app.layerUI.openStyles(red);
  ok(app.layerUI.open, 'スタイルのパネルが開く');
  red.styles = { stroke: { ...styleDefaults('stroke'), size: 6, color: '#00ff00', position: 'outside' } };
  doc.invalidate();
  app.layerUI.ok();
  ok(near(comp(doc, 100 + 43, 80), [0, 255, 0, 255], 40) && near(comp(doc, 100, 80), [255, 0, 0, 255]), '境界線（外側）: 円の外に緑の縁');
  doc.setLayerProps(red, { styles: { drop_shadow: { ...styleDefaults('drop_shadow'), distance: 20, size: 0, angle: 90, opacity: 100 } } });
  ok(comp(doc, 100, 80 + 50)[0] < 60, 'ドロップシャドウ（下へ 20px）');
  app.undo(); app.undo();
  ok(!red.styles, 'スタイルを取り消せる');

  // 6) テキスト
  app.selectTool('text');
  await stroke([[20, 40], [20, 40]]);
  ok(app.layerUI.open && doc.active.isText, '文字ツール: タップで入力が始まる');
  const txt = doc.active;
  const ta = document.querySelector('.text-input');
  ta.value = 'テスト'; ta.dispatchEvent(new Event('input'));
  app.layerUI.ok();
  const area = (c) => { const d = ctx2d(c).getImageData(0, 0, 200, 160).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++; return n; };
  ok(txt.text.text === 'テスト' && area(txt.canvas) > 200 && txt.name === 'テスト', 'テキストレイヤーができる（名前も文字に）');
  const m0 = [...txt.text.matrix];
  app.selectTool('move');
  await stroke([[40, 40], [60, 50]]);
  ok(Math.abs(txt.text.matrix[4] - m0[4] - 20) < 0.01 && Math.abs(txt.text.matrix[5] - m0[5] - 10) < 0.01, '移動ツールで動かすと行列が変わる（描き直し）');
  app.selectTool('transform');
  const T = app.tools.transform;
  ok(T.state && T.state.text, '自由変形をテキストに');
  T.state.quad = T.state.quad.map((p) => ({ x: T.state.quad[0].x + (p.x - T.state.quad[0].x) * 2, y: T.state.quad[0].y + (p.y - T.state.quad[0].y) * 2 }));
  T.commit();
  ok(txt.isText && Math.abs(txt.text.matrix[0] - 2) < 0.01, 'テキストを2倍に（文字のまま）');
  app.undo();
  app.layerUI.openText(txt);
  const ta2 = document.querySelector('.text-input');
  ta2.value = 'テスト2'; ta2.dispatchEvent(new Event('input'));
  app.layerUI.ok();
  ok(txt.text.text === 'テスト2', 'テキストを直す');
  doc.setActive(txt);
  app.selectTool('brush');
  ok(!!app.cannotEdit(app.tools.brush), 'テキストレイヤーにはブラシで描けない（案内が出る）');
  app.cmd('layer.rasterize');
  ok(!txt.isText && !app.cannotEdit(app.tools.brush), 'ラスタライズすると描ける');
  app.undo();

  // 7) 保存して読み込み（すべての属性とマスク）
  doc.setActive(red);
  app.cmd('mask.add');
  doc.editingMask = false;
  red.mask.getContext('2d').clearRect(0, 0, 100, 160); red.ver++;
  doc.setLayerProps(red, { clip: false, styles: { stroke: { ...styleDefaults('stroke'), size: 3 } } });
  doc.setActive(grp);
  app.layerUI.newAdjustment('posterize');
  app.adjust.ok();
  const before7 = ctx2d(doc.flattened()).getImageData(0, 0, 200, 160).data;
  await app.saveNow();
  const { doc: d2 } = await Store.loadDoc(doc.workId);
  const after7 = ctx2d(d2.flattened()).getImageData(0, 0, 200, 160).data;
  let diff = 0; for (let i = 0; i < before7.length; i++) diff = Math.max(diff, Math.abs(before7[i] - after7[i]));
  const R = d2.layers.find((l) => l.name === '赤'), G = d2.layers.find((l) => l.isGroup), A = d2.layers.find((l) => l.isAdjustment), X = d2.layers.find((l) => l.isText);
  ok(R && R.mask && R.styles && R.parent === G.id && A && A.parent === G.id && A.adjustment.key === 'posterize' && X && X.text.text === 'テスト2', '保存→読み込みで属性・マスク・親子が残る');
  ok(diff <= 2, `読み込んだ絵が同じ（最大差 ${diff}）`);
  ok(!d2.checkTree(), '読み込んだ木の形が正しい');

  // 8) レイヤー一覧の表示
  app.layersPanel.render();
  const items = $$('#layerList .layer-item');
  ok(items.some((i) => i.querySelector('.twisty')) && items.some((i) => i.querySelector('.indent')) && items.some((i) => i.querySelector('.mask')), '一覧: グループの開閉・字下げ・マスクの小窓');
  grp.group = { ...grp.group, collapsed: true }; app.layersPanel.render();
  ok($$('#layerList .layer-item').length < items.length, 'グループを閉じると中身が隠れる');
  grp.group = { ...grp.group, collapsed: false };

  const id = doc.workId;
  await app.closeDoc();
  await Store.remove(id);
  await app.showGallery();
  app.selectTool('brush');
  const fails = out.filter((l) => l.startsWith('FAIL')).length;
  return out.join('\n') + `\n---- ${out.length - fails} OK / ${fails} FAIL`;
}
function px0(c, x, y) { return Array.from(ctx2d(c).getImageData(x, y, 1, 1).data); }


/* フェーズ4: .sko（exe 版との往復）
   exe との比べ方: python tools/make_sko_fixture.py で exe_sample.sko / .png を作っておく（無ければその項目は飛ばす）。
   Web → exe は、このテストが web_sample.sko / .png を tools/fixtures に PUT する（tools/devserver.py が受け取る）ので、
   続けて python tools/make_sko_fixture.py --check tools/fixtures/web_sample.sko tools/fixtures/web_sample.png */
function buildWebSample() {
  const W = 240, H = 180;
  const doc = new Doc(W, H, { name: 'web_sample' });
  doc.history.clear('新規');
  const g0 = doc.layers[0].ctx, gr = g0.createLinearGradient(0, 0, W, H);
  gr.addColorStop(0, '#203a43'); gr.addColorStop(1, '#2c5364'); g0.fillStyle = gr; g0.fillRect(0, 0, W, H);
  const mk = (name, draw, setup) => { const l = new Layer(W, H, name); if (draw) draw(l.ctx); if (setup) setup(l); doc.insertAbove(l, doc.active); doc.activeId = l.id; return l; };
  const C = mk('円', (g) => { g.fillStyle = '#f7b733'; g.beginPath(); g.arc(80, 90, 45, 0, Math.PI * 2); g.fill(); }, (l) => {
    l.styles = { stroke: { ...styleDefaults('stroke'), size: 5, color: '#ffffff' }, drop_shadow: { ...styleDefaults('drop_shadow'), distance: 8, size: 6 },
      inner_shadow: { ...styleDefaults('inner_shadow'), distance: 4, size: 4 } };
  });
  mk('しま', (g) => { g.fillStyle = 'rgba(200,30,30,.5)'; for (let x = 0; x < W; x += 14) g.fillRect(x, 0, 5, H); }, (l) => { l.clip = true; });
  doc.setActive(C); doc.groupLayer(C);
  const G = doc.active; G.blend = 'normal'; G.opacity = 0.9;
  const T = new Layer(W, H, '文字');
  T.text = makeTextSpec('彩工房', 120, 110, { size: 40, color: '#ffffff', bold: true });
  T.canvas = renderTextSpec(T.text, W, H);
  T.styles = { outer_glow: { ...styleDefaults('outer_glow'), size: 6 }, color_overlay: { ...styleDefaults('color_overlay'), color: '#ffe680', opacity: 50 } };
  doc.insertAbove(T, G); doc.activeId = T.id;          // 開いたグループの「上」= グループの中の一番上
  const M = mk('スクリーン', (g) => { g.fillStyle = '#3070ff'; g.beginPath(); g.arc(180, 60, 40, 0, Math.PI * 2); g.fill(); }, (l) => { l.blend = 'screen'; l.opacity = 0.8; });
  M.mask = newCanvas(W, H);
  { const mg = M.mask.getContext('2d'), m2 = mg.createLinearGradient(140, 0, 220, 0); m2.addColorStop(0, 'rgba(255,255,255,0)'); m2.addColorStop(1, '#fff'); mg.fillStyle = m2; mg.fillRect(0, 0, W, H); }
  const A = new Layer(W, H, 'レベル', null, { kind: 'adjustment' });
  A.adjustment = { key: 'levels', params: { ...defaultParams(ADJUSTMENTS.levels), in_black: 15, gamma: 1.2 } };
  doc.insertAbove(A, M);
  const B = new Layer(W, H, '白黒', null, { kind: 'adjustment' });
  B.adjustment = { key: 'black_white', params: defaultParams(ADJUSTMENTS.black_white) };
  B.opacity = 0.35;
  doc.insertAbove(B, A);
  doc.compDirty = doc.fullRect;
  return doc;
}
function imageDiff(a, b) {
  let sum = 0, mx = 0, over = 0;
  for (let i = 0; i < a.length; i += 4) {
    let m = 0;
    for (let k = 0; k < 4; k++) { const d = Math.abs(a[i + k] - b[i + k]); sum += d; m = Math.max(m, d); }
    mx = Math.max(mx, m); if (m > 8) over++;
  }
  return { mean: sum / a.length, max: mx, overPct: over / (a.length / 4) * 100 };
}
async function saikoboSelfTest4() {
  const out = [];
  const ok = (cond, msg) => { out.push((cond ? 'OK   ' : 'FAIL ') + msg); };
  const pixels = (c) => ctx2d(c).getImageData(0, 0, c.width, c.height).data;

  // 1) ZIP の読み書き
  const enc = new TextEncoder();
  const z = zipStore([{ name: 'a.txt', data: enc.encode('こんにちは') }, { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255]) }]);
  const back = await unzip(z);
  ok(await back['a.txt'].text() === 'こんにちは' && new Uint8Array(await back['dir/b.bin'].arrayBuffer())[3] === 255, 'ZIP（無圧縮）を書いて読める・日本語の名前');
  ok(crc32(enc.encode('123456789')) === 0xCBF43926, 'CRC32（標準の検査値）');
  if (window.CompressionStream) {
    // deflate の ZIP も読めるか（中身を CompressionStream で作る）
    const raw = enc.encode('圧縮のテスト'.repeat(50));
    const comp = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const zb = new Uint8Array(await zipStore([{ name: 'c.txt', data: comp }]).arrayBuffer());
    const dv = new DataView(zb.buffer);
    dv.setUint16(8, 8, true); dv.setUint32(22, raw.length, true);                   // 局所ヘッダ: 方式 = deflate
    const cd = zb.length - 22 - 46 - 5;
    dv.setUint16(cd + 10, 8, true); dv.setUint32(cd + 24, raw.length, true);       // 目次: 方式 = deflate
    const r = await unzip(new Blob([zb]));
    ok(await r['c.txt'].text() === '圧縮のテスト'.repeat(50), 'deflate で圧縮された ZIP も読める');
  }

  // 2) .sko を書いて読む（Web の中で往復）
  const doc = buildWebSample();
  const sko = await docToSko(doc);
  const files = await unzip(sko);
  const meta = JSON.parse(await files['document.json'].text());
  ok(meta.format === 'saikobo' && meta.version === 4 && meta.layers.length === doc.layers.length && files['composite.png'], 'document.json・composite.png（exe と同じ形）');
  ok(meta.layers.filter((e) => e.file === null).length === 3 && meta.layers.some((e) => e.mask_file), 'グループ・調整レイヤーは画素なし、マスクは masks/');
  const { doc: d2 } = await docFromSko(sko, 'web_sample');
  const diff = imageDiff(pixels(doc.flattened()), pixels(d2.flattened()));
  ok(diff.max <= 3 && !d2.checkTree() && d2.layers.find((l) => l.isText).text.text === '彩工房', `書いて読んで同じ絵（最大差 ${diff.max}）・木・テキスト`);
  const gray = await blobToImage(files[meta.layers.find((e) => e.mask_file).mask_file]);
  const gc = newCanvas(gray.width, gray.height); ctx2d(gc).drawImage(gray, 0, 0);
  const gp = ctx2d(gc).getImageData(230, 10, 1, 1).data, gq = ctx2d(gc).getImageData(10, 10, 1, 1).data;
  ok(gp[3] === 255 && gp[0] > 240 && gq[0] < 10, 'マスクは灰色の PNG（白 = 見える）');

  // 3) exe で作った .sko を開く（exe の合成結果と比べる）
  const res = await fetch('/tools/fixtures/exe_sample.sko');
  if (res.ok) {
    const { doc: e, notes } = await docFromSko(await res.blob(), 'exe_sample');
    const img = await blobToImage(await (await fetch('/tools/fixtures/exe_sample.png')).blob());
    const c = newCanvas(img.width, img.height); ctx2d(c).drawImage(img, 0, 0);
    const dd = imageDiff(pixels(e.flattened()), pixels(c));
    ok(e.layers.length === 11 && !e.checkTree() && notes.length === 0, 'exe の .sko: 11 枚・グループ・調整・テキストを読める');
    ok(dd.overPct < 0.1 && dd.mean < 1.5, `exe の合成と同じ絵（平均差 ${dd.mean.toFixed(2)}・最大差 ${dd.max}・8 を超える画素 ${dd.overPct.toFixed(2)}%）`);
  } else out.push('SKIP exe_sample.sko が無い（python tools/make_sko_fixture.py で作る）');

  // 4) Web の .sko を exe 用に置く
  try {
    const put = (name, blob) => fetch('/tools/fixtures/' + name, { method: 'PUT', body: blob }).then((r) => r.status);
    const s1 = await put('web_sample.sko', sko), s2 = await put('web_sample.png', await canvasToBlob(doc.flattened()));
    out.push(s1 === 201 && s2 === 201 ? 'INFO web_sample.sko を置いた → python tools/make_sko_fixture.py --check で exe と比べる' : 'SKIP 受け取りサーバーが無い（tools/devserver.py）');
  } catch { out.push('SKIP 受け取りサーバーが無い'); }

  // 5) 作品として開いて保存できる
  const before = (await Store.list()).length;
  await app.openFile(new File([sko], 'web_sample.sko'));
  ok(app.doc && app.doc.name === 'web_sample' && app.doc.layers.length === doc.layers.length, 'ファイルを開く（.sko）で新しい作品になる');
  await app.saveNow();
  ok((await Store.list()).length === before + 1, '開いた作品は作品一覧に保存される');
  const id = app.doc.workId;
  await app.closeDoc(); await Store.remove(id); await app.showGallery();

  const fails = out.filter((l) => l.startsWith('FAIL')).length;
  return out.join('\n') + `\n---- ${out.filter((l) => l.startsWith('OK')).length} OK / ${fails} FAIL`;
}
