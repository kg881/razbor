/**
 * json3 (формат субтитров YouTube) → чистые реплики.
 *
 * Две реальные проблемы формата, из-за которых наивный парсер ломается:
 *  1. roll-up: ASR перерисовывает «бегущую строку», один и тот же текст приходит
 *     несколько раз нарастающими кусками. В типичном ролике это половина событий.
 *  2. пословный тайминг лежит не рядом, а как tStartMs реплики + tOffsetMs сегмента.
 *     Именно он позволяет делать караоке-подсветку без forced alignment.
 *
 * Важно: у РУЧНЫХ субтитров tOffsetMs нет — там тайминг только на реплику целиком.
 * Для них слова раскладываются пропорционально длине (точность ±100-200 мс, для чтения хватает).
 */
export function normalizeJson3(raw) {
  const cues = []

  for (const ev of raw.events || []) {
    const segs = ev.segs
    if (!segs?.length) continue

    const text = segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim()
    if (!text) continue

    const start = (ev.tStartMs ?? 0) / 1000
    const dur = (ev.dDurationMs ?? 0) / 1000
    const hasWordTiming = segs.some(s => s.tOffsetMs != null)

    let words = segs
      .map(s => ({ w: (s.utf8 || '').trim(), off: s.tOffsetMs ?? 0 }))
      .filter(s => s.w)
      .map(s => ({ w: s.w, t: start + s.off / 1000 }))

    // Ручные субтитры: раскладываем слова пропорционально их длине в символах
    if (!hasWordTiming && words.length > 1 && dur > 0) {
      const total = words.reduce((n, x) => n + x.w.length, 0)
      let acc = 0
      words = words.map(x => {
        const t = start + (acc / total) * dur
        acc += x.w.length
        return { w: x.w, t }
      })
    }

    if (words.length) cues.push({ start, end: start + dur, text, words })
  }

  // Схлопываем roll-up: если реплика — префикс следующей и они рядом,
  // это промежуточный кадр той же строки, оставляем самую полную.
  const merged = []
  for (const c of cues) {
    const prev = merged[merged.length - 1]
    if (prev && c.text.startsWith(prev.text) && c.start - prev.start < 2.5) {
      merged[merged.length - 1] = c
    } else {
      merged.push(c)
    }
  }

  // Границы: реплика не должна залезать на следующую, нулевых длительностей не бывает
  for (let i = 0; i < merged.length; i++) {
    if (i + 1 < merged.length) {
      merged[i].end = Math.min(merged[i].end, merged[i + 1].start)
    }
    if (merged[i].end <= merged[i].start) merged[i].end = merged[i].start + 1.2
  }

  return merged
}
