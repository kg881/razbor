/**
 * Перевод дорожки субтитров целиком — пачками, параллельно, с отдачей по мере готовности.
 *
 * Главная сложность не в переводе, а в том, что субтитры рвут предложение посередине:
 * строка обрывается на «I think they would have» и продолжается в следующей. Пословный
 * словарь на таком материале даёт мусор, поэтому переводим блоком и раскладываем обратно
 * 1:1, а соседние строки отдаём как контекст, не требуя их перевода.
 *
 * Отдаём пачки по мере готовности (async generator), а не одним ответом в конце:
 * у двухчасового подкаста пачек полсотни, и ждать их все — значит смотреть в пустой экран.
 * Начало появляется через несколько секунд, остальное дотекает фоном.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude, parseJsonReply } from './claude.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIR = path.join(ROOT, 'data', 'translations')

export const BATCH = 40      // строк в пачке: больше — дольше первый показ, меньше — хуже контекст
export const OVERLAP = 3     // соседних строк для контекста
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY || 5)

const SYSTEM = `Ты переводишь субтитры английского видео на русский для человека, который учит язык.

Как устроен материал: субтитры нарезаны по времени, а не по смыслу. Предложение регулярно
начинается в одной строке и заканчивается в следующей. Поэтому:
- сначала прочитай весь блок целиком и пойми мысль, потом переводи;
- перевод раскладывай обратно строка-в-строку: сколько строк на входе, столько на выходе;
- если английская строка — обрывок, русская тоже остаётся обрывком. Не дополняй её и не
  переноси в неё смысл соседней строки, иначе перевод разъедется с речью на экране;
- порядок слов подгоняй так, чтобы стык строк читался естественно.

Язык перевода: живой разговорный русский, как человек говорит вслух. Не подстрочник.
Идиомы передавай смыслом, а не буквально. Филлеры (you know, like, I mean) переводи только
там, где они несут интонацию, иначе опускай.
Служебные пометки: [Music] → [музыка], [Applause] → [аплодисменты], [Laughter] → [смех].

Ответ — только JSON-объект {"номер строки": "перевод"}, один раз, без пояснений и без текста
до или после него. Заметил у себя опечатку — молча выведи исправленный JSON, не комментируй.`

export const FIRST_BATCH = 15  // начало видео отдаём мелкой пачкой — она считается вдвое быстрее

/**
 * Режем на пачки, каждой даём хвост предыдущей и начало следующей.
 * Первая пачка намеренно короче: смотреть начинают с начала, и ждать там полные 40 строк
 * (≈26 с) незачем — короткая приезжает секунд за десять, остальное дотекает следом.
 */
export function makeBatches(texts) {
  const out = []
  for (let start = 0; start < texts.length; ) {
    const size = start === 0 ? Math.min(FIRST_BATCH, texts.length) : BATCH
    const end = Math.min(start + size, texts.length)
    out.push({
      from: start,
      to: end - 1,
      before: texts.slice(Math.max(0, start - OVERLAP), start),
      after: texts.slice(end, end + OVERLAP),
      lines: Object.fromEntries(
        Array.from({ length: end - start }, (_, k) => [String(start + k), texts[start + k]])),
    })
    start = end
  }
  return out
}

function buildPrompt(b) {
  const ctx = []
  if (b.before.length) ctx.push(`Перед блоком (не переводить, только для связи):\n${b.before.join('\n')}`)
  if (b.after.length) ctx.push(`После блока (не переводить, только для связи):\n${b.after.join('\n')}`)
  return `${ctx.join('\n\n')}${ctx.length ? '\n\n' : ''}Переведи строки ${b.from}–${b.to}. Верни JSON с теми же номерами:

${JSON.stringify(b.lines, null, 1)}`
}

async function translateBatch(b, model, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const t0 = Date.now()
      const reply = await runClaude(buildPrompt(b), { system: SYSTEM, model, signal })
      console.log(`[перевод] строки ${b.from}-${b.to} за ${((Date.now() - t0) / 1000).toFixed(1)} с`)
      const obj = parseJsonReply(reply)
      const lines = {}
      for (let i = b.from; i <= b.to; i++) {
        const v = obj[String(i)]
        if (typeof v === 'string' && v.trim()) lines[i] = v.trim()
      }
      // Пустой ответ пробуем ещё раз: обычно это сорванный JSON, а не «нечего переводить».
      if (Object.keys(lines).length) return lines
    } catch (e) {
      if (e.code === 'ABORTED') throw e
      console.log(`[перевод] строки ${b.from}-${b.to}: ${e.message} (попытка ${attempt + 1})`)
      if (attempt) throw e
    }
  }
  return {}
}

