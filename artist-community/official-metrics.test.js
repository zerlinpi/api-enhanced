'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createUnavailableMetricsProvider } = require('./official-metrics')

test('unconnected NetEase metrics are never represented as actual play counts', async () => {
  const provider = createUnavailableMetricsProvider()
  const result = await provider.getMetrics({ userId: 'test-user', profile: null })
  assert.equal(result.source, 'not_connected')
  assert.equal(result.authorized, false)
  assert.equal(result.officialValidPlays, null)
  assert.equal(result.officialTaskStatus, 'unavailable')
})
