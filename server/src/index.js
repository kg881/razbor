/**
 * Бэкенд «Разбора».
 *
 * Отвечает за то, что нельзя делать в браузере:
 *   - перевод слова и фразы с учётом контекста (ключи провайдера живут только здесь),
 *   - нормализация json3 в чистые реплики с пословным таймингом,
 *   - общий кэш переводов: второй ученик на том же видео обходится бесплатно.
 *
 * Чего здесь СОЗНАТЕЛЬНО нет: загрузки субтитров с YouTube. Правила YouTube
 * запрещают серверный скрейпинг, а датацентровые IP всё равно блокируются.
 * Субтитры приносит клиент (расширение) из сессии пользователя — см. POST /api/cues.
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { normalizeJson3 } from './subtitles.js'
import { translateBatch } from './translate.js'
import { LruTtlCache } from './cache.js'

const app = new Hono()
app.use('/api/*', cors())

// Кэш переводов общий для всех пользователей: ключ = слово + языковая пара + контекст.
// TTL 30 дней — то же ограничение, что правила YouTube ставят на кэш их данных.
const translations = new LruTtlCache({ max: 50_000, ttlMs: 30 * 864e5 })

app.get('/api/health', c => c.json({ ok: true, cached: translations.size }))

/**
 * json3 (как его отдаёт клиент) → чистые реплики.
 * Схлопывает roll-up-дубликаты ASR и раскрывает пословный тайминг.
 */
app.post('/api/cues', async c => {
  const body = await c.req.json().catch(() => null)
  if (!body?.events) {
    return c.json({ error: 'Ожидается json3: объект с полем events.' }, 400)
  }
  const cues = normalizeJson3(body)
  return c.json({ cues, count: cues.length })
})

/**
 * Перевод пачкой. Клиент шлёт список слов и фразу-контекст,
 * получает переводы с учётом того, как слово употреблено.
 */
app.post('/api/translate', async c => {
  const { words, context, from = 'en', to = 'ru' } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(words) || !words.length) {
    return c.json({ error: 'Ожидается words: непустой массив слов.' }, 400)
  }

  const pair = `${from}:${to}`
  const ctxKey = (context || '').slice(0, 120)
  const out = {}
  const missing = []

  for (const w of words) {
    const key = `${pair}|${w.toLowerCase()}|${ctxKey}`
    const hit = translations.get(key)
    // Именно undefined: пустая строка — это валидный ответ «перевода нет»,
    // и его тоже надо кэшировать, иначе провайдер дёргается на каждом запросе.
    if (hit !== undefined) out[w] = hit
    else missing.push(w)
  }

  if (missing.length) {
    const fresh = await translateBatch(missing, { context, from, to })
    for (const [w, tr] of Object.entries(fresh)) {
      translations.set(`${pair}|${w.toLowerCase()}|${ctxKey}`, tr)
      out[w] = tr
    }
  }

  return c.json({ translations: out, fromCache: words.length - missing.length })
})

const port = Number(process.env.PORT || 8788)
serve({ fetch: app.fetch, port })
console.log(`Бэкенд «Разбора» слушает http://localhost:${port}`)
