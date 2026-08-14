"""json3 (YouTube ASR) → чистые реплики с пословным таймингом.

Решает две реальные проблемы формата:
1. roll-up: ASR перерисовывает «бегущую строку», события с aAppend дублируют текст.
2. пословный тайминг лежит как tStartMs + tOffsetMs у каждого сегмента.

Использование: python3 normalize_json3.py in.json3 > cues.json
"""
import json, sys, re


def normalize(raw: dict) -> list[dict]:
    cues = []
    for ev in raw.get("events", []):
        segs = ev.get("segs")
        if not segs:
            continue
        # roll-up: событие только дописывает перевод строки — текста не несёт
        text = "".join(s.get("utf8", "") for s in segs)
        if not text.strip():
            continue
        start = ev.get("tStartMs", 0)
        words = []
        for s in segs:
            w = s.get("utf8", "")
            if not w.strip():
                continue
            words.append({
                "w": w.strip(),
                "t": (start + s.get("tOffsetMs", 0)) / 1000.0,
            })
        if not words:
            continue
        cues.append({
            "start": start / 1000.0,
            "end": (start + ev.get("dDurationMs", 0)) / 1000.0,
            "text": re.sub(r"\s+", " ", text).strip(),
            "words": words,
        })

    # Схлопываем roll-up: если реплика целиком входит в следующую — она промежуточный кадр
    out = []
    for c in cues:
        if out and c["text"].startswith(out[-1]["text"]) and c["start"] - out[-1]["start"] < 2.5:
            out[-1] = c            # следующая полнее — заменяем
        else:
            out.append(c)

    # Убираем нулевые длительности и слипшиеся границы
    for i, c in enumerate(out):
        if i + 1 < len(out):
            c["end"] = min(c["end"], out[i + 1]["start"])
        if c["end"] <= c["start"]:
            c["end"] = c["start"] + 1.2
    return out


if __name__ == "__main__":
    data = json.load(open(sys.argv[1]))
    cues = normalize(data)
    print(json.dumps(cues, ensure_ascii=False), file=sys.stdout)
    print(f"реплик после нормализации: {len(cues)}", file=sys.stderr)
