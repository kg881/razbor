/** LRU с TTL. Держит общий кэш переводов: одно и то же слово в одном контексте
 *  переводится один раз на всех пользователей. */
export class LruTtlCache {
  constructor({ max = 10_000, ttlMs = 864e5 } = {}) {
    this.max = max
    this.ttlMs = ttlMs
    this.map = new Map()
  }
  get size() { return this.map.size }

  get(key) {
    const e = this.map.get(key)
    if (!e) return undefined
    if (Date.now() > e.exp) { this.map.delete(key); return undefined }
    this.map.delete(key); this.map.set(key, e)   // освежаем позицию в LRU
    return e.val
  }

  set(key, val) {
    if (this.map.size >= this.max) {
      this.map.delete(this.map.keys().next().value)  // вытесняем самый старый
    }
    this.map.set(key, { val, exp: Date.now() + this.ttlMs })
  }
}
