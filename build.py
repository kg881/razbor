"""Собирает自-contained index.html: шаблон + реальные реплики + словарь.

Запуск:  python3 build.py
Результат: index.html — открывается двойным кликом, работает без сервера.
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).parent
SRC_JSON3 = sys.argv[1] if len(sys.argv) > 1 else None

# 1. Реплики: нормализуем из json3, либо берём уже готовые
# Локальная полная расшифровка имеет приоритет; в репозитории её нет (см. .gitignore),
# поэтому у всех остальных соберётся демо-фрагмент.
cues_path = ROOT / "data" / "cues_local.json"
if not cues_path.exists():
    cues_path = ROOT / "data" / "cues_demo.json"
if SRC_JSON3:
    out = subprocess.run(
        [sys.executable, str(ROOT / "tools" / "normalize_json3.py"), SRC_JSON3],
        capture_output=True, text=True, check=True,
    )
    cues_path.write_text(out.stdout, encoding="utf-8")
    print(out.stderr.strip())

cues = json.loads(cues_path.read_text(encoding="utf-8"))
vocab = json.loads((ROOT / "data" / "dict_en_ru.json").read_text(encoding="utf-8"))

template = (ROOT / "template.html").read_text(encoding="utf-8")
html = template.replace("/*__CUES__*/", json.dumps(cues, ensure_ascii=False))
html = html.replace("/*__VOCAB__*/", json.dumps(vocab, ensure_ascii=False))

(ROOT / "index.html").write_text(html, encoding="utf-8")
print(f"index.html собран: {len(cues)} реплик, {len(vocab)} словарных статей")
