/**
 * Получение ПОДПИСАННОЙ ссылки на дорожку субтитров.
 *
 * Это ядро правильного разделения труда, и оно строится на трёх замерах (15.08.2026):
 *
 *  1. Ссылка, взятая с watch-страницы (клиент WEB), содержит флаг `exp=xpe` и отдаёт
 *     HTTP 200 с ПУСТЫМ телом. Флаг покрыт подписью, вырезать его нельзя — будет 404.
 *  2. Та же ссылка, взятая через InnerTube с клиентом ANDROID, флага не содержит
 *     и отдаёт субтитры целиком. Важно: `clientVersion` должен быть свежим —
 *     на устаревшем прилетает 400 FAILED_PRECONDITION.
 *  3. Сама подписанная ссылка ОТДАЁТ CORS-заголовки (`access-control-allow-origin`
 *     отражает любой Origin) и НЕ привязана к IP (`ip=0.0.0.0`), живёт около 7 часов.
 *
 * Отсюда архитектура: сервер делает ОДИН дешёвый запрос за ссылкой, а тяжёлую
 * загрузку самих субтитров делает клиент со своего адреса. Лимиты YouTube размазываются
 * по домашним адресам пользователей вместо одного серверного, и расширение не нужно.
 */

// Держать свежим: на устаревшей версии InnerTube отвечает 400 FAILED_PRECONDITION.
const ANDROID_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '21.02.35',
  androidSdkVersion: 30,
  hl: 'en',
}

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player'

/**
 * @returns {{videoId: string, title: string, tracks: Array<{lang,kind,name,url}>}}
 */
export async function getTracks(videoId) {
  const res = await fetch(PLAYER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `com.google.android.youtube/${ANDROID_CLIENT.clientVersion} (Linux; U; Android 11) gzip`,
    },
    body: JSON.stringify({ videoId, context: { client: ANDROID_CLIENT } }),
  })

  if (!res.ok) {
    const err = new Error(
      res.status === 400
        ? 'YouTube отклонил запрос. Скорее всего устарела версия клиента в ANDROID_CLIENT.'
        : `YouTube ответил ${res.status}.`
    )
    err.code = res.status === 400 ? 'STALE_CLIENT' : 'PLAYER_FAILED'
    throw err
  }

  const data = await res.json()
  const status = data?.playabilityStatus?.status
  if (status && status !== 'OK') {
    const err = new Error(
      status === 'LOGIN_REQUIRED'
        ? 'YouTube требует подтверждения (бот-стена). Помогает пауза или смена сети.'
        : `Видео недоступно: ${data?.playabilityStatus?.reason || status}`
    )
    err.code = status === 'LOGIN_REQUIRED' ? 'BOT_WALL' : 'UNPLAYABLE'
    throw err
  }

  const raw = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || []
  if (!raw.length) {
    const err = new Error('У этого видео нет субтитров.')
    err.code = 'NO_SUBTITLES'
    throw err
  }

  const tracks = raw.map(t => ({
    lang: t.languageCode,
    kind: t.kind || 'manual',            // 'asr' = автоматические, только у них пословный тайминг
    name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
    url: withJson3(t.baseUrl),
  }))

  return {
    videoId,
    title: data?.videoDetails?.title || '',
    tracks,
  }
}

/** json3 — единственный формат, где есть пословный тайминг (tOffsetMs). */
function withJson3(url) {
  const u = new URL(url)
  u.searchParams.set('fmt', 'json3')
  // tlang НЕ добавляем: автоперевод дорожки первым ловит 429. Переводим у себя.
  u.searchParams.delete('tlang')
  return u.toString()
}

/**
 * Выбор дорожки: приоритет у автоматической (asr) на нужном языке — только она
 * несёт пословный тайминг, без которого нет караоке-подсветки.
 */
export function pickTrack(tracks, lang = 'en') {
  const sameLang = tracks.filter(t => t.lang.startsWith(lang))
  return (
    sameLang.find(t => t.kind === 'asr') ||
    sameLang[0] ||
    tracks.find(t => t.kind === 'asr') ||
    tracks[0]
  )
}
