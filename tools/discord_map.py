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


_cache = {}


def open_cached(src):
    """何枚か作るときに同じ画像を何度も読み込まないように"""
    if src not in _cache:
        _cache[src] = open_rgba(src)
    return _cache[src]


def compose(config, layers, opacity=None):
    """閲覧ページと同じ合成：下地の大きさに各レイヤーを合わせ、不透明度を掛けて重ねる。
    opacity は { レイヤー名: 0〜100 }（指定がなければ管理ページの設定）"""
    opacity = opacity or {}
    base_src = (config.get("base") or {}).get("src")
    base = open_cached(base_src) if base_src else None
    imgs = [(l, open_cached(l["src"])) for l in layers if l.get("src")]
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
        o = opacity[l["name"]] / 100 if l.get("name") in opacity else float(l.get("opacity", 1))
        o = max(0.0, min(1.0, o))
        if o <= 0:
            continue
        if o < 1:
            im = im.copy()
            im.putalpha(im.getchannel("A").point(lambda v: round(v * o)))
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


def send(app_id, token, content, pngs=(), first=True, ephemeral=False):
    """最初は「考え中…」の投稿を差し替え、2 通目以降は続けて投稿する。pngs は (ファイル名, データ) の並び"""
    import requests

    if first:
        url, method = f"{DISCORD_API}/webhooks/{app_id}/{token}/messages/@original", requests.patch
    else:
        url, method = f"{DISCORD_API}/webhooks/{app_id}/{token}", requests.post
    payload = {"content": content, "allowed_mentions": {"parse": []}}
    if not first and ephemeral:
        payload["flags"] = 64
    if not pngs:
        r = method(url, json=payload, timeout=60)
    else:
        payload["attachments"] = [{"id": i, "filename": n} for i, (n, _) in enumerate(pngs)]
        r = method(
            url,
            data={"payload_json": json.dumps(payload, ensure_ascii=False)},
            files={f"files[{i}]": (n, d, "image/png") for i, (n, d) in enumerate(pngs)},
            timeout=180,
        )
    if r.status_code >= 300:
        print(f"Discord への投稿に失敗: {r.status_code} {r.text}", file=sys.stderr)
        r.raise_for_status()


def edit_original(app_id, token, content, png=None):
    send(app_id, token, content, [("map.png", png)] if png is not None else ())


def parse_request(raw):
    """LAYERS の中身。["白地", ...]（1 枚）または {"sets": [[...], [...]], "opacity": {...}}"""
    if not raw:
        return [None], {}
    v = json.loads(raw)
    if isinstance(v, dict):
        sets = v.get("sets") or [None]
        return [s if s is not None else None for s in sets], {k: int(x) for k, x in (v.get("opacity") or {}).items()}
    return [v], {}


CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩"


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
    app_id, token, eph = dest["a"], dest["t"], bool(dest.get("e"))
    label = os.environ.get("LABEL", "")
    try:
        date = os.environ.get("MAP_DATE", "").strip()
        config = config_for_date(date)
        title = config.get("title") or "地図"
        sets, opacity = parse_request(os.environ.get("LAYERS", "").strip())
        images = []
        for i, names in enumerate(sets[:10]):
            layers = pick_layers(config, names)
            data, size, scale = encode_png(compose(config, layers, opacity))
            shown = "・".join(l["name"] for l in layers) or "下地のみ"
            images.append({"name": f"map{i + 1}.png" if len(sets) > 1 else "map.png", "data": data, "shown": shown, "scale": scale})
            print(f"rendered {shown}: {size[0]}x{size[1]} {len(data) / 1e6:.1f}MB")

        when = entry_label(date)
        op_text = "・".join(f"{n} {v}%" for n, v in opacity.items())
        if len(images) == 1:
            im = images[0]
            head = f"**{title}**｜{label}" if label and label != im["shown"] else f"**{title}**"
            lines = [head, f"{when}｜レイヤー: {im['shown']}"]
        else:
            lines = [f"**{title}**｜{label}" if label else f"**{title}**", when]
            lines += [f"{CIRCLED[i]} {im['shown']}" for i, im in enumerate(images)]
        if op_text:
            lines.append(f"透明度: {op_text}")
        small = [CIRCLED[i] if len(images) > 1 else "" for i, im in enumerate(images) if im["scale"] < 1]
        if small:
            lines.append(f"（大きいため{''.join(small)}は縮小しています）")

        # Discord の 1 投稿の上限（画像 10 枚・合計 10MB 程度）に収まるよう、必要なら投稿を分ける
        batches, cur, total = [], [], 0
        for im in images:
            if cur and (total + len(im["data"]) > MAX_BYTES or len(cur) >= 10):
                batches.append(cur)
                cur, total = [], 0
            cur.append(im)
            total += len(im["data"])
        batches.append(cur)
        for bi, batch in enumerate(batches):
            text = "\n".join(lines) if bi == 0 else f"（続き {bi + 1}/{len(batches)}）"
            send(app_id, token, text, [(im["name"], im["data"]) for im in batch], first=bi == 0, ephemeral=eph)
        print(f"posted {len(images)} image(s) in {len(batches)} message(s)")
    except Exception as e:  # 失敗しても「考え中…」のままにしない
        edit_original(app_id, token, f"地図を作成できませんでした: {e}")
        raise


if __name__ == "__main__":
    main()
