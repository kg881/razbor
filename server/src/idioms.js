/**
 * Радар идиом и фразовых глаголов.
 *
 * Зачем: «plow through» легко проскочить, не заметив, что это цельное выражение —
 * кликаешь «plow», получаешь бессмыслицу, идёшь дальше. Радар сканирует расшифровку
 * ЗАРАНЕЕ и помечает пунктиром всё, что надо учить целиком, до первого клика.
 *
 * Ищет Claude тем же локальным CLI. Отмечаем только то, что не переводится
 * пословно: фразовые глаголы, идиомы, устойчивые сочетания, разговорные
 * конструкции. Банальную грамматику (going to, have to) не трогаем — пунктир
 * под каждой второй строкой перестаёт быть сигналом.
 *
 * Кэш — data/idioms/<videoId>.json: {"номер строки": ["выражение", ...]}.
 * Выражение приводится в точной форме из текста — клиент ищет его в строке
 * пословным сравнением и подчёркивает найденные спаны.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude, parseJsonReply } from './claude.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIR = path.join(ROOT, 'data', 'idioms')

const BATCH = 100
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY || 5)

const SYSTEM = `Ты ищешь в английских субтитрах выражения, которые ученику (уровень B1–B2) надо учить ЦЕЛИКОМ, потому что пословно они не переводятся:

- фразовые глаголы: plow through, get away with, wind up
- идиомы и образные обороты: cut corners, the elephant in the room
- устойчивые сочетания: make a decision, pay attention, take for granted
- разговорные конструкции с неочевидным смыслом: might as well, I'm about to

НЕ отмечай: свободные сочетания слов, одиночные слова, базовую грамматику
(going to, have to, want to), имена и названия. Лучше пропустить спорное,
чем замусорить разметку — пунктир под каждой строкой перестаёт быть сигналом.

Субтитры рваные: выражение может начаться в одной строке и кончиться в следующей.
Относи его к строке, где оно НАЧИНАЕТСЯ, и приводи точно в том виде, как в тексте
(те же формы слов, без леммы).

Ответ — только JSON-объект {"номер строки": ["выражение", ...]}, включай только
строки, где что-то найдено. Без текста вокруг.`

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

async function scanBatch(b, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await runClaude(
        `Найди выражения в строках ${b.from}–${b.to}. Верни JSON:\n\n${JSON.stringify(b.lines, null, 0)}`,
        { system: SYSTEM, signal, timeoutMs: 180_000 })
      const obj = parseJsonReply(reply)
      const lines = {}
      for (let i = b.from; i <= b.to; i++) {
        const v = obj[String(i)]
        if (Array.isArray(v)) {
          const clean = v.filter(x => typeof x === 'string' && x.trim().includes(' ')).map(x => x.trim())
          if (clean.length) lines[i] = clean
        }
      }
      return lines   // пустой результат валиден: в пачке могло не быть выражений
    } catch (e) {
      if (e.code === 'ABORTED' || attempt) throw e
    }
  }
  return {}
}

export async function readIdioms(videoId) {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, `${videoId}.json`), 'utf8'))
  } catch {
    return null
  }
}

async function writeIdioms(videoId, data) {
  await fs.mkdir(DIR, { recursive: true })
  await fs.writeFile(path.join(DIR, `${videoId}.json`), JSON.stringify(data), 'utf8')
}

/**
 * Тот же конвейер, что у перевода и уровней. Отличие: «в строке ничего нет» —
 * валидный ответ, поэтому прогресс меряем обработанными СТРОКАМИ, а не найденным,
 * и для докачки помечаем завершённые пачки отдельным ключом __done.
 */
export async function* scanVideo(videoId, texts, { signal } = {}) {
  const cached = (await readIdioms(videoId)) || {}
  const doneBatches = new Set(cached.__done || [])
  const batches = makeBatches(texts).filter(b => !doneBatches.has(b.from))
  const all = { ...cached }

  if (Object.keys(cached).length) {
    const { __done, ...lines } = cached
    yield { lines, done: doneBatches.size * BATCH, total: texts.length, cached: true }
  }
  if (!batches.length) return
  console.log(`[идиомы] ${videoId}: ${batches.length} пачек`)

  const queue = []
  let next = 0, running = true, wake = null
  const push = r => { queue.push(r); const w = wake; wake = null; w?.() }
  const worker = async () => {
    while (next < batches.length && !signal?.aborted) {
      const b = batches[next++]
      try { push({ b, lines: await scanBatch(b, signal) }) }
      catch (e) { push({ b, lines: null, error: e.message }) }
    }
  }
  Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker))
    .finally(() => { running = false; const w = wake; wake = null; w?.() })

  try {
    while (true) {
      if (queue.length) {
        const { b, lines, error } = queue.shift()
        if (lines !== null) {
          Object.assign(all, lines)
          doneBatches.add(b.from)
          all.__done = [...doneBatches]
          await writeIdioms(videoId, all)
        }
        yield { lines: lines || {}, done: doneBatches.size * BATCH, total: texts.length, error }
        continue
      }
      if (!running || signal?.aborted) break
      await new Promise(res => { wake = res })
    }
  } finally {
    if (Object.keys(all).length) await writeIdioms(videoId, all)
  }
}
