"""Кладёт готовый перевод рядом с видео и проверяет, что он полный.

    python3 tools/save_translation.py VIDEOID /tmp/lines.json

lines.json — объект {"0": "перевод", "1": "перевод", ...}, где ключ это номер реплики.
Проверяем главное: у каждой реплики есть перевод и ничего не съехало по нумерации,
иначе вторая дорожка будет показывать чужие строки.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).parent.parent


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1

    vid, src = sys.argv[1], sys.argv[2]
    cues = json.loads((ROOT / "data" / f"cues_{vid}.json").read_text("utf-8"))
    lines = json.loads(pathlib.Path(src).read_text("utf-8"))
    if "lines" in lines:               # принимаем и сырой ответ воркфлоу
        lines = lines["lines"]

    missing = [i for i in range(len(cues)) if not lines.get(str(i), "").strip()]
    extra = [k for k in lines if not k.isdigit() or int(k) >= len(cues)]

    out = ROOT / "data" / "translations" / f"{vid}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(lines, ensure_ascii=False, indent=0), encoding="utf-8")

    done = len(cues) - len(missing)
    print(f"реплик: {len(cues)}  переведено: {done} ({done / len(cues):.0%})")
    if missing:
        print(f"без перевода: {len(missing)} шт, первые — {missing[:10]}")
    if extra:
        print(f"лишние ключи: {extra[:5]}")
    print(f"сохранено: {out.relative_to(ROOT)}")

    # Контроль сдвига: показываем пары, чтобы глазами убедиться в соответствии
    print("\nпроверка соответствия:")
    for i in (0, len(cues) // 2, len(cues) - 1):
        print(f"  [{i}] {cues[i]['text'][:52]}")
        print(f"      {lines.get(str(i), '—')[:52]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
