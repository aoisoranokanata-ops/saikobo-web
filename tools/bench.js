/* 速さの測定（プレビューで <script src="/tools/bench.js"> を読み込んでから await saikoboBench()）。
   重い作品（2048×1536・12 枚: 調整レイヤー・スタイル・グループ・マスク入り）で、
   ・全体の合成 1 回
   ・ブラシで描く 1 コマ分（描いた範囲の合成）
   の時間を測る。iPad の実機はこの数倍かかる目安。 */
async function saikoboBench({ w = 2048, h = 1536, frames = 60 } = {}) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (app.doc) await app.closeDoc();
  const doc = new Doc(w, h, { name: 'bench' });
  doc.history.clear('新規');
  app.openDoc(doc);
  await wait(50);
  const mkPix = (name, fn, setup) => { const l = new Layer(w, h, name); fn(l.ctx); if (setup) setup(l); doc.insertAbove(l, doc.active); doc.activeId = l.id; return l; };
  const g0 = doc.layers[0].ctx; g0.fillStyle = '#88aacc'; g0.fillRect(0, 0, w, h);
  for (let i = 0; i < 4; i++) mkPix('絵 ' + i, (g) => { g.fillStyle = `hsl(${i * 80},70%,50%)`; g.beginPath(); g.arc(300 + i * 400, 500 + i * 120, 260, 0, Math.PI * 2); g.fill(); }, (l) => { if (i === 1) l.styles = { stroke: { ...styleDefaults('stroke'), size: 6 }, drop_shadow: { ...styleDefaults('drop_shadow') } }; if (i === 2) l.blend = 'multiply'; });
  const target = mkPix('描く層', () => {});
  for (let i = 0; i < 3; i++) mkPix('上 ' + i, (g) => { g.fillStyle = 'rgba(255,255,255,.3)'; g.fillRect(100 + i * 500, 100, 300, 1200); });
  const adj = new Layer(w, h, '色相', null, { kind: 'adjustment' });
  adj.adjustment = { key: 'hue_saturation', params: { ...defaultParams(ADJUSTMENTS.hue_saturation), hue: 15 } };
  doc.insertAbove(adj, doc.active);
  const t = new Layer(w, h, '文字'); t.text = makeTextSpec('Bench', 200, 1200, { size: 160, color: '#fff', bold: true }); t.canvas = renderTextSpec(t.text, w, h);
  t.styles = { outer_glow: { ...styleDefaults('outer_glow'), size: 10 } };
  doc.insertAbove(t, adj);
  doc.activeId = target.id;
  doc.compDirty = doc.fullRect;

  const res = {};
  let t0 = performance.now();
  doc.renderInto(doc.comp, doc.fullRect);
  res.fullComposite = Math.round(performance.now() - t0);

  // ブラシ: down → frames 回 move（1コマごとに描いた範囲を合成）→ up
  app.selectTool('brush');
  const b = app.tools.brush, keep = { ...b.opts };
  b.setPreset('round'); b.opts.size = 40; b.opts.smoothing = 0;
  const times = [];
  b.down({ x: 400, y: 300, pressure: 0.8, type: 'pen' });
  doc.composite();
  for (let i = 1; i <= frames; i++) {
    const p = { x: 400 + i * 20, y: 300 + Math.sin(i / 6) * 200, pressure: 0.8, type: 'pen' };
    t0 = performance.now();
    b.move(p);
    doc.composite();
    times.push(performance.now() - t0);
  }
  t0 = performance.now();
  b.up({ x: 400 + frames * 20, y: 300, pressure: 0.8 });
  doc.composite();
  res.strokeCommit = Math.round(performance.now() - t0);
  times.sort((a, z) => a - z);
  res.frameMedian = +times[Math.floor(times.length / 2)].toFixed(1);
  res.frameP90 = +times[Math.floor(times.length * 0.9)].toFixed(1);
  Object.assign(b.opts, keep); LS.set('tool.brush', b.opts);
  res.memMB = Math.round(estimateMemory(doc) / 1048576);
  const id = doc.workId;
  await app.closeDoc();
  if (id) await Store.remove(id);
  await app.showGallery();
  return res;
}
/** だいたいのメモリ（canvas の画素）: レイヤー・マスク・作業用 */
function estimateMemory(doc) {
  const px = doc.width * doc.height * 4;
  let n = 0;
  for (const l of doc.layers) { if (l.canvas) n++; if (l.mask) n++; }
  return px * (n + 5);
}
