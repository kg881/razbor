/**
 * Вырезание видеофрагмента фразы — для карточек.
 *
 * Зачем: в колоде фразы из разных видео, и запускать двухчасовой подкаст ради одной
 * фразы нельзя. Поэтому в момент сохранения карточки отсюда вырезается сам кусок
 * видео (~5 с, 480p, ~250 КБ) и кладётся на диск; карточка играет его мгновенно
 * и без сети.
 *
 * Схема двухфазная, и каждая фаза выбрана по замеру (16.08.2026):
 *
 *  1. yt-dlp -g добывает прямые ссылки на медиа (сам InnerTube их больше не отдаёт:
 *     ANDROID шлёт adaptiveFormats без url и без cipher, web — только SABR-storyboard'ы).
 *     Ссылки живут часами — кэшируем на 4 часа, дальше клипы того же видео мгновенны.
 *  2. Режет НАШ ffmpeg, а не yt-dlp --download-sections: yt-dlp передаёт ffmpeg
 *     браузерный UA, а ссылки выписаны клиенту ANDROID_VR — googlevideo на таком
 *     мисматче отвечает 403 через раз (замер: 4 из 9 падали). С родным UA — 3 из 3.
 *
 * Пережимаем на границах (libx264), не -c copy: иначе клип начинается с ближайшего
 * кейфрейма — на 480p это до пары секунд мимо начала фразы.
 * Клип готовится при сохранении слова, не при повторении: вырезка стоит секунды.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const CLIPS_DIR = path.join(ROOT, 'data', 'clips')

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp'
// ffmpeg лежит симлинком в server/bin (статический бинарь imageio-ffmpeg, brew нет)
const FFMPEG = process.env.FFMPEG_PATH || path.resolve(ROOT, 'server', 'bin', 'ffmpeg')
// UA обязан совпадать с клиентом, которому выписаны ссылки, — иначе 403 (см. шапку)
const MEDIA_UA = 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip'
// deno нужен yt-dlp для решения JS-челленджей YouTube
const ENV = { ...process.env, PATH: `${process.env.HOME}/.deno/bin:${process.env.PATH}` }

const PAD_BEFORE = 0.25   // чуть воздуха до фразы…
const PAD_AFTER = 0.35    // …и после, иначе обрез по последнему слову режет слух

/** Имя файла — и есть ключ кэша. Времена в мс, чтобы не ловить плавающую точку. */
export function clipName(videoId, start, end) {
  if (!/^[\w-]{11}$/.test(videoId)) return null
  const s = Math.max(0, Math.round((start - PAD_BEFORE) * 1000))
  const e = Math.round((end + PAD_AFTER) * 1000)
  if (!(e > s) || e - s > 60_000) return null   // клип длиннее минуты — это уже не фраза
  return `${videoId}_${s}_${e}.mp4`
}

// Прямые ссылки на медиа: живут ~6 часов, кэшируем на 4 с запасом.
const mediaCache = new Map() // videoId -> {urls: [video, audio?], exp}

async function mediaUrls(videoId) {
  const hit = mediaCache.get(videoId)
  if (hit && hit.exp > Date.now()) return hit.urls

  const { stdout } = await execFileAsync(YTDLP, [
    '-g', '--no-playlist',
    '-f', 'bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480]',
    `https://youtu.be/${videoId}`,
  ], { timeout: 60_000, maxBuffer: 1024 * 1024, env: ENV })

  const urls = stdout.trim().split('\n').filter(Boolean)
  if (!urls.length) throw new Error('yt-dlp не вернул ссылок на медиа')
  mediaCache.set(videoId, { urls, exp: Date.now() + 4 * 3600e3 })
  return urls
}

// Одну и ту же фразу могут сохранить дважды подряд — вторая вырезка ждёт первую.
const inFlight = new Map()

/** @returns {Promise<string>} имя готового файла в CLIPS_DIR */
export async function cutClip(videoId, start, end) {
  const name = clipName(videoId, start, end)
  if (!name) {
    const err = new Error('Некорректные границы клипа.')
    err.code = 'BAD_RANGE'
    throw err
  }
  const file = path.join(CLIPS_DIR, name)
  if (await fs.access(file).then(() => true, () => false)) return name
  if (inFlight.has(name)) return inFlight.get(name)

  // Границы берём из имени файла — там они уже с паддингом и округлением
  const m = name.match(/_(\d+)_(\d+)\.mp4$/)
  const fromSec = Number(m[1]) / 1000
  const toSec = Number(m[2]) / 1000

  const job = (async () => {
    await fs.mkdir(CLIPS_DIR, { recursive: true })
    const tmp = file + '.part.mp4'
    try {
      // Даже с родным UA часть выданных ссылок отвечает 403 — зависит от edge-хоста
      // googlevideo. Лечится новой выдачей: сбрасываем кэш ссылок и пробуем ещё раз.
      for (let attempt = 0; ; attempt++) {
        try {
          const urls = await mediaUrls(videoId)
          // -ss/-to и -user_agent должны стоять ПЕРЕД каждым своим -i
          const inputs = urls.flatMap(u =>
            ['-user_agent', MEDIA_UA, '-ss', String(fromSec), '-to', String(toSec), '-i', u])
          const maps = urls.length === 2 ? ['-map', '0:v', '-map', '1:a'] : []
          await execFileAsync(FFMPEG, [
            '-y', '-loglevel', 'error',
            ...inputs, ...maps,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
            '-c:a', 'aac', '-b:a', '96k',
            '-movflags', '+faststart',
            tmp,
          ], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
          await fs.rename(tmp, file)
          console.log(`[клип] ${name} готов${attempt ? ` (попытка ${attempt + 1})` : ''}`)
          return name
        } catch (e) {
          await fs.rm(tmp, { force: true })
          const denied = /403|404|Forbidden/i.test(String(e.stderr || ''))
          if (denied) mediaCache.delete(videoId)
          if (denied && attempt < 2) continue
          if (e.code === 'ENOENT') {
            const err = new Error('Не найден yt-dlp или ffmpeg. Проверь YTDLP_PATH / FFMPEG_PATH.')
            err.code = 'NO_TOOLING'
            throw err
          }
          const errLines = String(e.stderr || '').split('\n').filter(l => /error/i.test(l))
          const reason = (errLines.join(' ') || String(e.stderr || e.message).slice(-300)).slice(0, 300)
          const err = new Error(`Не вырезался клип: ${reason}`)
          err.code = 'CUT_FAILED'
          throw err
        }
      }
    } finally {
      inFlight.delete(name)
    }
  })()
  inFlight.set(name, job)
  return job
}

/** Отдача клипа с поддержкой Range: без неё <video> в Safari не играет. */
export async function readClip(name, rangeHeader) {
  if (!/^[\w-]{11}_\d+_\d+\.mp4$/.test(name)) return null   // и защита от path traversal
  const file = path.join(CLIPS_DIR, name)
  const stat = await fs.stat(file).catch(() => null)
  if (!stat) return null

  const size = stat.size
  const m = rangeHeader?.match(/bytes=(\d*)-(\d*)/)
  let start = 0, end = size - 1, partial = false
  if (m && (m[1] || m[2])) {
    partial = true
    if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 }
    else { start = Math.max(0, size - Number(m[2])) }
    if (start > end || start >= size) return { unsatisfiable: true, size }
  }

  const fh = await fs.open(file, 'r')
  const buf = Buffer.alloc(end - start + 1)
  await fh.read(buf, 0, buf.length, start)
  await fh.close()
  return { buf, start, end, size, partial }
}
