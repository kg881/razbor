/**
 * Офлайн-пакет: видео целиком + автономная страница, чтобы смотреть и заниматься
 * на телефоне, когда компьютер закрыт.
 *
 * Пакет — папка data/offline/<videoId>/ с двумя файлами:
 *   <videoId>.mp4      видео 480p (для телефона за глаза, ~0.5 ГБ на 2 часа)
 *   razbor.html        автономная страница: реплики, перевод, уровни и караоке
 *                      зашиты внутрь, плеер — локальный <video>, сеть не нужна
 *
 * На телефон пакет уезжает AirDrop'ом (папку целиком) и открывается из приложения
 * с файлами, умеющего локальный HTML (Documents by Readdle и подобные).
 *
 * Качает родной загрузчик yt-dlp, обёрнутый в ретраи. Разбор 403 (18.08.2026):
 * ошибка «unable to download video data: HTTP Error 403» оказалась ПЛАВАЮЩЕЙ —
 * отдельные edge-хосты googlevideo отвечают 403 при живой подписи, и тот же
 * вызов через минуту качает 27 МБ за 4.5 с. Повторная экстракция получает другой
 * хост, поэтому лечение — ретрай с паузой, а не смена загрузчика: обходные схемы
 * (свой fetch с Range, ffmpeg по прямым ссылкам) утыкались либо в тот же 403,
 * либо в n-троттлинг до 35 КБ/с.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const OFFLINE_DIR = path.join(ROOT, 'data', 'offline')

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp'
const FFMPEG_DIR = process.env.FFMPEG_DIR || path.resolve(ROOT, 'server', 'bin')
// deno нужен yt-dlp для решения JS-челленджей YouTube
const ENV = { ...process.env, PATH: `${process.env.HOME}/.deno/bin:${process.env.PATH}` }

// videoId -> {state: 'downloading'|'building'|'ready'|'error', error?}
const jobs = new Map()

export function offlineStatus(videoId) {
  return jobs.get(videoId) || null
}

export async function offlineReady(videoId) {
  if (!/^[\w-]{11}$/.test(videoId)) return false
  const dir = path.join(OFFLINE_DIR, videoId)
  const okVideo = await fs.access(path.join(dir, `${videoId}.mp4`)).then(() => true, () => false)
  const okHtml = await fs.access(path.join(dir, 'razbor.html')).then(() => true, () => false)
  return okVideo && okHtml
}

/**
 * Скачивает видео и собирает пакет. Идемпотентно: готовый пакет не переделывается,
 * идущая закачка не задваивается.
 */
export async function buildOffline(videoId) {
  if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Некорректный videoId.')
  const running = jobs.get(videoId)
  if (running && (running.state === 'downloading' || running.state === 'building')) return
  // Страницу пересобираем ВСЕГДА, даже если пакет уже есть: перевод, оценки уровня
  // и снимок колоды с тех пор изменились. Пропускается только скачивание видео —
  // вот оно и правда долгое. Раньше готовый пакет выходил отсюда сразу и уезжал
  // на телефон с устаревшим содержимым.

  jobs.set(videoId, { state: 'downloading' })
  const dir = path.join(OFFLINE_DIR, videoId)
  const mp4 = path.join(dir, `${videoId}.mp4`)
  try {
    await fs.mkdir(dir, { recursive: true })
    if (!(await fs.access(mp4).then(() => true, () => false))) {
      for (let attempt = 0; ; attempt++) {
        try {
          await execFileAsync(YTDLP, [
            '-f', 'bv*[height<=480][ext=mp4]+ba[ext=m4a]/b[height<=480]',
            '--merge-output-format', 'mp4',
            '--ffmpeg-location', FFMPEG_DIR,
            '--no-progress', '--no-playlist', '-q',
            '-o', mp4,
            `https://youtu.be/${videoId}`,
          ], { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024, env: ENV })
          break
        } catch (e) {
          await fs.rm(mp4 + '.part', { force: true })
          const denied = /403|Forbidden/i.test(String(e.stderr || e.message))
          if (denied && attempt < 3) {
            console.log(`[офлайн] ${videoId}: 403 от edge-хоста, ретрай ${attempt + 1}`)
            await new Promise(r => setTimeout(r, 5000))
            continue
          }
          throw e
        }
      }
    }

    jobs.set(videoId, { state: 'building' })
    // Автономную страницу собирает тот же python, что и обычный build
    await execFileAsync('python3', [
      path.join(ROOT, 'tools', 'build_offline.py'), videoId,
    ], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })

    jobs.set(videoId, { state: 'ready' })
    console.log(`[офлайн] пакет ${videoId} готов`)
  } catch (e) {
    const reason = String(e.stderr || e.message).split('\n').filter(l => /error/i.test(l)).join(' ')
      || String(e.message).slice(0, 200)
    jobs.set(videoId, { state: 'error', error: reason.slice(0, 300) })
    console.log(`[офлайн] ${videoId} не собрался: ${reason.slice(0, 200)}`)
  }
}

/**
 * Отдача файлов пакета потоком, с Range: видео на полгига нельзя читать в память,
 * а без Range его не будет играть ни один мобильный браузер.
 */
export async function streamOffline(videoId, file, rangeHeader) {
  if (!/^[\w-]{11}$/.test(videoId) || !/^[\w.-]+$/.test(file) || file.includes('..')) return null
  const fp = path.join(OFFLINE_DIR, videoId, file)
  const stat = await fs.stat(fp).catch(() => null)
  if (!stat) return null

  const type = file.endsWith('.mp4') ? 'video/mp4' : 'text/html; charset=utf-8'
  const size = stat.size
  const m = rangeHeader?.match(/bytes=(\d*)-(\d*)/)
  let start = 0, end = size - 1, partial = false
  if (m && (m[1] || m[2])) {
    partial = true
    if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1 }
    else { start = Math.max(0, size - Number(m[2])) }
    if (start > end || start >= size) return { unsatisfiable: true, size }
  }

  return {
    stream: Readable.toWeb(createReadStream(fp, { start, end })),
    start, end, size, partial, type,
  }
}
