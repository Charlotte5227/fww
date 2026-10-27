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
            "description": "Layer names separated by spaces; use | for separate images (empty: picker)",
            "description_localizations": {
                "ja": "レイヤー名（空白区切り。「|」で区切ると別々の画像に。省略すると選択メニュー）"
            },
            "required": False,
            "autocomplete": True,
        },
        *[
            {
                "type": 3,
                "name": f"layers{n}",
                "name_localizations": {"ja": f"画像{n}"},
                "description": f"Layers for image {n} (sent together)",
                "description_localizations": {"ja": f"{n}枚目の地図のレイヤー（空白区切り。まとめて送られます）"},
                "required": False,
                "autocomplete": True,
            }
            for n in range(2, 11)
        ],
        {
            "type": 3,
            "name": "date",
            "name_localizations": {"ja": "日付"},
            "description": "Date of the map, e.g. 2026-10-26 (default: latest)",
            "description_localizations": {"ja": "地図の日付（例：2026-10-26、10/26、10/26 14:30。省略すると最新）"},
            "required": False,
            "autocomplete": True,
        },
        {
            "type": 3,
            "name": "opacity",
            "name_localizations": {"ja": "透明度"},
            "description": "Layer opacity 0-100, e.g. 国家 50 海域 30",
            "description_localizations": {"ja": "例：国家 50 海域 30（100=そのまま 50=半分透ける 0=見えない）"},
            "required": False,
            "autocomplete": True,
        },
        {
            "type": 5,
            "name": "private",
            "name_localizations": {"ja": "自分だけ"},
            "description": "Only you can see the map",
            "description_localizations": {"ja": "True にすると、地図が自分にだけ見える形で送られます"},
            "required": False,
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
