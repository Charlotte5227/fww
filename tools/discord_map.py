"""Discord の /地図 コマンドで呼ばれ、地図を合成して Discord に投稿する（GitHub Actions で実行）。

手元で合成結果だけ確かめる場合:
    python tools/discord_map.py --render "白地 国家 国名" --out map.png
"""
import argparse
import base64
import hashlib
import io
import json
import os
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DISCORD_API = os.environ.get("DISCORD_API", "https://discord.com/api/v10")
MAX_BYTES = 9_500_000  # Discord の添付上限（10MB）に余裕を持たせる
ALL_WORDS = {"すべて", "全部", "all"}


def load_config():
    with open(ROOT / "data" / "config.json", encoding="utf-8") as f:
        return json.load(f)


WEEK = "月火水木金土日"


def long_date(d):
    from datetime import date
    y, m, dd = (int(x) for x in d.split("-"))
    return f"{y}年{m}月{dd}日（{WEEK[date(y, m, dd).weekday()]}）"


def find_entry(key):
    """記録の ID、または日付（その日のいちばん新しい記録）で履歴を探す"""
    path = ROOT / "data" / "history.json"
    if not path.exists():
        raise ValueError("履歴（data/history.json）がありません")
    with open(path, encoding="utf-8") as f:
        entries = json.load(f).get("entries", [])
    for e in entries:
        if str(e.get("id") or e.get("date")) == key:
            return e
    same_day = [e for e in entries if e.get("date") == key]
    if same_day:
        return max(same_day, key=lambda e: f"{e.get('time') or ''} {e.get('savedAt') or ''}")
    raise ValueError(f"{key} の記録が見つかりません")


def config_for_date(key):
    """空なら最新（config.json）、それ以外は履歴の記録"""
    if not key:
        return load_config()
    return find_entry(key)["config"]


def entry_label(key):
    if not key:
        return "最新の地図"
    e = find_entry(key)
    return f"{long_date(e['date'])}{' ' + e['time'] if e.get('time') else ''}の地図"


def pick_layers(config, names):
    """names が None なら初期表示のレイヤー。重なり順は config の順"""
    layers = config.get("layers", [])
    if names is None:
        return [l for l in layers if l.get("visible", True)]
    if any(n.lower() in ALL_WORDS for n in names):
        return list(layers)
    unknown = [n for n in names if not any(l.get("name") == n for l in layers)]
    if unknown:
        raise ValueError("レイヤーが見つかりません: " + "、".join(unknown))
    return [l for l in layers if l.get("name") in names]


def open_rgba(src):
    return Image.open(ROOT / src).convert("RGBA")


def compose(config, layers):
    """閲覧ページと同じ合成：下地の大きさに各レイヤーを合わせ、不透明度を掛けて重ねる"""
    base_src = (config.get("base") or {}).get("src")
    base = open_rgba(base_src) if base_src else None
    imgs = [(l, open_rgba(l["src"])) for l in layers if l.get("src")]
    if base is not None:
        size = base.size
    elif imgs:
        size = max((im.size for _, im in imgs), key=lambda s: s[0] * s[1])
    else:
        raise ValueError("表示する画像がありません")
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    if base is not None:
        out.alpha_composite(base)
    for l, im in imgs:
        if im.size != size:
            im = im.resize(size, Image.LANCZOS)
        opacity = max(0.0, min(1.0, float(l.get("opacity", 1))))
        if opacity < 1:
            a = im.getchannel("A").point(lambda v: round(v * opacity))
            im.putalpha(a)
        out.alpha_composite(im)
    return out


def encode_png(img):
    """Discord の上限に収まるまで圧縮・縮小する"""
    scale = 1.0
    while True:
        im = img if scale == 1.0 else img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        # 全面不透明なら RGB にして軽くする
        if im.getchannel("A").getextrema() == (255, 255):
            im = im.convert("RGB")
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        data = buf.getvalue()
        if len(data) <= MAX_BYTES or scale < 0.3:
            return data, im.size, scale
        scale *= 0.8


def unseal(sealed, secret):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    raw = base64.urlsafe_b64decode(sealed + "=" * (-len(sealed) % 4))
    key = hashlib.sha256(secret.encode("utf-8")).digest()
    plain = AESGCM(key).decrypt(raw[:12], raw[12:], None)
    return json.loads(plain)


def edit_original(app_id, token, content, png=None):
    import requests

    url = f"{DISCORD_API}/webhooks/{app_id}/{token}/messages/@original"
    payload = {"content": content, "allowed_mentions": {"parse": []}}
    if png is None:
        r = requests.patch(url, json=payload, timeout=60)
    else:
        payload["attachments"] = [{"id": 0, "filename": "map.png"}]
        r = requests.patch(
            url,
            data={"payload_json": json.dumps(payload, ensure_ascii=False)},
            files={"files[0]": ("map.png", png, "image/png")},
            timeout=120,
        )
    if r.status_code >= 300:
        print(f"Discord への投稿に失敗: {r.status_code} {r.text}", file=sys.stderr)
        r.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--render", help="手元で確認する場合のレイヤー名（空白区切り。空文字なら初期表示）")
    ap.add_argument("--date", default="", help="記録の ID か日付（YYYY-MM-DD）。省略すると最新")
    ap.add_argument("--out", default="map.png")
    args = ap.parse_args()

    if args.render is not None:
        config = config_for_date(args.date)
        names = args.render.split() or None
        data, size, _ = encode_png(compose(config, pick_layers(config, names)))
        Path(args.out).write_bytes(data)
        print(f"{args.out}: {size[0]}x{size[1]}, {len(data) / 1e6:.1f}MB")
        return

    # GitHub Actions から呼ばれた場合
    dest = unseal(os.environ["PAYLOAD"], os.environ["DISCORD_SHARED_SECRET"])
    app_id, token = dest["a"], dest["t"]
    label = os.environ.get("LABEL", "")
    try:
        date = os.environ.get("MAP_DATE", "").strip()
        config = config_for_date(date)
        title = config.get("title") or "地図"
        raw = os.environ.get("LAYERS", "").strip()
        names = json.loads(raw) if raw else None
        layers = pick_layers(config, names)
        data, size, scale = encode_png(compose(config, layers))
        shown = "・".join(l["name"] for l in layers) or "下地のみ"
        note = f"\n（大きいため {round(scale * 100)}% に縮小しています）" if scale < 1 else ""
        head = f"**{title}**｜{label}" if label and label != shown else f"**{title}**"
        when = entry_label(date)
        edit_original(app_id, token, f"{head}\n{when}｜レイヤー: {shown}{note}", data)
        print(f"posted {size[0]}x{size[1]} {len(data) / 1e6:.1f}MB")
    except Exception as e:  # 失敗しても「考え中…」のままにしない
        edit_original(app_id, token, f"地図を作成できませんでした: {e}")
        raise


if __name__ == "__main__":
    main()
