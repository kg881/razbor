/**
 * Запуск Claude как переводчика — через локальный CLI, а не через HTTP-API.
 *
 * Почему так: ключа Anthropic у нас нет и заводить его не надо. `claude -p` уже
 * авторизован подпиской пользователя, поэтому перевод делает та же модель, что и
 * в диалоге, без единого секрета в конфиге.
 *
 * Три флага здесь не косметические:
 *   cwd = os.tmpdir()        — иначе подхватится CLAUDE.md проекта и в каждый
 *                              запрос уедет посторонний контекст.
 *   --no-session-persistence — переводов сотни, незачем плодить транскрипты.
 *   --strict-mcp-config      — MCP-серверы переводчику не нужны, а стартуют долго.
 *   --tools ""               — обязателен. С доступными инструментами модель на длинной
 *                              пачке лезет в них вместо ответа, упирается в --max-turns
 *                              и падает с кодом 1 (stop_reason: tool_use). На замере так
 *                              срывалась каждая третья пачка; заодно из запроса уходят
 *                              ~14k токенов описаний инструментов.
 */
import { spawn } from 'node:child_process'
import os from 'node:os'

const BIN = process.env.CLAUDE_BIN || 'claude'

export class ClaudeError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/**
 * @param {string} prompt   что перевести
 * @param {{system?: string, model?: string, timeoutMs?: number}} opts
 * @returns {Promise<string>} текст ответа
 */
export function runClaude(prompt, { system, model = 'sonnet', timeoutMs = 240_000, signal } = {}) {
  const args = [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--max-turns', '1',
    '--tools', '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
  ]
  if (system) args.push('--system-prompt', system)

  return new Promise((resolve, reject) => {
    const proc = spawn(BIN, args, {
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    })

    let out = '', err = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new ClaudeError(`Переводчик не ответил за ${timeoutMs / 1000} с.`, 'TIMEOUT'))
    }, timeoutMs)

    // Без этого закрытая вкладка оставляет процессы доживать: они держат CPU и мешают
    // следующему запуску — на тесте так накопилось вдвое больше процессов, чем разрешено.
    const onAbort = () => {
      proc.kill('SIGKILL')
      clearTimeout(timer)
      reject(new ClaudeError('Перевод отменён.', 'ABORTED'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    proc.stdout.on('data', d => (out += d))
    proc.stderr.on('data', d => (err += d))
    proc.on('error', e => {
      cleanup()
      reject(new ClaudeError(
        e.code === 'ENOENT' ? 'Не найден claude CLI. Проверь PATH или CLAUDE_BIN.' : e.message,
        'SPAWN_FAILED'))
    })
    proc.on('close', code => {
      cleanup()
      if (signal?.aborted) return
      if (code !== 0) {
        // Ошибку CLI кладёт в stdout (JSON), а не в stderr — без него в логе пустота.
        return reject(new ClaudeError(
          `claude вышел с кодом ${code}. ${(err + ' ' + out).trim().slice(0, 400)}`, 'EXIT'))
      }
      try {
        const parsed = JSON.parse(out)
        if (parsed.is_error) throw new Error(parsed.result || 'ошибка выполнения')
        resolve(String(parsed.result ?? ''))
      } catch (e) {
        reject(new ClaudeError(`Не разобрал ответ claude: ${e.message}`, 'BAD_OUTPUT'))
      }
    })

    proc.stdin.end(prompt)
  })
}

/**
 * Ответ модели → объект.
 *
 * Наивное «от первой { до последней }» ломается на реальных ответах: модель то заворачивает
 * JSON в ```-забор, то дописывает после него реплику вроде «погоди, исправлю опечатку» и
 * выдаёт второй объект. Поэтому вырезаем ВСЕ сбалансированные объекты верхнего уровня и
 * берём самый содержательный из поздних — исправленный вариант идёт последним.
 */
export function parseJsonReply(text) {
  const found = []
  let depth = 0, start = -1, inStr = false, esc = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') { if (depth++ === 0) start = i }
    else if (ch === '}' && depth && --depth === 0) {
      try {
        const obj = JSON.parse(text.slice(start, i + 1))
        if (obj && typeof obj === 'object') found.push(obj)
      } catch { /* оборванный кусок — просто пропускаем */ }
    }
  }

  if (!found.length) throw new Error('в ответе нет JSON-объекта')
  // Из нескольких кандидатов — последний с максимумом ключей: это либо единственный ответ,
  // либо самоисправление модели, которое всегда идёт после первой попытки.
  return found.reduce((best, o) =>
    Object.keys(o).length >= Object.keys(best).length ? o : best)
}

/** Есть ли вообще чем переводить — проверяем один раз на старте сервера. */
export async function claudeAvailable() {
  try {
    await new Promise((res, rej) => {
      const p = spawn(BIN, ['--version'], { stdio: 'ignore' })
      p.on('error', rej)
      p.on('close', c => (c === 0 ? res() : rej(new Error(String(c)))))
    })
    return true
  } catch {
    return false
  }
}
