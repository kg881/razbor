/**
 * Оценка сложности реплик по CEFR — для фильтра «переводить только сложное».
 *
 * Идея: пользователь выбирает свой уровень (B1 / B2 / B2+), и русская дорожка
 * остаётся только под репликами, которые НА или ВЫШЕ этого уровня. Простое он
 * понимает сам — перевод под каждой строкой мешает переключиться на английский.
 *
 * Оценивает Claude тем же локальным CLI, что и переводит. Шкала намеренно грубая,
 * в четыре ступени — тонкие деления CEFR на субтитрах-огрызках не работают:
 *   A  — базовая лексика и грамматика (A1–A2), поймёт любой продолжающий
 *   B1 — обиходные конструкции, phrasal verbs первой сотни
 *   B2 — абстрактная лексика, сложные времена, разговорные обороты
 *   C  — идиомы, редкая лексика, культурные отсылки (C1+)
 *
 * Кэш — data/levels/<videoId>.json, {"номер строки": "A|B1|B2|C"}.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude, parseJsonReply } from './claude.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIR = path.join(ROOT, 'data', 'levels')

const BATCH = 120           // оценка сильно дешевле перевода — пачки крупнее
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY || 5)
const GRADES = new Set(['A', 'B1', 'B2', 'C'])

const SYSTEM = `Ты оцениваешь сложность строк английских субтитров для русскоязычного ученика.

Оценка строки — это уровень, начиная с которого её поймут БЕЗ перевода. Определяется
самым сложным элементом строки (слово, идиома, конструкция):
  A  — базовая лексика и простая грамматика (A1–A2)
  B1 — обиходные конструкции, частые phrasal verbs, простые времена перфекта
  B2 — абстрактная лексика, сослагательность, разговорные обороты
  C  — идиомы, редкая или книжная лексика, культурные отсылки (C1 и выше)

Строки — обрывки речи, рваные по таймингу; оценивай по содержимому самой строки.
Пометки вроде [Music] и междометия — всегда A.

Ответ — только JSON-объект {"номер строки": "A|B1|B2|C"}, один раз, без текста вокруг.`

function makeBatches(texts) {
  const out = []
  for (let start = 0; start < texts.length; start += BATCH) {
    const end = Math.min(start + BATCH, texts.length)
    out.push({
      from: start,
      to: end - 1,
      lines: Object.fromEntries(
        Array.from({ length: end - start }, (_, k) => [String(start + k), texts[start + k]])),
    })
  }
  return out
}

async function gradeBatch(b, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await runClaude(
        `Оцени строки ${b.from}–${b.to}. Верни JSON с теми же номерами:\n\n${JSON.stringify(b.lines, null, 0)}`,
        { system: SYSTEM, signal, timeoutMs: 180_000 })
      const obj = parseJsonReply(reply)
      const lines = {}
      for (let i = b.from; i <= b.to; i++) {
        const v = String(obj[String(i)] || '').toUpperCase().replace('С', 'C') // кириллическая С
        if (GRADES.has(v)) lines[i] = v
      }
      if (Object.keys(lines).length) return lines
    } catch (e) {
      if (e.code === 'ABORTED' || attempt) throw e
    }
  }
  return {}
}

export async function readLevels(videoId) {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, `${videoId}.json`), 'utf8'))
  } catch {
    return null
  }
}

async function writeLevels(videoId, lines) {
  await fs.mkdir(DIR, { recursive: true })
  await fs.writeFile(path.join(DIR, `${videoId}.json`), JSON.stringify(lines), 'utf8')
}

/** Тот же конвейер, что у перевода: пул воркеров, отдача пачек по готовности. */
export async function* gradeVideo(videoId, texts, { signal } = {}) {
  const cached = (await readLevels(videoId)) || {}
  const missing = b => {
    for (let i = b.from; i <= b.to; i++) if (!cached[String(i)]) return true
    return false
  }
  const batches = makeBatches(texts).filter(missing)
  const all = { ...cached }
  let done = Object.keys(cached).length

  if (done) yield { lines: cached, done, total: texts.length, cached: true }
  if (!batches.length) return
  console.log(`[уровни] ${videoId}: ${batches.length} пачек, готово ${done}/${texts.length}`)

  const queue = []
  let next = 0, running = true, wake = null
  const push = r => { queue.push(r); const w = wake; wake = null; w?.() }
  const worker = async () => {
    while (next < batches.length && !signal?.aborted) {
      const b = batches[next++]
      try { push({ lines: await gradeBatch(b, signal) }) }
      catch (e) { push({ lines: {}, error: e.message }) }
    }
  }
  Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker))
    .finally(() => { running = false; const w = wake; wake = null; w?.() })

  try {
    while (true) {
      if (queue.length) {
        const { lines, error } = queue.shift()
        Object.assign(all, lines)
        done += Object.keys(lines).length
        if (Object.keys(lines).length) await writeLevels(videoId, all)
        yield { lines, done, total: texts.length, error }
        continue
      }
      if (!running || signal?.aborted) break
      await new Promise(res => { wake = res })
    }
  } finally {
    if (Object.keys(all).length) await writeLevels(videoId, all)
  }
}
