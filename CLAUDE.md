# 彩工房 Web（saikobo-web）— iPad で動くモバイル版

exe 版 `../saikobo/`（PySide6）のブラウザ版。主な使い道は iPad（Safari／ホーム画面に追加した PWA）。
Apple Pencil の筆圧・指のジェスチャーで描ける画像編集アプリ。exe にしか載せられない機能は省く。

## 方針
- **ビルドなし・外部ライブラリなし**。`index.html` ＋ `css/app.css` ＋ `js/*.js`（**普通の script。module にしない**
  → file:// で開いても動く）。各 js のトップレベル宣言はグローバルで共有される（読み込み順に注意）。
- 公開は GitHub Pages（`aoisoranokanata-ops/saikobo-web`、ブランチ main）。iPad はローカル HTML を開けないため。
- データは IndexedDB `saikobo-web`（作品ギャラリー）。localStorage のキーは `saikobo-web.` 始まり。
  Pages は他の PWA と同じオリジンなので、sw.js は**自分の接頭辞 `saikobo-web-` のキャッシュだけ**消す・参照する。
- 文書の持ち方は exe 版の .sko（document.json＋レイヤー PNG）と同じ形に寄せる → フェーズ4で .sko を読み書きして exe と往復。
  Web 版が扱えない属性（text / adjustment / styles / mask など）は `layer.extra` にそのまま持って捨てない。

## exe 版から省くもの
Claude Code 連携（MCP・アプリ内の claude -p）、ComfyUI 連携（CORS・LAN）、被写体選択の GrabCut（OpenCV）、
PSD は後回し（フェーズ4で検討）、16bit・ICC 変換（ブラウザ任せ）。

## 設計の要点（フェーズ1）
- レイヤー = 文書と同じ大きさの `<canvas>`。合成は Canvas 2D の `globalCompositeOperation`（GPU）。
  Canvas に無い描画モード（ディザ合成・焼き込みリニア・ビビッドライト等）は近い式で代用し、メニューに「≈」を付ける。
  モード名は exe と同じキー（normal, multiply, ...）で持つので .sko の往復で失われない。
- 表示: 画面の `<canvas id=view>` に、合成済みの `doc.comp` を view 変換（拡大率・位置）で描く。
  合成は汚れた矩形だけやり直す（`doc.invalidate(rect)`）。
- ブラシ: 1ストロークを `stroke` バッファ（文書大）に描いてから、レイヤーに不透明度付きで重ねる
  （1ストローク内の重なりで濃くならない）。消しゴムは destination-out、透明部分ロックは source-atop。
  選択範囲があればバッファを destination-in で切り抜く。
- 選択範囲 = `null`（全体）か `{canvas, bounds}`（アルファ = 選択度）。**不変として扱い、変えるときは作り直す**（履歴が参照を持つ）。
- 履歴: 画素は「変更前の写し canvas（doc.backup）から矩形の ImageData を取る」PixelCmd、
  構造（順序・属性・canvas の差し替え・選択範囲・サイズ）は snapshot 同士の StateCmd。
  サイズが変わる・全体を作り直す操作は**新しい canvas を作って差し替える**（参照の差し替えで undo できる）。
  履歴のメモリは概算で上限（古いものから捨てる）。
- ジェスチャー: 2本指でつまむ＝拡大縮小・移動、2本指タップ＝取り消し、3本指タップ＝やり直し。
  Apple Pencil を一度使うと「指では描かない」モード（1本指＝画面の移動）に自動で切り替わる（設定で変更可）。
- iOS Safari の canvas メモリ上限に注意: 文書は長辺 4096px まで、レイヤー数の目安を表示。

## フェーズ
1. 基盤: 作品ギャラリー・キャンバス表示とジェスチャー・レイヤー（追加/複製/削除/並べ替え/不透明度/描画モード/結合）・
   ブラシ/消しゴム（筆圧）・スポイト・塗りつぶし・グラデーション・選択（矩形/楕円/なげなわ/自動選択）と選択範囲の操作・
   移動・取り消し・画像の回転/反転/サイズ/切り抜き・写真の読み込み・PNG/JPEG 書き出し（共有シート）・自動保存・PWA
2. 色調補正とフィルター（プレビュー付き）・自由変形・切り抜きツール
3. 非破壊: レイヤーマスク・テキストレイヤー・調整レイヤー・レイヤースタイル・クリッピング・グループ
4. 互換: .sko 読み書き（exe と往復）、必要なら PSD
5. 仕上げ: iPad 実機での描き味・性能調整、README

## ハマり所（実測）
- **Canvas の destination-in / source-in / copy は、描いた画像の範囲の外も消す**（範囲外のソースは透明扱い）。
  一部の範囲だけに効かせたいときは先に `clip()` で範囲を絞る（ブラシの選択範囲切り抜きで一度やらかした）。
- 引数の既定値は `undefined` を渡すと効いてしまう → 「レイヤー無しで作る」は `new Doc(w, h, {empty: true})`。
- 保存は `saveNow()` が順番待ちの Promise（`_saveChain`）。保存中に呼ばれても「呼んだ時点までの変更」が書かれてから解決する。
  未保存かどうかは `doc.rev !== doc._savedRev`。rev は doc.emit のたび（'view' 以外）に増える → 名前の変更などは `doc.emit('meta')`。
- プレビューのペインが隠れていると requestAnimationFrame が来ない → 自己テストは setTimeout で待つ。

## テスト
- `tools/selftest.js`: 疑似的なペン・タッチ入力で描画・ジェスチャー・選択・移動・レイヤー・画像操作・保存/読み込みを確かめる（30項目）。
  プレビューで `<script src="/tools/selftest.js">` を読み込んでから `await saikoboSelfTest()`。終わると作った作品は消す。
- アイコン: `python tools/make_icons.py`（exe 版と同じ絵）

## 起動・確認
- 開発: `APP/.claude/launch.json` の `saikobo-web`（port 8674）。localhost では sw.js を登録しない（`?sw=1` で強制）。
- 更新時は `sw.js` の VERSION と `js/app.js` の APP_VERSION を両方上げる。
