/**
 * Перевод. Провайдер выбирается переменной окружения, ключи никогда не уходят на клиент.
 *
 *   TRANSLATE_PROVIDER=anthropic  ANTHROPIC_API_KEY=...   контекстный перевод (лучшее качество)
 *   TRANSLATE_PROVIDER=stub                               оффлайн-заглушка для разработки
 *
 * Контекст важен: «paper» в «writes a paper» это работа, а не бумага. Поэтому
 * фраза уходит в запрос целиком, а переводим пачкой — так дешевле и связнее.
 */
const PROVIDER = process.env.TRANSLATE_PROVIDER || 'stub'

export async function translateBatch(words, { context = '', from = 'en', to = 'ru' } = {}) {
  if (PROVIDER === 'anthropic') return viaAnthropic(words, context, from, to)
  return viaStub(words)
}

async function viaAnthropic(words, context, from, to) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY не задан')

  const prompt = [
    `Переведи слова с ${from} на ${to}. Это слова из фразы: "${context}".`,
    'Переводи КАЖДОЕ слово так, как оно употреблено именно в этой фразе.',
    'Ответь только JSON-объектом вида {"слово": "перевод"}, без пояснений.',
    '',
    `Слова: ${words.join(', ')}`,
  ].join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) throw new Error(`Переводчик ответил ${res.status}`)
  const data = await res.json()
  const text = data.content?.[0]?.text ?? '{}'
  try {
    return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}')
  } catch {
    return {}
  }
}

/** Заглушка: помечает слово как непереведённое, чтобы фронт показал честное состояние. */
function viaStub(words) {
  return Object.fromEntries(words.map(w => [w, '']))
}
