'use strict'
/**
 * Authorized integration boundary. No undocumented NetEase API is called.
 * A future adapter must be supplied only after formal access rights and
 * an official user authorization flow have been implemented and reviewed.
 */
function createUnavailableMetricsProvider() {
  return {
    async getMetrics() {
      return {
        source: 'not_connected',
        authorized: false,
        lastSyncedAt: null,
        officialValidPlays: null,
        officialTaskStatus: 'unavailable',
        reason: '尚未连接获得授权的网易云音乐人官方数据源',
      }
    },
  }
}
module.exports = { createUnavailableMetricsProvider }
