'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createMemoryRateLimiter, createRedisRateLimiter } = require('./rate-limit')

test('memory rate limits are bounded, expire, and isolate actions/users', async () => {
  let now = 1000
  const limiter = createMemoryRateLimiter({ now: () => now, maxKeys: 2 })
  assert.equal(await limiter.check('login:one', 2, 1000), true)
  assert.equal(await limiter.check('login:one', 2, 1000), true)
  assert.equal(await limiter.check('login:one', 2, 1000), false)
  assert.equal(await limiter.check('login:two', 1, 1000), true)
  assert.equal(await limiter.check('login:three', 1, 1000), false, 'at capacity, do not clear all keys')
  now += 1001
  assert.equal(await limiter.check('login:one', 2, 1000), true, 'old entries expire')
  assert.equal(await limiter.check('login:three', 1, 1000), true, 'expired entries are reclaimed')
  assert.equal(await limiter.ready(), true)
  await limiter.close()
})

test('Redis enforces atomic limits shared by concurrent Node instances', {
  skip: !process.env.REDIS_URL,
}, async t => {
  const first = await createRedisRateLimiter(process.env.REDIS_URL)
  const second = await createRedisRateLimiter(process.env.REDIS_URL)
  t.after(async () => { await Promise.all([first.close(), second.close()]) })
  assert.equal(await first.ready(), true)
  assert.equal(await second.ready(), true)
  const key = 'multi-instance-' + crypto.randomUUID()
  const requests = Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).check(key, 12, 1500))
  const decisions = await Promise.all(requests)
  assert.equal(decisions.filter(Boolean).length, 12, 'no parallel race may grant extra requests')
  assert.equal(decisions.filter(x => !x).length, 8)
  assert.equal(await first.check(key + ':other-user', 1, 1500), true)

  const expiringKey = 'expiration-' + crypto.randomUUID()
  assert.equal(await first.check(expiringKey, 1, 150), true)
  assert.equal(await second.check(expiringKey, 1, 150), false)
  await new Promise(resolve => setTimeout(resolve, 230))
  assert.equal(await second.check(expiringKey, 1, 150), true, 'limit must reset after window')
})
