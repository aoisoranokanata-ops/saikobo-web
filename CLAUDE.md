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

## 設計の要点（フェーズ2）
- ペンの種類 = `BRUSH_PRESETS`（tools.js）。筆圧→太さは `min + (1-min)·p^gamma`、1点の濃さ = flow、紙の質感 = grain。
  質感は**紙に固定した模様**（256px のつなぎ目無しノイズ）で筆跡を destination-out で削る（applyTo の中、プレビューも確定も同じ）。
  種類を選ぶと硬さ・筆圧の設定もその種類の標準に変わる（サイズは変えない、マーカーだけ不透明度 60%）。
- 色調補正・フィルター（js/adjust.js）は **exe 版 core/adjust.py と同じキー・同じ引数・同じ式**（フェーズ3の調整レイヤーと .sko 往復で使う）。
  `tools/make_fixtures.py` が exe の結果を PNG にし、Web 版と比べると不透明部分の差は ±1（色相・彩度は量子化で最大7、輪郭検出は端の扱いで端だけ差）。
  Web 版だけの追加: 色温度・色かぶり（`color_temperature`、exe には無いので調整レイヤーにするときは注意）。
  exe にあって Web に無い: ノイズを軽減（NLMeans）。
- 補正パネル（js/adjustui.js）は絵の上に浮かぶ非モーダル。プレビューは作業用 canvas（doc.live）に書くだけで、OK で editPixels 1手。
  選択範囲があればその範囲だけ・アルファで元と混ぜる（`runSpec`、ぼかし系は pad だけ外側も読む）。
  開いている間は描けない・取り消しはパネルを閉じる・ほかのコマンドの前に閉じる（`app.settle()`）。
- 自由変形・切り抜きは「選んでいる間だけ状態を持つ道具」（activate / deactivate）。変形は四角形 quad（左上・右上・右下・左下）で持ち、
  平行四辺形なら canvas の transform 1回、そうでなければ射影変換を n×n の三角形に分けて描く（隙間対策で三角形を 0.7px 広げる）。
  確定は新しい canvas に差し替える change 1手、選択範囲も同じ変換。確定・キャンセル後は前の道具に戻る（prevTool）。

## 設計の要点（フェーズ3: 非破壊）
- レイヤーの属性は exe と同じ名前: mask_enabled・text・adjustment・styles・clip・group・parent（`LAYER_PROPS`）。辞書は差し替えて使う。
  グループ・調整レイヤーは `canvas = null`（画素なし。.sko でも file: null）。`layer.kind` / `isGroup` / `isAdjustment` / `isText`。
- **doc.layers は一列のまま**、グループの中身は本体の真下に連続（exe・PSD と同じ）。並べ替えは `blockRange()` 単位で
  `placeLayer(layer, anchor, 'above'|'below'|'into')`、▲▼は `moveLayer(layer, 'up'|'down')`（端でグループの外へ）。`checkTree()` で検査。
- 合成は js/layerfx.js（exe core/blend.py と同じ順序）: 木にして再帰、通過グループは外と直接、通常グループは中だけで合成して重ねる、
  クリッピングは直前の土台の形（土台が非表示なら一緒に消える）、調整レイヤーはそこまでの結果を読み出して補正し、マスク×不透明度で混ぜる。
  **作業用 canvas はすべて「合成範囲 rect の大きさ」**（(0,0) = rect の左上）。文書大の一時 canvas を増やさない（iPad のメモリ）。
- マスク = 白・アルファ（見える度合い）の canvas。保存は exe と同じ灰色 PNG（`maskToGray` / `maskFromImage` は両形式を読める）。
  マスクへの描き込みは `paintMask`: destination-out で減らしてから lighter で白を足す（new = old·(1−a) + 灰色·a）。
  描く道具の描き込み先は `app.paintTarget()`（マスク編集中・調整レイヤー → マスク。調整レイヤーにマスクが無ければ自動で作る）。
- スタイルは exe と同じ5種・同じ重ね順・**同じ式**（ずらす＝双線形、太らせる・細らせる＝OpenCV の MORPH_ELLIPSE と同じ窓の
  明るさの最大・最小（24px を超えると距離変換で代用）、ぼかし＝σ=サイズ/2 のガウス（外側は 0）、境界線は σ0.5 でなじませる）。
  canvas の影（shadowBlur）で近似していた時は境界線が半ピクセル細く、光彩も最大 24 ずれていた。
- テキストは exe と同じ spec（text, font, size, color, bold, italic, align, line_spacing, matrix）。行送り = (ascent+descent)·line_spacing。
  画素は spec から描き直す（移動・自由変形・画像全体の回転/拡大は行列を変えて描き直すのでぼやけない）。exe で描いた画素は直すまでそのまま。
  フォント名は exe（Windows）と iPad で違うので、無いものは「ヒラギノ角ゴ → 游ゴシック → sans-serif」に落ちる。
