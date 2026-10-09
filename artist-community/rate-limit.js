'use strict'
const crypto = require('node:crypto')
const DEFAULT_WINDOW_MS = 15 * 60 * 1000

function validateLimit(limit, windowMs) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new TypeError('Invalid rate limit configuration')
  }
}
function redisKey(key) {
  // Never store raw account identifiers or IP addresses as Redis keys.
  return 'artist-community:limit:v1:' + crypto.createHash('sha256').update(key).digest('hex')
}
function createMemoryRateLimiter({ now = Date.now, maxKeys = 10000 } = {}) {
  const attempts = new Map()
  return {
    async check(key, limit, windowMs = DEFAULT_WINDOW_MS) {
      validateLimit(limit, windowMs)
      const at = now()
      let entry = attempts.get(key)
      if (!entry || entry.until <= at) {
        if (!entry && attempts.size >= maxKeys) {
          for (const [k, v] of attempts) if (v.until <= at) attempts.delete(k)
          if (attempts.size >= maxKeys) return false
        }
        entry = { count: 0, until: at + windowMs }
        attempts.set(key, entry)
      }
      entry.count++
      return entry.count <= limit
    },
    async ready() { return true },
    async close() {},
  }
}

const WINDOW_SCRIPT = [
  "local n = redis.call('INCR', KEYS[1])",
  "if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
  "return n",
].join('\n')

async function createRedisRateLimiter(redisUrl, { client: suppliedClient } = {}) {
  if (!suppliedClient && (!redisUrl || !/^rediss?:\/\//.test(redisUrl))) {
    throw new Error('A valid REDIS_URL is required for distributed rate limiting')
  }
  const client = suppliedClient || require('redis').createClient({
    url: redisUrl,
    socket: { connectTimeout: 3000, reconnectStrategy: retries => Math.min(100 * (retries + 1), 3000) },
  })
  if (!suppliedClient) {
    // Do not include the Redis URL in logs (it can contain credentials).
    client.on('error', () => {})
    await client.connect()
  }
  return {
    async check(key, limit, windowMs = DEFAULT_WINDOW_MS) {
      validateLimit(limit, windowMs)
      const used = await client.eval(WINDOW_SCRIPT, {
        keys: [redisKey(key)],
        arguments: [String(windowMs)],
      })
      return Number(used) <= limit
    },
    async ready() {
      try { return await client.ping() === 'PONG' } catch { return false }
    },
    async close() {
      if (suppliedClient) return
      try { await client.quit() } catch { client.destroy() }
    },
  }
}
module.exports = { createMemoryRateLimiter, createRedisRateLimiter, DEFAULT_WINDOW_MS }
