/**
 * Бэкенд «Разбора».
 *
 * Разделение труда выбрано по замерам, а не по интуиции (15.08.2026):
 *
 *   /api/track  — сервер делает ОДИН дешёвый запрос и отдаёт подписанную ссылку
 *                 на дорожку. Качает субтитры сам клиент: ссылка отдаёт CORS-заголовки
 *                 и не привязана к IP. Лимиты YouTube размазываются по адресам
 *                 пользователей вместо одного серверного. Основной путь.
 *   /api/fetch  — сервер качает сам через yt-dlp. Медленно и упирается в общий IP,
 *                 держим как запасной путь.
 *   /api/cues   — нормализация уже добытого json3 (нужна расширению и мобильному клиенту).
 *   /api/translate — перевод: ключи провайдера не должны попадать на клиент.
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { normalizeJson3 } from './subtitles.js'
import { fetchCues, parseVideoId } from './fetch-subs.js'
import { getTracks, pickTrack } from './track.js'
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

// Реплики кэшируем на 30 дней: повторное открытие того же видео не дёргает YouTube.
const cueCache = new LruTtlCache({ max: 500, ttlMs: 30 * 864e5 })

// Подписанные ссылки живут ~7 часов — кэшируем на 6, с запасом.
const trackCache = new LruTtlCache({ max: 2000, ttlMs: 6 * 3600e3 })

/**
 * ОСНОВНОЙ путь: отдаём клиенту подписанную ссылку на дорожку, а качает он сам.
 *
 * Сервер делает один дешёвый запрос, тяжёлую загрузку берёт на себя браузер или
 * телефон пользователя — ссылка отдаёт CORS-заголовки и не привязана к IP.
 * Так лимиты YouTube размазываются по адресам пользователей, а не бьют в один серверный.
 */
app.post('/api/track', async c => {
  const { url, lang = 'en' } = await c.req.json().catch(() => ({}))
  const videoId = parseVideoId(url)
  if (!videoId) return c.json({ error: 'Не похоже на ссылку YouTube.' }, 400)

  const cached = trackCache.get(videoId)
  if (cached) {
    return c.json({ ...cached, picked: pickTrack(cached.tracks, lang), fromCache: true })
  }

  try {
    const info = await getTracks(videoId)
    trackCache.set(videoId, info)
    return c.json({ ...info, picked: pickTrack(info.tracks, lang), fromCache: false })
  } catch (e) {
    const status = e.code === 'NO_SUBTITLES' ? 404 : e.code === 'BOT_WALL' ? 429 : 502
    return c.json({ error: e.message, code: e.code }, status)
  }
})

/**
 * ЗАПАСНОЙ путь: сервер сам качает субтитры через yt-dlp. Медленнее и упирается
 * в лимиты общего IP, зато переживает случаи, где основной путь не сработал.
 */
app.post('/api/fetch', async c => {
  const { url, lang = 'en-orig' } = await c.req.json().catch(() => ({}))
  const videoId = parseVideoId(url)
  if (!videoId) return c.json({ error: 'Не похоже на ссылку YouTube.' }, 400)

  const cached = cueCache.get(`${videoId}|${lang}`)
  if (cached) return c.json({ ...cached, videoId, fromCache: true })

  try {
    const result = await fetchCues(videoId, { lang })
    cueCache.set(`${videoId}|${lang}`, result)
    return c.json({ ...result, videoId, fromCache: false })
  } catch (e) {
    const status = e.code === 'RATE_LIMITED' ? 429 : e.code === 'NO_SUBTITLES' ? 404 : 502
    return c.json({ error: e.message, code: e.code }, status)
  }
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
