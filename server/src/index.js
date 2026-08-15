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
import { translateVideo, readCached, explainWord } from './translate-video.js'
import { cutClip, readClip, clipName } from './clips.js'
import { claudeAvailable } from './claude.js'
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
 * Перевод всего видео. Переводит Claude через локальный CLI — ключи провайдера не нужны.
 *
 * Одно видео = одна задача, как бы клиент себя ни вёл. Первый запрос запускает перевод,
 * повторный (обновил страницу, вставил ссылку ещё раз) подключается к идущему, а не
 * запускает второй — на тесте два параллельных прогона одного подкаста съели все слоты
 * и молотили одни и те же пачки дважды. Обрыв клиента задачу не убивает: перевод доходит
 * до конца, ложится в кэш, и следующее открытие видео получает всё мгновенно.
 *
 * Отдаём потоком (NDJSON), а не одним ответом: у длинного подкаста под сотню пачек, и если
 * ждать последнюю, пользователь минуты смотрит в пустой экран.
 */
const jobs = new Map() // videoId -> { lines, done, total, listeners:Set }

function startJob(videoId, texts) {
  const existing = jobs.get(videoId)
  if (existing) return existing

  const job = { lines: {}, done: 0, total: texts.length, listeners: new Set(), finished: false }
  jobs.set(videoId, job)
  ;(async () => {
    try {
      for await (const chunk of translateVideo(videoId, texts)) {
        Object.assign(job.lines, chunk.lines)
        job.done = chunk.done
        for (const fn of job.listeners) fn(chunk)
      }
    } catch (e) {
      for (const fn of job.listeners) fn({ error: e.message })
    } finally {
      job.finished = true
      for (const fn of job.listeners) fn({ done: true, total: job.total })
      jobs.delete(videoId)
      console.log(`[перевод] ${videoId}: задача завершена, ${job.done}/${job.total}`)
    }
  })()
  return job
}

app.post('/api/translate-video', async c => {
  const { videoId, texts } = await c.req.json().catch(() => ({}))
  if (!videoId || !Array.isArray(texts) || !texts.length) {
    return c.json({ error: 'Ожидается videoId и непустой массив texts.' }, 400)
  }
  if (!(await claudeAvailable())) {
    return c.json({ error: 'Не найден claude CLI — переводить нечем.', code: 'NO_CLAUDE' }, 503)
  }

  const job = startJob(videoId, texts)

  return c.newResponse(
    new ReadableStream({
      start(ctrl) {
        const enc = new TextEncoder()
        const send = o => {
          try { ctrl.enqueue(enc.encode(JSON.stringify(o) + '\n')) }
          catch { unsub() } // клиент ушёл — просто отписываемся, задача живёт дальше
        }
        const listener = chunk => {
          send(chunk)
          if (chunk.done === true) { unsub(); try { ctrl.close() } catch { } }
        }
        const unsub = () => job.listeners.delete(listener)

        // Догоняющее сообщение: всё, что задача успела перевести до подключения клиента.
        if (Object.keys(job.lines).length) {
          send({ from: 0, to: job.total - 1, lines: job.lines, done: job.done, total: job.total, cached: true })
        }
        if (job.finished) { send({ done: true, total: job.total }); try { ctrl.close() } catch { }; return }
        job.listeners.add(listener)
      },
    }),
    200,
    { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' }
  )
})

/** Готовый перевод из кэша: повторное открытие видео не гоняет модель заново. */
app.get('/api/translation/:videoId', async c => {
  const lines = await readCached(c.req.param('videoId'))
  return lines ? c.json({ lines, count: Object.keys(lines).length }) : c.json({ lines: {}, count: 0 })
})

/**
 * Вырезать клип фразы. Зовётся в момент сохранения карточки, чтобы к повторению
 * кусок уже лежал на диске (~9 с на вырезку). Повторный вызов с теми же границами
 * отвечает мгновенно готовым файлом.
 */
app.post('/api/clip', async c => {
  const { videoId, start, end } = await c.req.json().catch(() => ({}))
  if (!clipName(videoId || '', Number(start), Number(end))) {
    return c.json({ error: 'Ожидается videoId и границы start/end в секундах.' }, 400)
  }
  try {
    const name = await cutClip(videoId, Number(start), Number(end))
    return c.json({ url: `/api/clips/${name}`, name })
  } catch (e) {
    return c.json({ error: e.message, code: e.code }, e.code === 'BAD_RANGE' ? 400 : 502)
  }
})

/** Отдача готового клипа. Range обязателен: без него <video> в Safari молчит. */
app.get('/api/clips/:name', async c => {
  const res = await readClip(c.req.param('name'), c.req.header('range'))
  if (!res) return c.json({ error: 'Клип не найден.' }, 404)
  if (res.unsatisfiable) {
    return c.newResponse(null, 416, { 'content-range': `bytes */${res.size}` })
  }
  const headers = {
    'content-type': 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': String(res.buf.length),
  }
  if (res.partial) {
    headers['content-range'] = `bytes ${res.start}-${res.end}/${res.size}`
    return c.newResponse(res.buf, 206, headers)
  }
  return c.newResponse(res.buf, 200, headers)
})

/** Разбор слова в контексте фразы — для карточки. */
app.post('/api/word', async c => {
  const { word, context } = await c.req.json().catch(() => ({}))
  if (!word) return c.json({ error: 'Ожидается word.' }, 400)

  const key = `word|${word.toLowerCase()}|${(context || '').slice(0, 120)}`
  const hit = translations.get(key)
  if (hit !== undefined) return c.json({ ...hit, fromCache: true })

  try {
    const res = await explainWord(word, context || word)
    translations.set(key, res)
    return c.json({ ...res, fromCache: false })
  } catch (e) {
    return c.json({ error: e.message }, 502)
  }
})

const port = Number(process.env.PORT || 8788)
serve({ fetch: app.fetch, port })
console.log(`Бэкенд «Разбора» слушает http://localhost:${port}`)
