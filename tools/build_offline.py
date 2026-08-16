"""Собирает автономную страницу офлайн-пакета: data/offline/<vid>/razbor.html.

    python3 tools/build_offline.py VIDEOID

Страница живёт без сети: реплики, перевод и уровни зашиты внутрь, плеер —
локальный <video> с файлом <vid>.mp4, лежащим рядом. YouTube и бэкенд не нужны.
Видео должно быть уже скачано (это делает server/src/offline.js).
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).parent.parent


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    vid = sys.argv[1]

    cues_path = ROOT / "data" / f"cues_{vid}.json"
    if not cues_path.exists():
        # Реплики демо-видео живут под другим именем
        if vid == "arj7oStGLkU" and (ROOT / "data" / "cues_local.json").exists():
            cues_path = ROOT / "data" / "cues_local.json"
        else:
            print(f"Нет data/cues_{vid}.json — сначала открой видео в приложении")
            return 1
    cues = json.loads(cues_path.read_text("utf-8"))

    def load(sub):
        p = ROOT / "data" / sub / f"{vid}.json"
        return json.loads(p.read_text("utf-8")) if p.exists() else {}

    offline = {
        "video": f"{vid}.mp4",
        "translations": load("translations"),
        "levels": load("levels"),
    }

    html = (ROOT / "template.html").read_text("utf-8")
    html = html.replace("/*__CUES__*/", json.dumps(cues, ensure_ascii=False))
    html = html.replace("/*__OFFLINE__*/null", json.dumps(offline, ensure_ascii=False))
    html = html.replace('let VIDEO_ID = "arj7oStGLkU";', f'let VIDEO_ID = "{vid}";')

    out = ROOT / "data" / "offline" / vid / "razbor.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"собрано: {out.relative_to(ROOT)} — {len(cues)} реплик, "
          f"{len(offline['translations'])} переводов, {len(offline['levels'])} оценок")
    return 0


if __name__ == "__main__":
    sys.exit(main())
