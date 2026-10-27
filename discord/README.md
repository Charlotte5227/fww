# Discord 連携（/地図 コマンド）

Discord で地図を画像として送れます。操作はすべてメニューから行います。

| 打つもの | できること |
| --- | --- |
| `/地図` | 地図のメニューを開く（自分にだけ見える） |
| `/地図 使い方:` | 使い方を表示する（自分にだけ見える）。項目の一覧から知りたいものを選ぶ |

## メニューの使い方

`/地図` と打って送信すると、自分にだけ見えるメニューが開きます。

1. **日付を選ぶ**（履歴がある場合）：どの記録の地図にするかを選びます（最初は最新。新しい順に 25 件まで）。
2. **レイヤーを選ぶ**：重ねたいレイヤーにチェックを付けます（複数可）。最初は閲覧ページの初期表示と同じです。下地はいつも含まれます。
3. 必要に応じてボタンを使います。
   - **組み合わせを追加**：今の選択を、そのときの日付と一緒に取っておきます。別のレイヤーや日付を選び直してまた追加すると、まとめて送れます（最大 10 枚）。
   - **透明度…**：入力欄が開きます。`国家: 100` の数字を書き換えて送信すると、そのレイヤーの透け具合が変わります。
   - **⬜ 自分だけに表示**：押すと ✅ になり、地図が自分にだけ見える形で送られます。
   - **すべて選ぶ／初期表示に戻す／組み合わせを空にする**
   - **取っておいた組み合わせを外す**（いちばん下の選択欄）：選んだ組み合わせだけを外します。
   - **❓ 使い方**：使い方を表示します。
4. **地図を作る**：30秒〜1分ほどで地図が送られます。メニューは残るので、続けて別の地図も作れます。

**透明度の目安**

| 数字 | 見え方 |
| --- | --- |
| 100 | そのまま。下のレイヤーは見えない（初期の状態） |
| 75 | 少し透ける。下のレイヤーがうっすら見える |
| 50 | 半分透ける。上と下が同じくらい見える |
| 25 | うっすら見える。下のレイヤーが中心 |
| 0 | 見えない（そのレイヤーを外したのと同じ） |

## 使い方（ヘルプ）の項目

`/地図 使い方:` の一覧、またはヘルプの「ほかの項目を見る」から選べます。

はじめに／メニューの使い方／まとめて送る／過去の地図／透明度／自分だけに表示／困ったとき／閲覧ページ

ヘルプの文章は `discord/worker.js` の `HELP` に書いてあります。項目を増やすときは、`tools/discord_register.py` の `HELP_TOPICS` にも同じ key で追加して、「Discord コマンド登録」を実行し直してください。

## 補足

- 地図ができるまで 30秒〜1分ほどかかります（枚数が多いと少し長くなります）。その間は「考え中…」と表示されます。
- 管理ページから公開した最新の地図と、履歴の記録が使われます。
- 「自分だけ」で送った地図は、Discord の仕組み上、時間がたつと（またはアプリを開き直すと）消えることがあります。残したい地図は保存してください。
- 閲覧ページの URL は、GitHub Pages の URL（`https://ユーザー名.github.io/リポジトリ名/`）を自動で使います。独自ドメインなどの場合は、Worker の変数に `SITE_URL` を追加してください。

## しくみ

GitHub Pages ではボットを動かせないため、次の 2 つの無料サービスを使います。常に動かしておくサーバーやパソコンは必要ありません。

1. **Cloudflare Workers**：Discord からコマンドを受け取り、すぐに「考え中…」と返します（`discord/worker.js`）。
2. **GitHub Actions**：fww リポジトリの中で地図を合成し、Discord に画像を投稿します（`.github/workflows/discord-map.yml`、`tools/discord_map.py`）。

Worker から Actions に返信先を渡すときは暗号化しているので、公開リポジトリの記録に返信用の情報は残りません。

---

## 設定手順（最初に 1 回だけ）

途中で次の 5 つの値を使います。メモ帳などに控えながら進めてください。

| 名前 | どこで手に入るか |
| --- | --- |
| Application ID | 手順 1 |
| Public Key | 手順 1 |
| Bot Token | 手順 1 |
| 合言葉（SHARED_SECRET） | 自分で決めます（手順 2） |
| GitHub トークン（Actions 用） | 手順 3 |

### 1. Discord アプリを作る