export async function readCached(videoId) {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, `${videoId}.json`), 'utf8'))
  } catch {
    return null
  }
}

async function writeCache(videoId, lines) {
  await fs.mkdir(DIR, { recursive: true })
  await fs.writeFile(path.join(DIR, `${videoId}.json`), JSON.stringify(lines, null, 0), 'utf8')
}

/**
 * Переводит всё видео, отдавая пачки по готовности.
 * @param {string} videoId
 * @param {string[]} texts   реплики по порядку
 * @yields {{from:number, to:number, lines:Object, done:number, total:number}}
 */
export async function* translateVideo(videoId, texts, { model = 'sonnet', signal } = {}) {
  const cached = (await readCached(videoId)) || {}
  // Берём в работу только недопереведённые пачки: пачка с дыркой переводится заново целиком,
  // иначе дырка останется навсегда, а латать её по одной строке — без контекста и смысла.
  const missing = b => {
    for (let i = b.from; i <= b.to; i++) if (!cached[String(i)]) return true
    return false
  }
  const batches = makeBatches(texts).filter(missing)

  const all = { ...cached }
  let done = Object.keys(cached).length

  if (Object.keys(cached).length) {
    yield { from: 0, to: texts.length - 1, lines: cached, done, total: texts.length, cached: true }
  }
  if (!batches.length) return
  console.log(`[перевод] ${videoId}: ${batches.length} пачек, готово ${done}/${texts.length}`)

  // Пул воркеров: каждый в цикле берёт следующую пачку, готовое складывает в очередь,
  // генератор её разгребает. Так пачки доезжают до экрана сразу по готовности, и начало
  // видео читается, пока конец ещё считается.
  //
  // Сделано именно очередью, а не Promise.race по набору «в полёте»: там при одновременном
  // завершении двух пачек race возвращал одну, а вторая молча терялась вместе со своим
  // слотом. Пул усыхал до нуля, поток закрывался на середине и видео оставалось
  // недопереведённым — ровно это и ловилось на тесте (415 строк из 3402).
  const queue = []
  let next = 0, running = true, wake = null
  const push = r => { queue.push(r); const w = wake; wake = null; w?.() }

  const worker = async () => {
    while (next < batches.length && !signal?.aborted) {
      const b = batches[next++]
      try { push({ b, lines: await translateBatch(b, model, signal) }) }
      catch (e) { push({ b, lines: {}, error: e.message }) }
    }
  }
  Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker))
    .finally(() => { running = false; const w = wake; wake = null; w?.() })

  try {
    while (true) {
      if (queue.length) {
        const { b, lines, error } = queue.shift()
        Object.assign(all, lines)
        done += Object.keys(lines).length
        // Кэш пишем после каждой пачки: упади сервер посреди двухчасового подкаста,
        // при перезапуске перевод продолжится с этого места, а не с нуля.
        if (Object.keys(lines).length) await writeCache(videoId, all)
        yield { from: b.from, to: b.to, lines, done, total: texts.length, error }
        continue
      }
      if (!running || signal?.aborted) break
      // Между проверкой и ожиданием ничего асинхронного нет, пробуждение не теряется.
      await new Promise(res => { wake = res })
    }
  } finally {
    // Потребитель может бросить генератор на середине (break в for-await при обрыве
    // клиента) — код после цикла тогда не выполняется, поэтому финальная запись здесь.
    if (Object.keys(all).length) await writeCache(videoId, all)
  }
}

/** Разбор одного слова в контексте фразы — для карточки. */
export async function explainWord(word, context, { model = 'sonnet' } = {}) {
  const reply = await runClaude(
    `Слово: ${word}\nФраза из видео: ${context}\n\nВерни JSON: {"tr": "перевод именно в этом значении, 1–3 слова", "note": "одно короткое пояснение оттенка или типичного употребления"}`,
    {
      system: 'Ты помогаешь учить английский. Переводишь слово в том значении, в котором оно ' +
        'употреблено во фразе, а не первым словарным. Отвечаешь только JSON-объектом.',
      model,
      timeoutMs: 90_000,
    })
  const obj = parseJsonReply(reply)
  return { tr: String(obj.tr || '').trim(), note: String(obj.note || '').trim() }
}
