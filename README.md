# 筒ビューア

画像を筒（円柱）に巻き付けて、回しながら見られるサイトです。GitHub Pages でそのまま公開できます。

- **閲覧ページ**（`/`）… 筒を回して見る、筒⇔平面の切り替え、上部のチェックでレイヤーの表示／非表示
- **管理ページ**（`/admin/`）… 下地画像・レイヤー・背景画像の設定、表示設定、GitHub への公開

ビルド作業は不要です。このフォルダの中身をそのままリポジトリに置けば動きます。

---

## 公開までの手順

### 1. リポジトリを作ってファイルを置く

1. GitHub で新しいリポジトリを作ります（例：`cylinder-viewer`、Public）。
2. このフォルダの中身（`index.html`、`admin`、`assets`、`data`、`.nojekyll` など）をすべてリポジトリの直下にアップロードします。
   - ブラウザから行う場合は、リポジトリの「Add file」→「Upload files」にフォルダごとドラッグします。
   - `.nojekyll` は隠しファイルなので、アップロードから漏れていないか確認してください（なくても動きますが、あると反映が速くなります）。

### 2. GitHub Pages を有効にする

1. リポジトリの「Settings」→「Pages」を開きます。
2. 「Source」を「Deploy from a branch」、ブランチを `main`、フォルダを `/ (root)` にして保存します。
3. 1〜2分後、`https://ユーザー名.github.io/リポジトリ名/` で閲覧ページが開けます。
   管理ページは `https://ユーザー名.github.io/リポジトリ名/admin/` です。

### 3. 管理ページから更新できるようにする（アクセストークン）

管理ページの「公開する」ボタンは、GitHub のリポジトリに直接ファイルを保存します。そのためにトークンが必要です。

1. GitHub の [Fine-grained token の作成ページ](https://github.com/settings/personal-access-tokens/new) を開きます。
2. 「Repository access」→「Only select repositories」で、このリポジトリだけを選びます。
3. 「Permissions」→「Repository permissions」→「Contents」を **Read and write** にします。
4. 作成されたトークン（`github_pat_` で始まる文字列）をコピーします。
5. 管理ページの「公開先（GitHub）」に、ユーザー名・リポジトリ名・トークンを入れて「接続する」を押します。
   GitHub Pages 上で開いた場合、ユーザー名とリポジトリ名は自動で入ります。

> 管理ページ自体は誰でも開けますが、トークンがなければ何も変更できません。
> トークンはそのブラウザの中にだけ保存されます。共用のパソコンでは「このブラウザにトークンを保存する」のチェックを外してください。

---

## 使い方

### 管理ページ

| やりたいこと | 操作 |
| --- | --- |
| 下地画像を設定 | 「下地画像」の「画像を選ぶ」、またはドロップ |
| レイヤーを追加 | 「画像を選んで追加」（複数可）、ドロップ、`Ctrl`+`V`／`⌘`+`V` で貼り付け |
| 重なり順を変える | レイヤーの ↑（手前へ）／↓（奥へ）。リストの上ほど手前 |
| 最初から表示するか | レイヤーの「最初から表示」 |
| 筒の後ろの背景 | 「筒の背景」で画像・背景色・配置を設定 |
| 反映する | 画面下の「公開する」。1〜2分で閲覧ページに反映 |

- 画面左（スマホでは上）のプレビューで、公開前に見た目を確認できます。
- 下地が未設定のときに貼り付けた画像は、自動で下地になります。
- 8192px を超える大きな画像は、スマホでも表示できるよう自動で縮小されます。
- レイヤーは**下地と同じ縦横比**の画像（透過PNG）にすると位置がぴったり重なります。違う比率の画像は下地の大きさに合わせて伸縮されます。

### 閲覧ページ

- 横にドラッグ（スワイプ）で筒が回ります。勢いをつけると惰性で回ります。
- ピンチ／ホイールで拡大、拡大中は縦ドラッグで上下に移動、ダブルタップで元の大きさに戻ります。
- 下のダイヤルでも回せます（キーボードの ← → も使えます）。
- 右上のボタンで「筒」と「平面」を切り替えます。

---

## GitHub を使わずに更新する場合

管理ページ下部の「ZIP をダウンロード」で、設定と画像をまとめた ZIP を保存できます。
展開してできた `data` フォルダで、リポジトリの `data` フォルダを置き換えてください。

## 手元のパソコンで確認する場合

`file://` で直接開くと読み込みが制限されるため、簡易サーバーを使います。

```sh
cd このフォルダ
python3 -m http.server 8000
# → http://localhost:8000/ と http://localhost:8000/admin/ を開く
```

---

## ファイル構成

```
index.html              閲覧ページ
admin/index.html        管理ページ
assets/js/engine.js     筒の描画・平面表示・操作（両ページ共通）
assets/js/viewer.js     閲覧ページの動作
assets/js/dial.js       回転ダイヤル
assets/js/admin.js      管理ページの動作
assets/js/github.js     GitHub への保存（1回の公開＝1コミット）
assets/css/             スタイル
assets/vendor/          three.js（必要な部分だけ）、JSZip
data/config.json        表示内容の設定（管理ページが書き換えます）
data/images/            画像（管理ページがアップロードします）
```

`data/config.json` の主な項目：

```jsonc
{
  "title": "表示タイトル",
  "base": { "name": "下地", "src": "data/images/xxx.jpg" },
  "layers": [ { "id": "...", "name": "雲", "src": "data/images/yyy.png", "visible": true, "opacity": 1 } ],
  "background": { "src": "data/images/zzz.jpg", "color": "#141a2e", "fit": "cover" },
  "display": { "defaultMode": "cylinder", "autoRotate": true, "rotateSpeed": 6, "shading": 0.55, "startAngle": 180 }
}
```

- `layers` は配列の後ろほど手前に描かれます。
- `startAngle` は開いたときに正面に来る位置（0＝画像の左端、180＝中央）です。

## 同梱ライブラリ

- [three.js](https://threejs.org/) r186（MIT License）… 使う部分だけを 1 ファイルにまとめたもの
- [JSZip](https://stuk.github.io/jszip/) 3.10（MIT License）
- フォント：Zen Kaku Gothic New（Google Fonts から読み込み、SIL Open Font License）

サンプル画像（`data/images/sample-*`）は自由に差し替え・削除してかまいません。