- 「開いて値を変える」画面（スタイル・テキスト・調整レイヤー）は、開いた時の `doc.snapshot()` を持ち、値は直接レイヤーに入れて画面に出す。
  OK で `doc.commitFrom(label, before)` の1手、キャンセルで `doc.restore(before)`（履歴に残さない）。

## 設計の要点（フェーズ4: .sko で exe と往復）
- js/sko.js: 無圧縮 ZIP の読み書き（CRC32 自前、deflate の ZIP も DecompressionStream で読める）。中身は exe の save_native と同じ
  （document.json・layers/・masks/（灰色）・selection.png・composite.png）。exe が読まない属性は extra として書き、読み込み時も保つ。
- 開く: ファイル ＞ ファイルを開く（.sko・画像）／作品一覧の「ファイルを開く」。開いた .sko は新しい作品として IndexedDB に入る。
  書き出し: ファイル ＞ 彩工房ファイル（.sko）で書き出し（iPad は共有シート →「ファイルに保存」で iCloud Drive など）。
- **exe と同じ絵になるかの確かめ方**（2026-10-17 時点: exe→Web 平均差 0.63・最大 9、Web→exe 平均差 0.21・最大 6、8 を超える画素 0%）:
  1. `python tools/make_sko_fixture.py` … exe のコードで「グループ・通過・クリッピング・マスク・調整・スタイル・テキスト」入りの
     exe_sample.sko と exe の合成 PNG を tools/fixtures/ に作る
  2. プレビューで `saikoboSelfTest4()` … exe_sample を開いて比べ、Web で作った web_sample.sko を PUT で fixtures に置く
  3. `python tools/make_sko_fixture.py --check tools/fixtures/web_sample.sko tools/fixtures/web_sample.png` … exe で開いて合成して比べる
- 開発サーバーは `tools/devserver.py`（キャッシュさせない＋ fixtures への PUT を受け取る。127.0.0.1 だけ）。launch.json の saikobo-web がこれ。
  素の http.server だと直した js が古いまま読まれることがあった（Cache-Control が無いので）。

## ハマり所（実測）
- **Uint8ClampedArray は代入時に四捨五入する**（偶数丸め）。`v + 0.5` を足すと半段ずれる（反転で 127 が 128 になった）。
  Uint8Array（切り捨て）とは違うので、書き込み先の型で丸め方を変えること。
- フレックスの中の要素は、はみ出すと縮んで消える → オプションバーは `#optbar > * { flex-shrink: 0 }` で横スクロールにした。
- **Canvas の destination-in / source-in / copy は、描いた画像の範囲の外も消す**（範囲外のソースは透明扱い）。
  一部の範囲だけに効かせたいときは先に `clip()` で範囲を絞る（ブラシの選択範囲切り抜きで一度やらかした）。
- 引数の既定値は `undefined` を渡すと効いてしまう → 「レイヤー無しで作る」は `new Doc(w, h, {empty: true})`。
- 保存は `saveNow()` が順番待ちの Promise（`_saveChain`）。保存中に呼ばれても「呼んだ時点までの変更」が書かれてから解決する。
  未保存かどうかは `doc.rev !== doc._savedRev`。rev は doc.emit のたび（'view' 以外）に増える → 名前の変更などは `doc.emit('meta')`。
- プレビューのペインが隠れていると requestAnimationFrame が来ない → 自己テストは setTimeout で待つ。

## テスト
- `tools/selftest.js`: 疑似的なペン・タッチ入力で確かめる。`saikoboSelfTest()`（フェーズ1: 描画・ジェスチャー・選択・移動・レイヤー・
  画像操作・保存/読み込み 30項目）と `saikoboSelfTest2()`（フェーズ2: ペンの種類・補正パネル・フィルター・自由変形・切り抜き 24項目）、
  `saikoboSelfTest3()`（フェーズ3: マスク・クリッピング・グループ・調整レイヤー・スタイル・テキスト・保存の往復 37項目）、
  `saikoboSelfTest4()`（フェーズ4: ZIP・.sko の往復・exe の .sko との比較 11項目）。
  プレビューで `<script src="/tools/selftest.js">` を読み込んでから await で呼ぶ。終わると作った作品は消す。
- exe と同じ結果か: `python tools/make_fixtures.py` → プレビューで fixtures/input.png に `findSpec(key).fn` をかけ、index.json の各期待値 PNG と不透明部分の差を見る（2026-10-16 時点で ±1）。
- アイコン: `python tools/make_icons.py`（exe 版と同じ絵）

## 起動・確認
- 開発: `APP/.claude/launch.json` の `saikobo-web`（port 8674、tools/devserver.py）。localhost では sw.js を登録しない（`?sw=1` で強制）。
- 更新時は `sw.js` の VERSION と `js/app.js` の APP_VERSION を両方上げる。
