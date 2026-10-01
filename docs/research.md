# 低ポリゴンでも「きれい・広い・没入感がある」世界を見せる手法 調査レポート

対象: Three.js r170 / WebGL2 で作るオニール型スペースコロニー一人称デモ（半径3km・長さ16km、InstancedMesh の箱 約13万個、遠景は地面テクスチャに屋根色を焼き込み、FogExp2・平行光源1灯＋シャドウマップ・log depth buffer 使用中。これから自前DOF・ブルーム・キューブマップ反射・ビルボード雲を追加予定）

調査日: 2026-10-01

---

## 0. 最初に押さえる前提（このプロジェクト固有の3つの注意点）

### 0-1. log depth buffer は「depthを読む後処理」と相性が悪い → reverse-Z への切り替えを検討

- `logarithmicDepthBuffer` を有効にすると、depth から view 座標を復元する後処理（SSR・DOF・SSAO など）が正しく動かない、という報告が複数ある。three.js 本体の issue でも「線形 depth への変換が必要」と議論されている
  - [mrdoob/three.js#23072 postprocessing: logarithmic depth value to linear depth value](https://github.com/mrdoob/three.js/issues/23072)
  - [Is there a way to use ssao When camera far is large?（three.js forum）](https://discourse.threejs.org/t/is-there-a-way-to-use-ssao-when-camera-far-is-large/74514)
  - [WebGPU: GTAO is incompatible with logarithmicDepthBuffer（mrdoob/three.js#29797）](https://github.com/mrdoob/three.js/issues/29797)
  - [postprocessing DepthOfFieldEffect does not work correctly（forum）](https://discourse.threejs.org/t/postprocessing-depthoffieldeffect-does-not-work-correctly-missing-depth/17639)
- r169 で `WebGLRenderer({ reverseDepthBuffer: true })`（EXT_clip_control による reverse-Z）が入った。作者は「log depth より性能・精度とも strictly better、MSAA とも相性が良い」としている。NDC 範囲が [0,1] に変わるので、depth を扱う自前シェーダは `USE_REVERSEDEPTHBUF` を考慮する必要がある。拡張非対応環境では通常 depth に黙ってフォールバックする
  - [r169 release](https://github.com/mrdoob/three.js/releases/tag/r169) / [PR #29579 Stable reversed Z buffer](https://github.com/mrdoob/three.js/pull/29579) / [PR #30809 setReversed() fix](https://github.com/mrdoob/three.js/pull/30809) / [Cody Bennett の解説ポスト](https://x.com/Cody_J_Bennett/status/1836809843509747897) / [WebGLRenderer docs](https://threejs.org/docs/pages/WebGLRenderer.html)
  - **重要: PR #30809（2025-03-27 マージ、r175 マイルストーン）によると `reverseDepthBuffer: true` は r170 から壊れていた**（`WebGLState.setReversed()` が変数代入前に参照していた）。つまり**現在の r170 では reverse-Z は動かない**。使うなら r175 以降へ上げる必要がある。上げられない場合は log depth のまま「log→linear 変換」を共通関数化して各後処理で使う
- 例外: **N8AO は log depth を自動検出して対応**している（README で明記）。したがって AO だけなら切り替え前でも導入できる。一方で**自前DOF**は depth 再構成に直結するので、DOF を書く前に depth の方式を確定させるのが手戻りが少ない
  - [N8python/n8ao](https://github.com/N8python/n8ao)

### 0-2. 惑星向け大気散乱ライブラリは「そのままでは使えない」

- Bruneton（Precomputed Atmospheric Scattering）、Hillaire（UE の Sky Atmosphere）、takram/three-atmosphere はいずれも「球状の惑星＋外側の大気殻」を前提にしている
- コロニーでは「空」が 6km 先の対向地面で、地平線がない（見上げると街がある）。ガンダム設定解説でも「直径6.5kmなので見上げれば居住区が広がって見える」「地平線というものはない」と説明されている → [ホビージャパンWeb: スペース・コロニーの暮らしとは](https://hjweb.jp/article/2146366/)
- よってこれらは「レイリー／ミー散乱の色の出し方・数式の参考」として読み、実装は**視線の距離（とコロニー軸からの半径）だけで決まる解析フォグ**に置き換えるのが現実的（後述 1-1）

### 0-3. 「ミニチュア感（tilt-shift）」は巨大感の敵

- 遠景をボカすとミニチュアに見えるのは、人間が「浅い被写界深度＝小さい被写体」と学習しているから → [Miniature faking（Wikipedia）](https://en.wikipedia.org/wiki/Miniature_faking)、Cities: Skylines は DOF 設定に Tilt-Shift モードを持つ → [Steam discussion](https://steamcommunity.com/app/255710/discussions/0/483366528918058758/)
- **巨大スケールを見せたいなら、自前DOFは遠方の CoC（錯乱円）をほぼ 0 にする（過焦点距離に合わせる）**。ボケは「手前の近距離物（数m以内）」や「UI/会話時の演出」にだけ使う。遠景のボケは「霞（空気遠近法）」で代替する

---

## 1. 手法一覧（カテゴリ別）

凡例: 難易度 = 低（数時間）/ 中（1〜3日）/ 高（1週間〜）、コスト = GPU 負荷の目安、優先度 = このプロジェクトでの推奨度（S > A > B > C）

### 1. 大気・フォグ・光の筋

| 手法 | 何をするか | 効果 | Three.js 実装・難易度・コスト | 優先度 |
|---|---|---|---|---|
| 解析的高さフォグ（iq "Better Fog"） | 密度が指数関数的に変わる媒質を仮定し、視線積分を解析解で求める。太陽方向の inscatter 色も加える | FogExp2 の「全方向同じ灰色」を脱して、太陽側が明るく・低い所が濃い空気になる。距離感が段違い | `onBeforeCompile` か three-custom-shader-material で fog チャンクを差し替え。難易度 低〜中、コスト ほぼ0（式1本） | **S** |
| 円筒向けの読み替え | iq の「高さ y」を「コロニー軸からの距離 r（= 地面からの高さ 3km - r）」に置き換え。地表付近が濃く軸に近いほど薄い。対向地面を見上げる視線は地表付近の濃い層を2回通る | 見上げた対岸の街が青白く霞み、6km の空気の厚みが伝わる。「上空の地面」が自然に背景化する | 上記と同じシェーダ内で r を計算するだけ。難易度 中（視線上の r の積分は解析解にならないので、近似 or 数サンプルの数値積分で十分）、コスト 低 | **S** |
| 空気遠近法の色設計 | 遠いほどコントラスト低下・彩度低下・空色へ寄せる | 「遠い＝淡い」の知覚的手がかり。BotW の遠景が淡く洗い流されるのは意図的なアート判断と言われる | フォグ色をコロニー内の「空」（対岸の平均色＋窓からの光）に合わせる。UE の Exponential Height Fog は inscattering 色を空のキューブマップから取る機能があり、同じ発想が使える | **S** |
| ゴッドレイ（スクリーンスペース／シャドウマップ・レイマーチ） | 太陽方向へ放射状ブラー、またはシャドウマップを参照しながら視線をレイマーチ | 窓（採光帯）から差し込む光の筋。巨大空間の「空気の存在」を強調 | pmndrs/postprocessing の GodRaysEffect（放射ブラー、安価）か three-good-godrays（シャドウマップ・レイマーチ、中コスト）。難易度 低〜中 | B |
| ボリューメトリックフォグ（froxel） | 視錐台に沿った3Dグリッドで散乱を積分（AC4 Black Flag の Bart Wronski 手法） | ライトごとの体積光・局所的な霧 | WebGL2 では compute shader がなく 3D テクスチャ多パスで重い。難易度 高、コスト 高 | C |

出典:
- [Inigo Quilez: Better Fog](https://iquilezles.org/articles/fog/)
- [KAYAC Engineers' Blog: 高さの影響を受けるフォグ](https://techblog.kayac.com/unity-height-related-fog)
- [CGWORLD: vol.009 フォグ / 「空気」を表現する](https://cgworld.jp/regular/202109-pga-009.html)
- [garden at dawn: ゲームCGと空気遠近法](https://gardenatdawn.blogspot.com/2017/04/perspectivism.html)
- [Unreal Engine: Exponential Height Fog](https://dev.epicgames.com/documentation/en-us/unreal-engine/exponential-height-fog-in-unreal-engine) / [Volumetric Fog in Unreal Engine](https://dev.epicgames.com/documentation/en-us/unreal-engine/volumetric-fog-in-unreal-engine)
- [Hillaire 2020: A Scalable and Production Ready Sky and Atmosphere Rendering Technique](https://sebh.github.io/publications/) / [EG Digital Library](https://diglib.eg.org/items/8a3e5350-18b3-46bd-9274-3add5af88c75)
- [ebruneton/precomputed_atmospheric_scattering](https://github.com/ebruneton/precomputed_atmospheric_scattering) / [jeantimex の three.js 移植](https://github.com/jeantimex/precomputed_atmospheric_scattering)
- [takram-design-engineering/three-geospatial（three-atmosphere / three-clouds）](https://github.com/takram-design-engineering/three-geospatial)
- [Ameobea/three-good-godrays](https://github.com/Ameobea/three-good-godrays) / [GodRays - React Postprocessing](https://react-postprocessing.docs.pmnd.rs/effects/god-rays)
- [Bart Wronski publications（Volumetric Fog, SIGGRAPH 2014）](https://bartwronski.com/publications/)
- [BotW の遠景・フォグについて（Thetechedvocate）](https://www.thetechedvocate.org/the-stylized-beauty-of-the-legend-of-zelda-breath-of-the-wild/)

> 補足: FogExp2 自体は view 空間の距離で計算されるので log depth の影響を受けない。フォグを自前化しても depth 方式とは独立に進められる。

### 2. 遠景の扱い

| 手法 | 何をするか | 効果 | Three.js 実装・難易度・コスト | 優先度 |
|---|---|---|---|---|
| 現行の「屋根色焼き込み＋高層だけ残す」 | 遠景の建物を地面テクスチャに焼き、シルエットが効く高層だけ実体で残す | 実質 HLOD の「Approximation」に相当。既に正しい方向 | 継続。焼き込みテクスチャに**窓明かりの夜版**・**AO（建物の影）**も焼くと遠景が一気に締まる | A |
| HLOD（クラスタ単位の統合メッシュ） | 遠い街区をまとめて1メッシュ＋1マテリアルに置換（UE の HLOD / Simplygon） | ドローコール・頂点数を減らし、遠景を「塊」として見せる | InstancedMesh で既にドローコールは少ないので、主目的は**頂点数削減と遠景のテクスチャ化**。街区単位で「箱の上面だけ」「屋上の起伏をハイトマップ化」等。難易度 中 | B |
| オクタヘドラル・インポスター | メッシュを多方向から焼いたアトラスを、視線方向に応じてビルボードで描く（Fortnite の樹木） | 複雑メッシュ（樹木・小物）を遠景で数万本描ける | **現状の建物は12triの箱なのでインポスター化しても得はない**。将来の樹木・街路樹・モニュメント向け。agargaro の three.js 実装（forum）、ektogamat の WebGPU 版あり。難易度 中 | C（樹木導入時に A） |
| マットペインティング的背景 | 遠景を2D画像・板で描く | 制作コストに対して情報量が大きい | コロニーでは「背景」が対岸の地面なので板は破綻しやすい。**両端の蓋（エンドキャップ）や窓の外の宇宙・ミラー**は板・スカイボックスで十分 | B（端部・宇宙のみ） |
| 遠景マクロテクスチャ化 | ある距離から地形を詳細テクスチャ→大きな形だけの拡散テクスチャへ切替 | 遠景のノイズ（ちらつき）を消し、大きな形だけ見せる | 地面シェーダで距離ブレンド。難易度 低 | A |

出典:
- [Unreal Engine: Hierarchical Level of Detail Overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/hierarchical-level-of-detail-overview-in-unreal-engine) / [日本語版](https://docs.unrealengine.com/5.0/ja/hierarchical-level-of-detail-in-unreal-engine/)
- [Simplygon: HLOD](https://documentation.simplygon.com/SimplygonSDK_10.3.500.0/ue5/concepts/hlod.html) / [Halo Infinite × Simplygon（GDC 2022）](https://developer.microsoft.com/en-us/games/events/gdc/2022/halo-infinite-demo/)
- [Ryan Brucks（ShaderBits）オクタヘドラル・インポスター](https://x.com/ShaderBits/status/975420697156734976) / [80.lv: Impostor Baker for UE4](https://80.lv/articles/impostor-baker-for-ue4)
- [Octahedral Impostors for three.js（forum）](https://discourse.threejs.org/t/octahedral-impostors-for-three-js/80318) / [A forest of octahedral impostors（forum）](https://discourse.threejs.org/t/a-forest-of-octahedral-impostors/85735) / [ektogamat/octahedral-impostor-component](https://github.com/ektogamat/octahedral-impostor-component)
- [Building Urban Playgrounds for Video Games（遠景マクロテクスチャ・都市は遠くから「暗示」する）](https://medium.com/@EightyLevel/building-urban-playgrounds-for-video-games-c83fe1d68689)
- [Adrian Courrèges: GTA V Graphics Study（LOD and Reflections）](https://www.adriancourreges.com/blog/2015/11/02/gta-v-graphics-study/)

### 3. ライティング・画作り

| 手法 | 何をするか | 効果 | Three.js 実装・難易度・コスト | 優先度 |
|---|---|---|---|---|
| 箱の接地AO（シェーダ内グラデーション） | 建物の下端ほど暗く（高さ依存で地面付近を数%〜30%暗化）、地面側も建物の足元を暗く | 箱が「置いてある」から「建っている」に変わる。三角形追加ゼロ | インスタンスのローカル y で暗化するだけ。three-custom-shader-material の `csm_AO` / `csm_DiffuseColor` で書ける。難易度 低、コスト ≒0 | **S** |
| SSAO（N8AO） | スクリーンスペースで遮蔽を推定 | 建物の隙間・路地の奥行きが出る | `N8AOPass` / pmndrs 版あり。**log depth 対応**、`halfRes` で2〜4倍高速、`screenSpaceRadius` でスケール差の大きいシーンに対応。難易度 低、コスト 中（halfRes で低〜中） | **A** |
| GTAO（three.js 標準 addon） | Ground Truth AO | N8AO と同等の目的 | `webgl_postprocessing_gtao` の例あり。log depth との組み合わせは（WebGPU 版で非互換の報告あり）要検証 | B |
| 屋外3灯ライティング（iq） | 太陽（影あり）＋空光（上からの環境光）＋反射光（太陽の逆方向の弱い平行光）＋AO＋フォグ | 安価な間接光の代替。影の中が真っ黒にならず、面の向きで色が変わる | `DirectionalLight`（影あり）＋`HemisphereLight`＋影なしの弱い `DirectionalLight` を太陽の反対へ。難易度 低、コスト ほぼ0 | **A** |
| ライトプローブ（SH） | 環境のキューブマップから SH 照度を作って拡散光に使う | 空の色に馴染んだ環境光 | `LightProbe` + `LightProbeGenerator`（キューブマップから生成）。位置ごとの変化が欲しいなら LightProbeVolume 的な自作（threejs-probe-gi 参照）。難易度 低（単一）〜高（ボリューム） | B（単一プローブ） |
| CSM（カスケードシャドウ） | 近距離ほど高解像度の複数シャドウマップ | 16km 級の視界で「近くの影がガタガタ／遠くの影が消える」を両立 | three の addons `CSM`（`webgl_shadowmap_csm`）、StrandedKitty/three-csm。1枚のシャドウマップで 16km を覆うのは解像度的に無理があるので**要検討**。難易度 中、コスト 中（カスケード数ぶん影描画） | A |
| トーンマッピング選定 | HDR → 表示域への変換。ACES / AgX / Khronos PBR Neutral | 白飛び・色相ずれを抑えて「写真っぽい」or「製品色のまま」を選べる | renderer の `toneMapping` か pmndrs の `ToneMappingEffect`（後処理を使う場合は renderer 側を NoToneMapping にして最後にかける）。難易度 低 | **A** |
| カラーグレーディング / LUT | 最終色を LUT で調整（時間帯・昼夜） | 「その世界らしい色」を一発で与える。コロニーの人工光らしさ（わずかに冷たい／黄色い）を演出 | pmndrs の `LUT3DEffect`。**トーンマッピングの後**にかける（LUT は LDR 前提が多い）。難易度 低 | A |
| 色収差・ビネット・フィルムグレイン | レンズ・フィルムの欠点の再現 | 少量なら「カメラで撮った」感・平坦なグラデの誤魔化し。多用すると安っぽい | pmndrs に `ChromaticAberrationEffect` / `VignetteEffect` / `NoiseEffect`。難易度 低、コスト 低 | B（ビネット・グレインを控えめに） |
| ディザリング（バンディング対策） | 最終出力にノイズを足して量子化の縞を消す | 霞・空の広いグラデーションでの縞が消える。**霞を多用するこのシーンでは効果大** | 最終パスで blue noise を ±0.5/255。INSIDE の GDC 講演が好例。難易度 低 | A |

出典:
- [N8python/n8ao](https://github.com/N8python/n8ao) / [HBAO vs N8AO（forum）](https://discourse.threejs.org/t/new-ambient-occlusion-example-hbao-vs-n8ao/58847)
- [three.js GTAO example](https://threejs.org/examples/webgl_postprocessing_gtao.html)
- [Inigo Quilez: outdoors lighting](https://iquilezles.org/www/articles/outdoorslighting/outdoorslighting.htm)
- [three.js LightProbe docs](https://threejs.org/docs/pages/LightProbe.html) / [LightProbeVolume PR #18371](https://github.com/mrdoob/three.js/pull/18371) / [vvanghelue/threejs-probe-gi](https://github.com/vvanghelue/threejs-probe-gi)
- [StrandedKitty/three-csm](https://github.com/StrandedKitty/three-csm) / [sbcode: Cascaded Shadow Maps](https://sbcode.net/threejs/csm/)
- [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) / [ToneMappingEffect docs](https://pmndrs.github.io/postprocessing/public/docs/class/src/effects/ToneMappingEffect.js~ToneMappingEffect.html) / [Linear→sRGB とトーンマッピングの順序（Discussion #322）](https://github.com/pmndrs/postprocessing/discussions/322)
- [Tone Mapping Overview（three.js forum）](https://discourse.threejs.org/t/tone-mapping-overview/75204) / [Khronos PBR Neutral 発表](https://www.khronos.org/news/press/khronos-pbr-neutral-tone-mapper-released-for-true-to-life-color-rendering-of-3d-products)
- [Playdead: INSIDE Presentations（Low Complexity, High Fidelity / ディザリング / TAA）](https://blog.playdead.com/articles/inside_presentations/inside_publications.html) / [GDC Vault](https://www.gdcvault.com/play/1023002/Low-Complexity-High-Fidelity-INSIDE)
- [Insomniac: Spider-Man の手続き的ライティング（環境プローブ・ライトグリッド自動配置）](https://www.gamedeveloper.com/programming/video-dive-into-i-marvel-s-spider-man-i-procedural-lighting-tools)

### 4. 低ポリでも安っぽく見せない

| 手法 | 何をするか | 効果 | Three.js 実装・難易度・コスト | 優先度 |
|---|---|---|---|---|
| 窓の Interior Mapping | 窓面のフラグメントで「部屋の箱」とのレイ交差を計算し、床・天井・壁のテクスチャを貼る（Joost van Dongen 2007〜08、Spider-Man で有名） | 箱の壁面に「中に部屋がある」奥行きが出る。近景のビルが一気に本物っぽくなる | 箱のローカル座標で計算可能（UV不要）。three-fenestra（three.js 用 faux window interiors）あり。距離でフェードアウトし近景（〜300m）だけ有効にする。難易度 中、コスト 中（近景のみなら低） | **A** |
| 窓明かり（夜景） | 窓 ID をハッシュして点灯/消灯・色温度・明るさをばらつかせる emissive | 夜景の「生活」感。ブルームと組み合わせると街が光の粒になる | ワールド座標から窓グリッドを生成し、`(建物ID, 窓ID)` を乱数シードに。点灯率10〜50%、色と明るさにばらつき。難易度 低、コスト ≒0。**遠景の焼き込みテクスチャにも夜版を用意** | **S**（昼夜があるなら） |
| ベベル／エッジハイライト | 稜線付近の法線を丸めてハイライトを作る（Marmoset の Bevel Shader 等の考え方） | 箱の角に光が乗り「CGの箱」感が消える | 箱はローカル座標が [-0.5,0.5] なので、面上の点の「辺までの距離」から法線を曲げられる。難易度 低〜中、コスト ≒0 | A |
| ディテールテクスチャ／マクロ変化 | 細かいタイル（コンクリ・パネル）＋数十〜数百 m 周期の低周波ノイズで色・粗さを変える | 13万棟が全部同じ色・同じ質感、という一番の「安っぽさ」を消す | インスタンス属性（色・素材ID・汚れ度）＋ワールド座標ノイズ。トリプラナーで UV 不要。難易度 低 | **A** |
| デカール | 汚れ・ひび・看板・雨だれを投影 | 繰り返しの破壊、使用感 | 近景のみ。`DecalGeometry` は動的メッシュ生成なので大量配置には向かず、シェーダ内の「雨だれ縦縞」等で代替するのが安い | C |
| 屋上の小物 | 給水塔・室外機・アンテナを低ポリで | シルエットが箱でなくなる。遠景で特に効く | もう1つの InstancedMesh（1〜数棟に1個）。難易度 低 | B |
| 環境反射（キューブマップ） | 低解像度キューブを `CubeCamera`＋PMREM で作る | ガラス面・水面に空と対岸の街が映る | 毎フレーム更新は重い。数秒に1回 or 静的で十分。GTA V は毎フレーム簡略版キューブを描いている（キャラ・車は含めない）。難易度 低、コスト 中 | A |

出典:
- [Interior Mapping: rendering real rooms without geometry（Game Developer, Joost van Dongen）](https://www.gamedeveloper.com/programming/interior-mapping-rendering-real-rooms-without-geometry) / [原論文 PDF](https://www.proun-game.com/Oogst3D/CODING/InteriorMapping/InteriorMapping.pdf)
- [codedgar/three-fenestra（Faux window interiors for Three.js）](https://github.com/codedgar/three-fenestra)
- [3DWorld: Building Window Generation（窓IDをハッシュして点灯率10〜50%）](http://3dworldgen.blogspot.com/2018/04/building-window-generation.html) / [Godot Shaders: Basic Skyscraper Window Lights](https://godotshaders.com/shader/basic-skyscraper-window-lights/) / [UE フォーラム: ランダムな窓の点灯](https://forums.unrealengine.com/t/how-would-you-do-it-material-for-randomly-light-dark-city-building-windows/109325)
- [Marmoset: Bevel Shader](https://marmoset.co/posts/revolutionize-your-3d-workflow-with-toolbags-bevel-shader/) / [Redshift Rounded Corners（フェイクベベルの考え方）](https://www.artivoxa.com/redshift-rounded-corners-faking-bevels-for-cleaner-product-renders/)
- [UE フォーラム: マクロテクスチャとは](https://forums.unrealengine.com/t/what-are-macro-textures/287040) / [7 Proven Ways to Break Texture Repetition](https://aitextured.com/articles/7_proven_ways_to_break_texture_repetition_on_large_surfaces.html)
- [FarazzShaikh/THREE-CustomShaderMaterial](https://github.com/FarazzShaikh/THREE-CustomShaderMaterial)
- [Adrian Courrèges: GTA V Graphics Study](https://www.adriancourreges.com/blog/2015/11/02/gta-v-graphics-study/)
- [GDC Vault: Spider-Man – A Deep Dive into the Look Creation of Manhattan](https://www.gdcvault.com/play/1026495/-Marvel-s-Spider-Man) / [Procedurally Crafting Manhattan](https://www.gdcvault.com/play/1026415/Procedurally-Crafting-Manhattan-for-Marvel)

### 5. 雲

| 手法 | 何をするか | 効果 | Three.js 実装・難易度・コスト | 優先度 |
|---|---|---|---|---|
| ビルボード／パーティクル雲（Harris 型） | 小さなパフ（ソフトなスプライト）を多数集めて1つの雲にし、遠い雲はインポスター化して再利用 | 立体感のある雲を安く大量に。フライトシムで実績 | Codrops のスプライト雲チュートリアル。パフ単位でソフトパーティクル（depth フェード）必須 → depth 方式の確定が先。難易度 中、コスト 低〜中（overdraw に注意） | **A**（予定通り） |
| Ghibli 風（セル調）雲 | ノイズのしきい値で縁をはっきりさせ、2〜3階調の陰影＋リムライト | 描き込み量が少なくても「絵として美しい」。アニメ的なコロニー像（ガンダム）と相性が良い | craftzdog/ghibli-style-shader（樹木向けだが手法流用可）、sbcode の TSL 雲（WebGPU 前提なので考え方のみ参考） | B |
| ボリューメトリック雲（Nubis / HZD） | Perlin-Worley ノイズの3Dテクスチャをレイマーチ。PS4 で 2ms 未満 | 最高品質・時間変化・天候 | WebGL2 でも可能だが重い。takram/three-clouds は惑星前提。難易度 高、コスト 高 | C |
| **コロニー固有: 軸沿いの雲帯** | ガンダムの設定では「軸付近に水蒸気の疑似雲を設け、頭上の地面を隠す」 | 頭上の対岸を半分隠すことで、①描画負荷（対岸の細部）を減らし ②「空」があるように見せ ③雲の切れ間から対岸が見える＝スケール参照になる | 雲を半径 1〜2km 付近（軸寄り）に帯状に配置し、軸まわりにゆっくり回す（コロニーの空気は地面と共回転するので、雲は地上から見るとほぼ静止〜ゆっくり流れる程度で良い） | **S**（配置方針として） |

出典:
- [Mark Harris: Real-Time Cloud Rendering（SkyWorks）](http://www.markmark.net/clouds/) / [Real-Time Cloud Rendering for Games（GDC 2002 PDF）](http://www.markmark.net/PDFs/RTCloudsForGames_HarrisGDC2002.pdf)
- [Codrops: How to Create Procedural Clouds Using Three.js Sprites](https://tympanus.net/codrops/2020/01/28/how-to-create-procedural-clouds-using-three-js-sprites/)
- [The Real-time Volumetric Cloudscapes of Horizon Zero Dawn（SIGGRAPH 2015 Advances, PDF）](https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf) / [Guerrilla: Nubis, Evolved（SIGGRAPH 2022）](https://www.guerrilla-games.com/read/nubis-evolved) / [Andrew Schneider publications](https://sites.google.com/view/vonschneidz/publications)
- [craftzdog/ghibli-style-shader](https://github.com/craftzdog/ghibli-style-shader) / [sbcode TSL Clouds](https://sbcode.net/tsl/clouds/) / [Three.js Sky & Fog Guide](https://threejsresources.com/guides/sky-and-clouds)
- [takram three-clouds README](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/clouds/README.md)
- [ホビージャパンWeb: スペース・コロニーの暮らし（軸付近の疑似雲）](https://hjweb.jp/article/2146366/)

### 6. 生活感・動き

| 手法 | 何をするか | 効果 | Three.js 実装・難易度・コスト | 優先度 |
|---|---|---|---|---|
| 交通（光の粒の流れ） | 道路に沿ってインスタンスを GPU で動かす。遠景はヘッドライト／テールランプの点だけ | 「街が動いている」最大の手がかり。遠景で特に効く | 道路をパラメトリック曲線にして `instanceId + time` で位置を計算（CPU 更新不要）。難易度 低〜中、コスト 低 | **A** |
| 群衆（VAT） | アニメーションをテクスチャに焼き、インスタンスで数千体を1ドローコールで | 歩行者の存在で「建物のサイズ」が一瞬で伝わる（スケール参照） | three-vat（glTF から実行時に焼く）。近景のみ、遠景はドット。難易度 中、コスト 中 | B |
| 風で揺れる樹木 | 頂点シェーダで幹の大きな曲げ＋葉の細かい揺れ（Crysis 方式） | 静止画っぽさが消える | 頂点色に硬さ・位相を入れる方式がそのまま使える。難易度 低（樹木がある前提） | B |
| 鳥（Boids） | 分離・整列・結合の3規則で群れを動かす | 空間の高さ・空気の存在。コロニーの「空」に生き物がいる違和感の無さ | three.js 公式 GPGPU birds の例（GPUComputationRenderer）。難易度 低〜中 | B |
| 環境音 | 街の雑踏・風・遠くの交通・鳥。距離減衰と残響 | 視覚の情報量不足を最も安く補う。没入感への寄与が大きい | `PositionalAudio` / Web Audio。難易度 低、GPU コスト 0 | A |
| 草（Ghost of Tsushima） | 1本ずつ GPU 生成、Voronoi でクランプ化、風で揺らす | 近景の情報量。83,000本を約2.5ms | 一人称視点の足元だけなら有効。難易度 中〜高 | C |

出典:
- [Insomniac: Spider-Man Technical Postmortem（歩行者・交通・ストリートビネット）](https://www.gdcvault.com/play/1026496/-Marvel-s-Spider-Man) / [Game Developer 記事](https://www.gamedeveloper.com/design/video-insomniac-s-technical-postmortem-of-i-marvel-s-spider-man-i-)
- [MikeFernandez-Pro/three-vat](https://github.com/MikeFernandez-Pro/three-vat) / [GPU Gems 3 Ch.2 Animated Crowd Rendering](https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-2-animated-crowd-rendering)
- [GPU Gems 3 Ch.16 Vegetation Procedural Animation and Shading in Crysis](https://developer.nvidia.com/gpugems/gpugems3/part-iii-rendering/chapter-16-vegetation-procedural-animation-and-shading-crysis)
- [simianarmy/threejs-boids（GPUComputationRenderer）](https://github.com/simianarmy/threejs-boids) / [Wawa Sensei: Boids Flocking](https://wawasensei.dev/tuto/boid-flocking-simulation-threejs-and-react)
- [GDC Vault: Procedural Grass in Ghost of Tsushima](https://gdcvault.com/play/1027033/Advanced-Graphics-Summit-Procedural-Grass)

### 7. 巨大スケールを感じさせる演出

| 手法 | 何をするか | 効果 | このプロジェクトでの具体策 | 優先度 |
|---|---|---|---|---|
| スケール参照物 | 大きさを知っている物（人・車・木・電柱・窓）を必ず視界に入れる | 「あのビルは窓が40段ある」→ 一瞬で高さがわかる | 窓グリッドは最強のスケール参照。窓がない箱は「何m か分からない箱」になる。近景に人・車・街路樹 | **S** |
| ランドマーク | 遠くからでも見える特徴的な構造物 | 方向感覚と距離の手がかり | 両端のエンドキャップ、軸に沿って走る構造物（照明・スパイン）、採光窓の帯、大きな塔 | A |
| 空気遠近法（ヘイズ） | 1章参照 | 距離＝霞の量。巨大さの主要因 | 対岸を見上げたときの霞の量が「6km の厚み」を伝える | **S** |
| 「地平線がせり上がる」構図 | 円筒内側の世界は遠くほど地面が持ち上がり頭上へ回り込む。Halo CE の「リングが空へ伸びていく」景色はこの驚きで記憶されている | 「ここが人工の円筒の中だ」と一目で分かる、コロニー最大の見せ場 | 開始地点で**長手方向（軸方向）を向かせる**と、地面が左右から持ち上がって筒の形が一番よく見える。横方向は対岸が頭上に来る | **S** |
| カメラの高さ・FOV | 人の目線（1.6m前後）、FOV は 60〜75°程度 | 目線が高い・広角すぎると模型を見下ろす感覚になる | 一人称は目線を人の高さに固定。広角にしすぎない（広角は遠景を小さくする） | A |
| DOF を遠景にかけない | 0-3 参照 | ミニチュア感を回避 | 自前DOFは遠方 CoC≈0 | **S**（DOF 設計制約） |
| 「全部見せない」 | 雲・霞・建物で視界を区切り、切れ間から遠景を見せる | 見えない部分を脳が補完し、実際より大きく感じる | 軸沿いの雲帯、街区の通りを「視線の抜け」として設計 | A |

出典:
- [Game Developer: Urban Design and the Creation of Videogame Cities](https://www.gamedeveloper.com/design/urban-design-and-the-creation-of-videogame-cities)
- [The Illusion of Game Scale](https://aisjam.com.au/the-illusion-of-game-scale-how-game-worlds-balance-size-and-experience/)
- [Iconic Landmarks in the Game World](https://game-design-snacks.fandom.com/wiki/Iconic_Landmarks_in_the_Game_World)
- [Creative Bloq: Halo Campaign Evolved review（リングが地平線を駆け上がる景色）](https://www.creativebloq.com/entertainment/gaming/halo-campaign-evolved-ps5-review-the-unreal-engine-5-remake-is-almost-everything-fans-could-hope-for)
- [VGC: Halo の元アートディレクターが新リングを「スケール感がおかしい・謎がない」と批判](https://www.videogameschronicle.com/news/out-of-scale-no-mystery-damn-ugly-halos-original-art-director-shares-his-thoughts-on-campaign-evolveds-architecture/)（巨大構造物は「暗く・謎めいて・驚きがある」べき、という指摘はコロニー演出にも直接効く）
- [Miniature faking（Wikipedia）](https://en.wikipedia.org/wiki/Miniature_faking)

### 8. 実際のゲーム事例から読み取れること

| 作品 | 参考になる点 | 出典 |
|---|---|---|
| GTA V | 遠景 LOD、毎フレームの簡略キューブマップ反射（キャラ・車は除外）、DOF、レンズフレア | [Courrèges: GTA V Graphics Study](https://www.adriancourreges.com/blog/2015/11/02/gta-v-graphics-study/) |
| Horizon Zero Dawn / Forbidden West | ボリューメトリック雲（Nubis）、天候と連動。PS4 で 2ms 未満 | [SIGGRAPH 2015 PDF](https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20-%20Zero%20Dawn%20-%20ARTR.pdf) / [Nubis, Evolved](https://www.guerrilla-games.com/read/nubis-evolved) |
| Breath of the Wild | 遠景を意図的に淡く洗い流す（アニメ的空気遠近法）。オブジェクトを先に描いて地形側を depth で馴染ませる地形ブレンド | [thetechedvocate](https://www.thetechedvocate.org/the-stylized-beauty-of-the-legend-of-zelda-breath-of-the-wild/) / [TIGSource: BotW terrain blending](https://forums.tigsource.com/index.php?topic=67068.0) |
| Ghost of Tsushima | 風に揺れる草原（GPU 生成・Voronoi クランプ） | [GDC Vault](https://gdcvault.com/play/1027033/Advanced-Graphics-Summit-Procedural-Grass) |
| Marvel's Spider-Man | Interior mapping による窓の奥行き、手続き的な街の構築・ライティング、歩行者・交通 | [Game Developer: Interior Mapping](https://www.gamedeveloper.com/programming/interior-mapping-rendering-real-rooms-without-geometry) / [GDC Vault Postmortem](https://www.gdcvault.com/play/1026496/-Marvel-s-Spider-Man) |
| Cities: Skylines | Tilt-shift（ミニチュア感）を DOF のモードとして持つ。**本プロジェクトは逆を狙う** | [Steam discussion](https://steamcommunity.com/app/255710/discussions/0/483366528918058758/) |
| Halo（CE / Infinite） | リングが空へ伸びる景色そのものが体験の核。Infinite では Simplygon で巨大環境を最適化 | [Creative Bloq](https://www.creativebloq.com/entertainment/gaming/halo-campaign-evolved-ps5-review-the-unreal-engine-5-remake-is-almost-everything-fans-could-hope-for) / [GDC 2022 One Frame in Halo Infinite](https://gdconf.com/article/gdc-2022-session-breaks-down-one-frame-in-halo-infinite/) / [Simplygon × Halo Infinite](https://developer.microsoft.com/en-us/games/events/gdc/2022/halo-infinite-demo/) |
| INSIDE | 低い複雑度で高い画質（ディザリング・TAA・フォグの扱い） | [Playdead publications](https://blog.playdead.com/articles/inside_presentations/inside_publications.html) |
| Elite Dangerous | Orbis ステーションのハブがオニールシリンダーから着想（技術資料は見つからず） | [Elite Dangerous Wiki: Orbis](https://elite-dangerous.fandom.com/wiki/Orbis) |
| ガンダム系 | **ゲームのコロニー内描画の技術資料は見つからなかった**。設定（ミラーで採光・軸付近の疑似雲で頭上の地面を隠す・地平線がない）のみ参考にした | [ホビージャパンWeb](https://hjweb.jp/article/2146366/) |
| Starfield | 本調査ではコロニー描写に関する技術資料は見つからなかった | — |

---

## 9. このプロジェクトで次にやるべきトップ5（推奨順）

予定（DOF・ブルーム・キューブマップ反射・ビルボード雲）との関係も併記する。

### 第0位（前提作業）: depth 方式を確定する — log depth → reverse-Z の検証

- 自前DOF・ソフトパーティクル雲・（将来の）GTAO/SSR はすべて depth を読む。log depth のままだと各シェーダで log→linear 変換を書く必要があり、既知の不具合報告も多い
- 選択肢は2つ。(a) three.js を r175 以降に上げて `reverseDepthBuffer: true`（r170 では PR #30809 の不具合で動かない）。遠景の z-fighting が出ないか、自前シェーダが `USE_REVERSEDEPTHBUF` を考慮しているかを確認する。(b) r170 に留まり、log depth のまま「log→linear 変換関数」を共通化してから DOF・雲に進む。アップデートの影響範囲が小さければ (a) を推奨（MSAA とも相性が良く、性能・精度とも log depth より有利とされる）
- コストは小さいが、後から変えると DOF・雲・AO を全部直すことになるので**最初にやる**

### 1位: 円筒用の空気遠近法フォグ（iq 解析フォグの読み替え）

- FogExp2 を置き換え、①距離 ②軸からの半径（地表付近が濃い）③太陽／採光窓方向の inscatter 色、で色と濃さを決める
- 対岸を見上げたときの青白い霞が「6km の空気」を伝え、遠景の焼き込みテクスチャの粗さも隠す。コストほぼゼロで、見た目の改善幅は全手法で最大
- 自前DOFで遠景をボカす代わりに、この霞で遠景を柔らかくする（ミニチュア化を避ける）

### 2位: 建物の「箱っぽさ」を消すシェーダ一式（接地AO・窓グリッド・マクロ変化・エッジハイライト）

- three-custom-shader-material で InstancedMesh のマテリアルを1つ拡張し、三角形を増やさずに:
  - 足元ほど暗い接地AO
  - ワールド座標から窓グリッド（＝最強のスケール参照）＋窓IDハッシュで夜の点灯ばらつき
  - インスタンスごとの色・汚れ・低周波ノイズで13万棟の単調さを崩す
  - 箱のローカル座標から稜線ハイライト
- 夜景の窓明かりは**ブルーム**の主役になるので、ブルーム導入（pmndrs の `BloomEffect`、luminanceThreshold で窓だけ光らせる）とセットでやる

### 3位: 画作りパイプラインの整備（pmndrs/postprocessing に一本化）

- 順序: RenderPass → N8AO（halfRes・screenSpaceRadius） → 自前DOF（遠方 CoC≈0） → Bloom → ToneMapping（AgX か ACES を比較） → LUT → ビネット・グレイン（控えめ）・ディザ
- pmndrs は互換エフェクトを1パスにまとめるので、自前実装を個別に重ねるより速い。後処理を使う場合は renderer 側の toneMapping を切り、最後に ToneMappingEffect をかける
- ライティングは iq の屋外3灯（太陽＋HemisphereLight＋太陽逆向きの弱い反射光）で間接光を安く足す。影は 16km 視界を1枚で覆うのは無理があるので、CSM（three の addons / three-csm）を検証する

### 4位: コロニーの「空」を作る — 軸沿いのビルボード雲帯＋窓・ミラー・エンドキャップ

- 予定のビルボード雲は、Harris 型の「パフ集合＋遠方インポスター」で、**軸寄りに帯状に配置**して頭上の対岸を部分的に隠す（ガンダムの設定と同じ発想）。描画負荷を下げつつ、雲の切れ間から対岸が見える「見せ方」になる
- 雲の陰影は空気遠近法フォグと同じ inscatter 色を使って馴染ませる。ソフトパーティクルは第0位の depth 方式に依存
- キューブマップ反射は、軸上の1点から数秒に1回更新する低解像度キューブで十分（ガラス面に対岸と雲が映るだけで効果大）

### 5位: 動きと音（交通の光の流れ・鳥・環境音）

- 交通は道路をパラメトリック曲線にして頂点シェーダで動かせば CPU コストなし。遠景では光の点の流れだけで「街が生きている」と伝わる
- 鳥（GPGPU boids）は空間の高さを示すスケール参照、環境音は GPU コストゼロで没入感を大きく上げる
- 群衆（three-vat）・揺れる木・interior mapping はその次の段階（近景の作り込み）

---

## 付録: 調査の限界

- ガンダム系ゲーム・Starfield のコロニー内描画について、技術講演・ブログは見つからなかった（設定資料のみ）
- CEDEC の大気散乱関連講演は一覧ページ（[CEDEC 2018 セッション](https://cedec.cesa.or.jp/2018/session/detail/s5abdd63fce206.html) / [CEDEC 2024](https://cedec.cesa.or.jp/2024/session/detail/s6606390361702/)）までしか確認できず、資料本文は未確認
- r175 以降へのアップデートで既存コードに破壊的変更がないか、reverse-Z 有効時に遠景（16km先）の精度が十分か、および CSM を InstancedMesh 13万個と組み合わせたときの影描画コストは**要実測**
