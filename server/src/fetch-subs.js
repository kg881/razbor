/**
 * Получение субтитров произвольного видео по ссылке.
 *
 * Зачем отдельный модуль: пользователь должен просто вставить ссылку — без входа
 * в аккаунт и без расширения. В браузере это невозможно (youtube.com/api/timedtext
 * не отдаёт CORS-заголовки, поэтому fetch с чужого домена блокируется), значит
 * запрос делает наша сторона.
 *
 * Проверено эмпирически 2026-08-15:
 *   - голый timedtext              → HTTP 200 и ПУСТОЕ тело;
 *   - InnerTube клиент ANDROID     → HTTP 400 failedPrecondition;
 *   - yt-dlp                       → работает.
 * Поэтому опираемся на yt-dlp: он поддерживает обходы в актуальном состоянии,
 * чинить их самим — гонка, которую не выиграть.
 *
 * ВАЖНО про IP: YouTube блокирует датацентровые адреса (AWS/GCP/Azure). Этот
 * сервис рассчитан на запуск рядом с пользователем (его резидентский IP), а не
 * на облачный хостинг. Ограничение архитектурное, а не временное.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeJson3 } from './subtitles.js'

const execFileAsync = promisify(execFile)

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp'

/** Достаёт videoId из любой формы ссылки YouTube. */
export function parseVideoId(input) {
  if (!input) return null
  const s = String(input).trim()
  if (/^[\w-]{11}$/.test(s)) return s
  const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/)
  return m ? m[1] : null
}

/**
 * Скачивает дорожку субтитров и возвращает нормализованные реплики.
 *
 * lang: 'en-orig' — оригинальная ASR-дорожка с ПОСЛОВНЫМ таймингом.
 * Именно она даёт караоке-подсветку; переведённые дорожки (en, ru-en) пословного
 * тайминга не имеют. Запрашиваем строго одну: '--sub-langs en.*' тянет полсотни
 * языков разом и ловит HTTP 429.
 */
export async function fetchCues(videoId, { lang = 'en-orig', timeoutMs = 180_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'razbor-'))
  try {
    // Таймаут щедрый намеренно: под троттлингом YouTube та же дорожка качается
    // не 3 секунды, а до двух минут. Замерено — файл приходит целиком, просто медленно.
    // --write-subs НЕ добавляем: нужна автодорожка (только у неё пословный тайминг),
    // а лишний флаг тянет дополнительные запросы и приближает 429.
    const args = [
      '--skip-download',
      '--write-auto-subs',
      '--sub-langs', lang,
      '--sub-format', 'json3',
      '--no-warnings', '--no-playlist',
      '-o', join(dir, 'sub.%(ext)s'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ]
    await execFileAsync(YTDLP, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })

    const files = (await readdir(dir)).filter(f => f.endsWith('.json3'))
    if (!files.length) {
      const err = new Error('У видео нет дорожки субтитров в запрошенном языке.')
      err.code = 'NO_SUBTITLES'
      throw err
    }

    const raw = JSON.parse(await readFile(join(dir, files[0]), 'utf8'))
    const cues = normalizeJson3(raw)
    const wordTimed = cues.some(c => c.words.length > 1)

    return { cues, track: files[0].replace(/^sub\./, '').replace(/\.json3$/, ''), wordTimed }
  } catch (e) {
    if (e.code === 'NO_SUBTITLES') throw e
    if (e.code === 'ENOENT') {
      const err = new Error('yt-dlp не найден. Установи: pip install -U yt-dlp, либо задай YTDLP_PATH.')
      err.code = 'NO_YTDLP'
      throw err
    }
    if (/429|Too Many Requests/i.test(e.stderr || e.message)) {
      const err = new Error('YouTube временно ограничил запросы (429). Подожди минуту.')
      err.code = 'RATE_LIMITED'
      throw err
    }
    if (/Sign in to confirm|bot/i.test(e.stderr || '')) {
      const err = new Error('YouTube требует подтверждения. Обычно помогает смена сети или свежий yt-dlp.')
      err.code = 'BOT_CHECK'
      throw err
    }
    const err = new Error('Не удалось получить субтитры для этого видео.')
    err.code = 'FETCH_FAILED'
    err.detail = String(e.stderr || e.message).slice(0, 300)
    throw err
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
