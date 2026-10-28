"""Discord に /地図 と /地図設定 コマンドを登録する（GitHub Actions の「Discord コマンド登録」から実行）。"""
import json
import os
import sys

import requests

API = "https://discord.com/api/v10"

# 使い方の項目（discord/worker.js の HELP と同じ key にする）
HELP_TOPICS = [
    ("index", "はじめに（できることと基本の流れ）", "Getting started"),
    ("menu", "メニューの使い方", "Using the menu"),
    ("sets", "まとめて送る", "Sending several maps"),
    ("date", "過去の地図", "Past maps"),
    ("opacity", "透明度", "Opacity"),
    ("private", "自分だけに表示", "Only visible to you"),
    ("trouble", "困ったとき", "Troubleshooting"),
    ("site", "閲覧ページ", "Viewer page"),
]

COMMAND = {
    "name": "map",
    "name_localizations": {"ja": "地図"},
    "description": "Open the map menu (only you can see it)",
    "description_localizations": {"ja": "地図のメニューを開きます（自分にだけ見えます）"},
    "type": 1,
    "options": [
        {
            "type": 3,
            "name": "help",
            "name_localizations": {"ja": "使い方"},
            "description": "Show how to use this (only you can see it)",
            "description_localizations": {"ja": "使い方を表示します（自分にだけ見えます）。知りたい項目を選んでください"},
            "required": False,
            "choices": [
                {"name": en, "name_localizations": {"ja": ja}, "value": key}
                for key, ja, en in HELP_TOPICS
            ],
        },
    ],
}

# 管理メニュー。だれにでも見えるが、権限がない人には「権限がありません」と返す。
# パスワードの入力欄には候補を出さない（choices も autocomplete も付けない）
SETTINGS_COMMAND = {
    "name": "mapsettings",
    "name_localizations": {"ja": "地図設定"},
    "description": "Open the map admin menu for this server",
    "description_localizations": {"ja": "このサーバーの地図の管理メニューを開きます（自分にだけ見えます）"},
    "type": 1,
    "contexts": [0],
    "integration_types": [0],
    "options": [
        {
            "type": 3,
            "name": "password",
            "name_localizations": {"ja": "パスワード"},
            "description": "Only if you were given the password",
            "description_localizations": {"ja": "パスワードを教えてもらっている場合だけ入力します"},
            "required": False,
            "max_length": 64,
        },
    ],
}

# Bot に必要な権限：チャンネルを見る・メッセージを送る・ファイルを添付・埋め込みリンク
BOT_PERMISSIONS = (1 << 10) | (1 << 11) | (1 << 15) | (1 << 14)


def main():
    app_id = os.environ.get("DISCORD_APP_ID", "").strip()
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if not app_id or not token:
        sys.exit("GitHub のシークレット DISCORD_APP_ID と DISCORD_BOT_TOKEN を設定してください。")
    r = requests.put(
        f"{API}/applications/{app_id}/commands",
        headers={"Authorization": f"Bot {token}", "Content-Type": "application/json"},
        data=json.dumps([COMMAND, SETTINGS_COMMAND], ensure_ascii=False).encode("utf-8"),
        timeout=30,
    )
    if r.status_code >= 300:
        sys.exit(f"登録に失敗しました: {r.status_code} {r.text}")
    print("登録しました:", ", ".join(c["name"] for c in r.json()))
    print("招待URL（お絵かきページからの送信を使うときは、Bot ごとサーバーに入れ直してください）:")
    print(f"https://discord.com/oauth2/authorize?client_id={app_id}&scope=bot+applications.commands&permissions={BOT_PERMISSIONS}")


if __name__ == "__main__":
    main()
