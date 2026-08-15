"""Готовит видео к разбору: тянет субтитры по ссылке и раскладывает на пачки для перевода.

Перевод делает Claude в диалоге — не словарь и не сторонний API. Поэтому скрипт
только добывает текст и режет его на куски с перекрытием: субтитры рвут предложения
посередине, и без соседних строк перевести их связно невозможно.

    python3 tools/prepare.py "https://youtu.be/VIDEOID"        # скачать и нарезать
    python3 tools/prepare.py --batches VIDEOID                 # показать пачки заново

Результат: data/cues_<videoId>.json  +  /tmp/razbor_batches_<videoId>.json
"""
import json
import pathlib
import sys
import urllib.request
import ssl
import re

def _ctx():
    """Свой SSL-контекст: системные корневые сертификаты Python на macOS часто
    не настроены, и запрос к youtube.com падает на проверке сертификата."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()

ROOT = pathlib.Path(__file__).parent.parent
API = "http://localhost:8788"
BATCH = 40          # строк в пачке
OVERLAP = 3         # сколько соседних строк показать для контекста


def video_id(s):
    s = s.strip()
    if re.fullmatch(r"[\w-]{11}", s):
        return s
    m = re.search(r"(?:v=|youtu\.be/|embed/|shorts/|live/)([\w-]{11})", s)
    return m.group(1) if m else None


def post(path, payload):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60, context=_ctx()) as r:
        return json.loads(r.read())


def fetch(url):
    """Через свой бэкенд: он даёт подписанную ссылку, качаем по ней."""
    info = post("/api/track", {"url": url, "lang": "en"})
    with urllib.request.urlopen(info["picked"]["url"], timeout=90, context=_ctx()) as r:
        raw = json.loads(r.read())
    cues = post("/api/cues", raw)["cues"]
    return info, cues


def make_batches(cues):
    """Режем на пачки. В каждую добавляем хвост предыдущей и начало следующей —
    без этого модель не поймёт разорванное предложение."""
    out = []
    for start in range(0, len(cues), BATCH):
        end = min(start + BATCH, len(cues))
        out.append({
            "from": start,
            "to": end - 1,
            "before": [c["text"] for c in cues[max(0, start - OVERLAP):start]],
            "lines": {str(i): cues[i]["text"] for i in range(start, end)},
            "after": [c["text"] for c in cues[end:end + OVERLAP]],
        })
    return out


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 1

    if args[0] == "--batches":
        vid = video_id(args[1]) or args[1]
        cues = json.loads((ROOT / "data" / f"cues_{vid}.json").read_text("utf-8"))
        title = ""
    else:
        vid = video_id(args[0])
        if not vid:
            print("Не похоже на ссылку YouTube")
            return 1
        info, cues = fetch(args[0])
        title = info.get("title", "")
        (ROOT / "data" / f"cues_{vid}.json").write_text(
            json.dumps(cues, ensure_ascii=False), encoding="utf-8")

    batches = make_batches(cues)
    pathlib.Path(f"/tmp/razbor_batches_{vid}.json").write_text(
        json.dumps({"videoId": vid, "title": title, "batches": batches}, ensure_ascii=False),
        encoding="utf-8")

    print(f"videoId: {vid}")
    if title:
        print(f"название: {title}")
    print(f"реплик: {len(cues)}  пачек: {len(batches)} по {BATCH}")
    print(f"пачки: /tmp/razbor_batches_{vid}.json")
    print(f"перевод класть в: data/translations/{vid}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
