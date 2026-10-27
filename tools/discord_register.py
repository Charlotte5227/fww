"""Discord に /地図 コマンドを登録する（GitHub Actions の「Discord コマンド登録」から実行）。"""
import json
import os
import sys

import requests

API = "https://discord.com/api/v10"

COMMAND = {
    "name": "map",
    "name_localizations": {"ja": "地図"},
    "description": "Send the whole map image with the chosen layers",
    "description_localizations": {"ja": "指定したレイヤーで地図全体の画像を送ります"},
    "type": 1,
    "options": [
        {
            "type": 3,
            "name": "layers",
            "name_localizations": {"ja": "レイヤー"},
            "description": "Layer names separated by spaces (leave empty to open a picker)",
            "description_localizations": {
                "ja": "レイヤー名（空白区切りで複数可。「すべて」で全レイヤー。省略すると選択メニューが開きます）"
            },
            "required": False,
            "autocomplete": True,
        },
        {
            "type": 3,
            "name": "date",
            "name_localizations": {"ja": "日付"},
            "description": "Date of the map, e.g. 2026-10-26 (default: latest)",
            "description_localizations": {"ja": "地図の日付（例：2026-10-26、10/26、10/26 14:30。省略すると最新）"},
            "required": False,
            "autocomplete": True,
        },
    ],
}


def main():
    app_id = os.environ.get("DISCORD_APP_ID", "").strip()
    token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if not app_id or not token:
        sys.exit("GitHub のシークレット DISCORD_APP_ID と DISCORD_BOT_TOKEN を設定してください。")
    r = requests.put(
        f"{API}/applications/{app_id}/commands",
        headers={"Authorization": f"Bot {token}", "Content-Type": "application/json"},
        data=json.dumps([COMMAND], ensure_ascii=False).encode("utf-8"),
        timeout=30,
    )
    if r.status_code >= 300:
        sys.exit(f"登録に失敗しました: {r.status_code} {r.text}")
    print("登録しました:", ", ".join(c["name"] for c in r.json()))
    print(f"招待URL: https://discord.com/oauth2/authorize?client_id={app_id}&scope=applications.commands")


if __name__ == "__main__":
    main()
