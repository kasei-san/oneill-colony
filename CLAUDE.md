# CLAUDE.md

オニール型スペースコロニーの内側を一人称で歩ける Three.js デモ（趣味プロジェクト）。概要・操作・世界の構成は README.md、架空の歴史は docs/history.md。

## 方針

- 見た目は「ゲーム的にそれっぽく」が優先。物理的な正しさより、低ポリゴンでも広く密に見えることを重視する（遠景は書割的なごまかしで良い）
- カメラ周辺だけ詳細化し、遠くは軽くする（LOD）。60FPS を保つ（旧市街の近くは 40〜50 台に落ちる。要注意）
- ビルド工程なし。`index.html` 1ファイルに全部入っている。Three.js r170 を CDN の importmap で読み込む
- 街の配置・設定（年表、地区の由来）を変えたら docs/history.md とガイドツアーの字幕も合わせる

## コード構成（index.html 内のおおまかな順）

1. 寸法・座標系: 軸は Z、遠心「重力」は軸から外向き。地面は半径 `R`、局所フレームは x=東(θ増加)・y=上(軸向き)・z=北(+Z)。`writeBox(th, z, h0, w, h, d)` がこのフレームで箱を置く。街区は `sCenter(i)` / `zCenter(j)`、街区ピッチ `P`=110m
2. 配置の定数: `ZONE`（農業・工業・旧市街の帯の境目）と `oldEndAt(k,i)`、`RESORT`（観覧車）、`RIVERSIDE`（屋台通り）、`HUB_Z`（中央駅）、`ZG_Z`（無重力パーク）、`BRIDGE_Z`（橋と環状線の z）
3. 霧（`fog_*` チャンクを差し替えた円筒用の空気遠近法）と照明
4. `patch(mat, opts)` — MeshStandardMaterial に注入する共通シェーダ。opts: building（窓・部屋の擬似表示・AO・縁・旧市街の小窓と汚れ）/ ground（近景ディテール・夜の街灯・歓楽街のネオン道路）/ wind（木の揺れ・公園のスポットライト）/ vehicle（電車。窓を車体に固定）/ carGlow（車のライト）
5. 街の生成 `genStrip(k)`: 街区ごとに type を決め（plaza, resort, river, park, farm, factory, oldtown, oldClean, redev, down, mid, res, shop, school, temple, forest, campus, danchi …）、チャンク（`getChunk`）の配列に積む（bld, roof, tree, far, cyl, saw, car, plain, sph, cooling）。`landmarks` に見本の位置などを記録
6. `build()`: チャンクを InstancedMesh にする（近景/遠景）。`buildDetail()` はカメラ周辺の街区だけ細部（屋上設備・庇・旧市街の室外機や洗濯物・細かい木）を後から作る
7. 構造物・窓ガラス・キャップ・雲・宇宙側（星・ミラー・太陽・外殻・入口・誘導灯・外の宇宙船・兄弟コロニー）・船・軸の電車・地上の電車と駅（`stepTrains` で速度を積分、駅でランダム停車）・観光名所（`buildLandmarks`, `buildHubStation`, `buildResort`, `buildRiverside`, `buildNeonSigns`, `buildAdScreens`, `buildProtestBanners`）・周辺の車/人/鳥
8. ポストエフェクト（自前: AO → 被写界深度 → ブルーム → トーンマップ・色調整・ディザ）
9. 昼夜（`updateDayNight()`）、プレイヤー操作、`PRESETS`（ワープ）、ミニマップ、音（環境音・BGM とも WebAudio 合成）
10. ガイドツアー `SHOTS`: 1場面 = `{ ch, t, x, dur, from, d }`（地上: from で開始位置、d で移動量）または `space: { mode, from, to, target }`（宇宙）。`follow` でカメラを毎フレーム動かす場面もある。開始位置のヘルパー: `preset(ラベル)`, `lookAt(k, as, az, bs, bz, h)`, `atSample(type)`

## はまりどころ

- `onBeforeCompile` 時点では `#include` は未展開。チャンク内の文字列を書き換えるときは `THREE.ShaderChunk.xxx` を展開してから置換する
- 同じ `onBeforeCompile` を引数違いで使うときは `customProgramCacheKey` を分ける（さもないとプログラムが共有される）
- シェーダの注入は JS のテンプレート文字列。シングルクォートの文字列の中に改行を入れると構文エラーでページごと止まる。注入したシェーダ内の変数のスコープ（ブロック内で宣言した変数を別の注入箇所で使わない）にも注意
- ShaderMaterial はトーンマップ・sRGB 関数を自動で前置する。自分で `#include` すると二重定義エラー
- log depth buffer を使っているので、後処理で距離が要るときは `pow(far+1, depth) - 1` で復元する。最初に描く星は深度を書かない（書くと被写界深度でボケる）
- 影カメラの `up` は明示する（Y-up のままだと真上から照らす陸地で影が消える）
- キューブマップの環境反射を撮るときは窓ガラスと近くの構造物を隠す（`envHide`）。ガラスが前回の映り込みを写し込み続け、近い物は曲面で歪んで映る
- MeshBasicMaterial（ガラス・ミラーなど）は光の影響を受けないので、夜は手動で暗くする
- 動くもの（電車など）の見た目のばらつきを位置から作るとチカチカする。インスタンス番号から作る
- 両面表示の文字（看板・横断幕）は裏から見ると鏡文字になる。表だけにするか背中合わせに2枚置く
- `build()` の中は変数が多い。新しい変数名が既存とぶつかるとページが読み込めなくなる
- `updateDemo` の中で場面ごとの処理から `return` すると、次の場面へ進む判定に届かなくなる

## 変更したら

- `python3 -m http.server 8917` を起動した状態で、`tools/` の `check.mjs`（ワープ先・エラー・FPS・操作）、`tour-shots.mjs`（ツアーの場面）、`tour-loop.mjs`（ツアーが最後まで回るか）で確認する。スクリーンショットは Read で目視する
- デバッグ用に `window.__player` / `__ships` / `__night()` / `__scene` / `__space` / `__demo` / `__demoShot(i)` / `__demoTitle(i)` / `__lm`（landmarks）/ `__trains` / `__extShips` / `__post` / `__t()` を公開している

## ユーザーの好み（これまでの指摘から）

- ガイドツアーの場面は「その区画が画面の大半を占める」「対象に寄る」「対象が建物に隠れない」。説明は簡潔に、場面は長すぎない
- 夜は暖色の落ち着いた光。眩しすぎる光や、ボケて何かわからない状態は避ける
- コロニーならではの設定（回転・無重力・円筒・ミラー）を活かす。設定と建物の見た目を歴史でつなげる

## git

- まだリモート（GitHub）はない。変更は小さめの単位でコミットしていく
- コミットメッセージは日本語で「何を・なぜ」
