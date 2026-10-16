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
  l2.extra = { styles: { stroke: { size: 3 } } };
  await app.saveNow();
  const { doc: d2 } = await Store.loadDoc(doc.workId);
  ok(d2.layers.length === doc.layers.length && d2.width === 400, '保存して読み込める（レイヤー数・大きさ）');
  const L = d2.layers.find((l) => l.name === '上の層');
  ok(L && L.blend === 'screen' && Math.abs(L.opacity - 0.7) < 1e-6 && L.extra.styles && L.extra.styles.stroke.size === 3, '属性と exe の属性（extra）も残る');
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