1. [Discord Developer Portal](https://discord.com/developers/applications) を開き、「New Application」で新しいアプリを作ります（名前は例えば「FWW地図」）。
2. 「General Information」の **Application ID** と **Public Key** を控えます。
3. 左の「Bot」を開き、「Reset Token」を押して表示された **Token** を控えます（一度しか表示されません）。

### 2. fww リポジトリに設定を入れる

1. 今回のファイル（`.github`、`tools`、`discord` フォルダ）をリポジトリにアップロードします。
   `.github` は隠しフォルダです。Mac は `⌘`+`Shift`+`.`、Windows はエクスプローラーの「表示」→「隠しファイル」で表示してからドラッグしてください。
2. リポジトリの「Settings」→「Secrets and variables」→「Actions」→「New repository secret」で、次の 3 つを登録します。

   | Name | Secret |
   | --- | --- |
   | `DISCORD_APP_ID` | Application ID |
   | `DISCORD_BOT_TOKEN` | Bot の Token |
   | `DISCORD_SHARED_SECRET` | 合言葉。30文字以上の、推測されにくい英数字を自分で決めます |

3. リポジトリの「Actions」タブを開き、左の一覧から「Discord コマンド登録」を選び、「Run workflow」→「Run workflow」を押します。
   緑のチェックが付けば登録完了です。

### 3. Worker 用の GitHub トークンを作る

管理ページで使っているトークンとは別に、Actions を起動するためだけのトークンを作ります。

1. [Fine-grained token の作成ページ](https://github.com/settings/personal-access-tokens/new) を開きます。
2. 「Repository access」→「Only select repositories」で fww だけを選びます。
3. 「Permissions」→「Repository permissions」→「**Actions**」を **Read and write** にします（ほかは変更不要です）。
4. 作成されたトークンを控えます。有効期限を設けた場合は、切れたら作り直して手順 4-3 の値を差し替えてください。

### 4. Cloudflare Worker を作る

1. [Cloudflare](https://dash.cloudflare.com/sign-up) に無料登録します。
2. 「Workers & Pages」（Compute）→「Create」→「Create Worker」（Hello World）を選び、名前を付けて「Deploy」します。
3. 「Edit code」を押し、最初からあるコードをすべて消して、`discord/worker.js` の中身を貼り付け、「Deploy」します。
4. Worker の「Settings」→「Variables and Secrets」で次を追加し、保存（Deploy）します。

   | 種類 | 名前 | 値 |
   | --- | --- | --- |
   | Text | `DISCORD_PUBLIC_KEY` | Public Key |
   | Text | `GITHUB_REPO` | `Charlotte5227/fww` |
   | Secret | `GITHUB_TOKEN` | 手順 3 のトークン |
   | Secret | `SHARED_SECRET` | 手順 2 で決めた合言葉（まったく同じ文字列） |

5. Worker の URL（`https://〜.workers.dev`）を控えます。ブラウザで開くと「筒ビューア Discord 連携は動いています。」と表示されます。

### 5. Discord と Worker をつなぐ

1. Discord Developer Portal の「General Information」にある **Interactions Endpoint URL** に Worker の URL を入れて「Save Changes」します。
   保存できれば接続成功です（Discord が Worker に確認を送り、正しく返事が返ったときだけ保存されます）。
2. 左の「Installation」（または「OAuth2」→「URL Generator」）で、スコープ `applications.commands` の招待リンクを作り、使いたいサーバーに追加します。
   手順 2-3 の Actions の記録の最後にも、招待リンクが表示されています。

これで `/地図` が使えるようになります。

---

## うまく動かないとき

| 症状 | 確認すること |
| --- | --- |
| Interactions Endpoint URL を保存できない | Worker の `DISCORD_PUBLIC_KEY` が正しいか。Worker を Deploy し直したか |
| `/地図` が出てこない | 手順 2-3 の「Discord コマンド登録」が成功しているか。サーバーに招待したか。Discord を再起動してみる |
| 「GitHub 401／403／404」と表示される | Worker の `GITHUB_TOKEN`（Actions: Read and write）と `GITHUB_REPO` |
| 「考え中…」のまま止まる | リポジトリの「Actions」タブで「Discord 地図」の記録を開き、赤い × の内容を確認。`DISCORD_SHARED_SECRET` と Worker の `SHARED_SECRET` が同じか |
| `/地図` に古い入力欄（レイヤー・日付など）が残っている | 「Discord コマンド登録」を実行し直して、Discord を再読み込みする |

手元で合成結果だけ確かめたい場合は、リポジトリのフォルダで次を実行します（Python と Pillow が必要です）。

```sh
python tools/discord_map.py --render "白地 国家 国名" --out map.png
```
