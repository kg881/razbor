"""Собирает колоду .apkg из карточек «Разбора» — со звучащими видеофрагментами.

    python3 tools/export_anki.py /tmp/deck.json

deck.json — выгрузка из localStorage приложения (кнопка «В Anki» кладёт её сюда
через бэкенд). На выходе data/anki/razbor.apkg: карточка = фраза с пропуском на
месте слова, на обороте слово с переводом, снизу вырезанный кусок видео.

Клип берётся из data/clips: он там уже лежит с момента сохранения слова, и его
имя однозначно считается из границ реплики — той же формулой, что в server/src/clips.js.
"""
import json
import pathlib
import random
import shutil
import sys

import genanki

ROOT = pathlib.Path(__file__).parent.parent
CLIPS = ROOT / "data" / "clips"
OUT_DIR = ROOT / "data" / "anki"

PAD_BEFORE, PAD_AFTER = 0.25, 0.35   # те же поля, что при вырезке (clips.js)

# Идентификаторы модели и колоды фиксированы: при повторном экспорте Anki обновит
# существующие карточки, а не создаст дубли рядом со старыми.
MODEL_ID = 1607392319
DECK_ID = 2059400110

CSS = """
.card {
  font-family: -apple-system, "SF Pro Text", system-ui, sans-serif;
  font-size: 19px; text-align: center; color: #141c24; background: #f4f7f9;
  padding: 18px;
}
.nightMode.card { color: #e6edf2; background: #0e1317; }
.phrase { font-size: 22px; line-height: 1.5; }
.gap { display: inline-block; min-width: 4em; border-bottom: 2px solid #ff6b4a; }
.word { font-size: 30px; font-weight: 640; margin-bottom: 6px; }
.tr { color: #ff6b4a; font-size: 20px; margin-bottom: 12px; }
.note { color: #7a8b98; font-size: 15px; margin-top: 10px; }
video { max-width: 100%; border-radius: 8px; margin-top: 14px; }
hr#answer { border: 0; border-top: 1px solid #d6dfe6; margin: 16px 0; }
"""

MODEL = genanki.Model(
    MODEL_ID,
    "Разбор — слово в контексте",
    fields=[
        {"name": "Пропуск"},
        {"name": "Слово"},
        {"name": "Перевод"},
        {"name": "Фраза"},
        {"name": "Клип"},
    ],
    templates=[{
        "name": "Клоз по видео",
        # Лицо — фраза с пропуском и клип: вспоминаем слово по контексту и на слух
        "qfmt": '<div class="phrase">{{Пропуск}}</div>{{Клип}}',
        "afmt": '<div class="phrase">{{Фраза}}</div><hr id="answer">'
                '<div class="word">{{Слово}}</div><div class="tr">{{Перевод}}</div>{{Клип}}',
    }],
    css=CSS,
)


def clip_name(vid, start, end):
    """Имя файла клипа — та же формула, что в server/src/clips.js."""
    s = max(0, round((start - PAD_BEFORE) * 1000))
    e = round((end + PAD_AFTER) * 1000)
    if not e > s or e - s > 60_000:
        return None
    return f"{vid}_{s}_{e}.mp4"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cards = json.loads(pathlib.Path(sys.argv[1]).read_text("utf-8"))
    if not cards:
        print("Колода пуста — нечего выгружать")
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    deck = genanki.Deck(DECK_ID, "Разбор")
    media, with_clip = [], 0

    for key, c in cards:
        word = c.get("word", "")
        ctx = c.get("ctx", "")
        wi = c.get("wi", -1)
        words = ctx.split(" ")

        if 0 <= wi < len(words):
            gapped = words.copy()
            gapped[wi] = '<span class="gap"></span>'
            gapped_html = " ".join(gapped)
            full_html = " ".join(
                f"<b>{w}</b>" if i == wi else w for i, w in enumerate(words))
        else:
            gapped_html, full_html = ctx, ctx

        clip_html = ""
        name = clip_name(c["vid"], c["at"], c["end"]) if c.get("vid") and c.get("end") else None
        if name and (CLIPS / name).exists():
            # Anki ищет медиа по плоскому имени в своей папке — кладём как есть
            media.append(str(CLIPS / name))
            clip_html = f'<video src="{name}" controls playsinline></video>'
            with_clip += 1

        deck.add_note(genanki.Note(
            model=MODEL,
            fields=[gapped_html, word, c.get("tr", ""), full_html, clip_html],
            guid=genanki.guid_for(key),   # ключ слова => повторный экспорт обновляет
            tags=["разбор", c.get("vid", "")] if c.get("vid") else ["разбор"],
        ))

    out = OUT_DIR / "razbor.apkg"
    pkg = genanki.Package(deck)
    pkg.media_files = media
    pkg.write_to_file(str(out))

    size = out.stat().st_size / 1e6
    print(f"собрано: {out.relative_to(ROOT)} — {len(cards)} карточек, "
          f"{with_clip} с видеофрагментом, {size:.1f} МБ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
