'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer, hashPassword, verifyPassword } = require('./server')

function fakeStore() {
  const users = new Map(), sessions = new Map(), profiles = new Map(), songs = new Map(), visits = new Set(), tokens = new Map(), reports = new Map()
  return {
    async createUser(u) { if (users.has(u.email)) { const e = Error(); e.code = '23505'; throw e } users.set(u.email, u); return u },
    async findUserByEmail(email) { return users.get(email) },
    async saveAuthToken(id, purpose, hash, expiresAt) { tokens.set(hash, { id, purpose, expiresAt }) },
    async consumeAuthToken(hash, purpose, passwordHash) {
      const token = tokens.get(hash)
      if (!token || token.purpose !== purpose || token.expiresAt < new Date()) return false
      tokens.delete(hash)
      const user = [...users.values()].find(u => u.id === token.id)
      if (purpose === 'email_verification') user.emailVerifiedAt = new Date()
      if (purpose === 'password_reset') {
        user.passwordHash = passwordHash
        for (const [key, id] of sessions) if (id === user.id) sessions.delete(key)
      }
      return true
    },
    async ready() { return true },
    async addAudit() {},
    async submitSongReport(report) {
      const song = songs.get(report.songId)
      if (!song || song.status !== 'approved' || song.ownerId === report.reporterId ||
          [...reports.values()].some(r => r.songId === report.songId && r.reporterId === report.reporterId)) return null
      const entry = { ...report, status: 'pending', title: song.title, artist: song.artist, url: song.url, songStatus: song.status }
      reports.set(report.id, entry)
      return { id: report.id, songId: report.songId, reason: report.reason, status: 'pending' }
    },
    async listPendingReports() {
      return [...reports.values()].filter(report => report.status === 'pending').map(report => ({
        ...report, songStatus: songs.get(report.songId)?.status || null,
      }))
    },
    async listHiddenSongs() { return [...songs.values()].filter(song => song.status === 'hidden') },
    async moderateSong(id, action) {
      const song = songs.get(id)
      if (action === 'hide' && song?.status === 'approved') {
        song.status = 'hidden'
        for (const report of reports.values()) if (report.songId === id && report.status === 'pending') report.status = 'resolved'
      } else if (action === 'restore' && song?.status === 'hidden' &&
          profiles.get(song.ownerId)?.status === 'verified') {
        song.status = 'approved'
      } else return null
      return { id, status: song.status }
    },
    async dismissReport(id) {
      const report = reports.get(id)
      if (!report || report.status !== 'pending') return null
      report.status = 'dismissed'
      return { id, status: 'dismissed' }
    },

    async exportAccount(id) {
      const u = [...users.values()].find(user => user.id === id)
      if (!u) return null
      return {
        version: 1, account: { id: u.id, email: u.email },
        artistProfile: profiles.get(id) || null,
        submittedSongs: [...songs.values()].filter(song => song.ownerId === id),
        visitedSongs: [...visits].filter(entry => entry.endsWith(':' + id)).map(entry => ({ songId: entry.split(':')[0] })),
      }
    },
    async revokeAllSessions(id) { for (const [hash, value] of sessions) if (value === id) sessions.delete(hash) },
    async deleteAccount(id) {
      const u = [...users.values()].find(user => user.id === id)
      if (!u) return false
      users.delete(u.email)
      await this.revokeAllSessions(id)
      profiles.delete(id)
      for (const [songId, song] of songs) if (song.ownerId === id) songs.delete(songId)
      for (const key of visits) if (key.endsWith(':' + id) || !songs.has(key.split(':')[0])) visits.delete(key)
      for (const [hash, token] of tokens) if (token.id === id) tokens.delete(hash)
      return true
    },
    async createSession(token, id) { sessions.set(token, id) },
    async findSession(token) { return [...users.values()].find(u => u.id === sessions.get(token)) },
    async deleteSession(token) { sessions.delete(token) },
    async createProfile(id, profile) { const p = { ...profile, userId: id, status: 'pending' }; profiles.set(id, p); return p },
    async getProfile(id) { return profiles.get(id) },
    async createSong(s) { const song = { ...s, status: 'pending' }; songs.set(s.id, song); return song },
    async recommendSongs(id) { return (await this.listSongs()).filter(s => s.ownerId !== id && !visits.has(s.id + ':' + id)) },
    async listMySongs(id) { return [...songs.values()].filter(s => s.ownerId === id) },
    async listSongs() { return [...songs.values()].filter(s => s.status === 'approved').map(s => ({ ...s, communityVisitors: [...visits].filter(v => v.startsWith(s.id + ':')).length })) },
    async recordVisit(id, user) {
      const s = songs.get(id)
      if (!s || s.status !== 'approved' || s.ownerId === user) return null
      const key = id + ':' + user
      if (visits.has(key)) return false
      visits.add(key); return true
    },
    async reviewQueue() { return { profiles: [...profiles.values()].filter(p => p.status === 'pending'), songs: [...songs.values()].filter(s => s.status === 'pending') } },
    async approveProfile(id) { const p = profiles.get(id); if (!p) return null; p.status = 'verified'; return p },
    async approveSong(id) { const s = songs.get(id); if (!s || profiles.get(s.ownerId)?.status !== 'verified') return null; s.status = 'approved'; return s },
  }
}
test('scrypt hashes passwords', async () => {
  const digest = await hashPassword('a-long-password-123')
  assert.equal(await verifyPassword('a-long-password-123', digest), true)
  assert.equal(await verifyPassword('wrong-password', digest), false)
})
test('signup, login, approval, counted visits and logout', async t => {
  const adminToken = 'this-is-a-test-admin-token-with-enough-length'
  const sent = { verify: null, reset: null }
  const mailer = {
    async sendVerification(email, token) { sent.verify = token },
    async sendPasswordReset(email, token) { sent.reset = token },
  }
  const server = createServer({ store: fakeStore(), adminToken, mailer })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = 'http://127.0.0.1:' + server.address().port
  const post = (path, body = {}, cookie = '', token = '') => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Community-Request': '1', Cookie: cookie, Authorization: token ? 'Bearer ' + token : '' }, body: JSON.stringify(body),
  })
  const get = path => fetch(base + path)
  let r = await post('/api/songs', { title: 'No auth' })
  assert.equal(r.status, 401)
  r = await post('/api/auth/register', { email: 'Music@Example.com', password: 'very-long-password' })
  const owner = (await r.json()).user
  assert.equal(r.status, 201)
  assert.equal(typeof sent.verify, 'string')
  r = await post('/api/auth/verify-email', { token: sent.verify })
  assert.equal(r.status, 200)
  r = await post('/api/auth/verify-email', { token: sent.verify })
  assert.equal(r.status, 400, 'email token must only work once')
  r = await post('/api/auth/login', { email: 'music@example.com', password: 'very-long-password' })
  assert.equal(r.status, 200)
  const ownerCookie = r.headers.get('set-cookie').split(';')[0]
  assert.equal((await (await fetch(base + '/api/auth/me', { headers: { Cookie: ownerCookie } })).json()).user.emailVerified, true)
  const metrics = await fetch(base + '/api/official/metrics', { headers: { Cookie: ownerCookie } })
  assert.equal((await metrics.json()).officialTaskStatus, 'unavailable')
  assert.equal((await get('/admin')).status, 200)
  const health = await (await get('/api/health/ready')).json()
  assert.equal(health.ready, true)
  const providers = await (await get('/api/auth/providers')).json()
  assert.equal(providers.local.available, true)
  assert.equal(providers.netease.available, false, 'not yet authorized for external sign-in')
  r = await post('/api/profile', { artistName: 'Music', url: 'https://music.163.com/artist?id=123' }, ownerCookie)
  assert.ok((await r.json()).profile.proofCode.startsWith('DISCOVERY-'))
  r = await post('/api/songs', { title: 'Song', url: 'https://music.163.com/song?id=12345' }, ownerCookie)
  const song = (await r.json()).song
  assert.equal(song.officialValidPlays, null)
  assert.equal((await (await get('/api/songs')).json()).songs.length, 0)
  r = await post('/api/admin/songs/' + song.id + '/approve', {}, '', adminToken)
  assert.equal(r.status, 409)
  r = await post('/api/admin/profiles/' + owner.id + '/approve', {}, '', adminToken)
  assert.equal(r.status, 200)
  r = await post('/api/admin/songs/' + song.id + '/approve', {}, '', adminToken)
  assert.equal(r.status, 200)
  r = await post('/api/auth/register', { email: 'listener@example.com', password: 'very-long-password' })
  assert.equal(r.status, 201)
  r = await post('/api/auth/login', { email: 'listener@example.com', password: 'very-long-password' })
  const cookie = r.headers.get('set-cookie').split(';')[0]
  r = await post('/api/auth/forgot-password', { email: 'listener@example.com' })
  assert.equal(r.status, 200)
  assert.ok(sent.reset)
  r = await post('/api/auth/reset-password', { token: sent.reset, password: 'replaced-long-password' })
  assert.equal(r.status, 200)
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } }).then(x => x.json())).user, null)
  r = await post('/api/auth/reset-password', { token: sent.reset, password: 'another-long-password' })
  assert.equal(r.status, 400, 'reset token must be single-use')
  r = await post('/api/auth/login', { email: 'listener@example.com', password: 'replaced-long-password' })
  assert.equal(r.status, 200)
  const activeCookie = r.headers.get('set-cookie').split(';')[0]
  let feed = await fetch(base + '/api/recommendations', { headers: { Cookie: activeCookie } })
  assert.equal((await feed.json()).songs.length, 1)
  for (const expected of [true, false]) {
    const result = await post('/api/songs/' + song.id + '/visits', {}, activeCookie)
    assert.equal((await result.json()).recorded, expected)
  }
  feed = await fetch(base + '/api/recommendations', { headers: { Cookie: activeCookie } })
  assert.equal((await feed.json()).songs.length, 0, 'seen songs leave the personal feed')
  const listing = (await (await get('/api/songs')).json()).songs[0]
  assert.equal(listing.communityVisitors, 1)
  assert.equal(listing.officialValidPlays, null)
  assert.equal(listing.officialTaskStatus, 'unavailable')
  assert.equal((await post('/api/songs/' + song.id + '/visits', {}, ownerCookie)).status, 404)
  assert.equal((await post('/api/auth/logout', {}, ownerCookie)).status, 200)
  assert.equal((await fetch(base + '/api/profile', { headers: { Cookie: ownerCookie } })).status, 401)
})


test('trusted reverse proxy requests use independent client IP rate limits', async t => {
  const server = createServer({ store: fakeStore(), trustProxy: true })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = 'http://127.0.0.1:' + server.address().port + '/api/auth/login'
  const attempt = ip => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Community-Request': '1', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email: 'not-registered@example.com', password: 'long-test-password' }),
  })
  for (let i = 0; i < 10; i++) assert.equal((await attempt('198.51.100.11')).status, 401)
  assert.equal((await attempt('198.51.100.11')).status, 429)
  assert.equal((await attempt('198.51.100.12')).status, 401, 'one IP must not throttle other users')
})

test('untrusted X-Forwarded-For cannot evade limits when proxy mode is off', async t => {
  const server = createServer({ store: fakeStore(), trustProxy: false })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = 'http://127.0.0.1:' + server.address().port + '/api/auth/login'
  const attempt = ip => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Community-Request': '1', 'X-Forwarded-For': ip },
    body: JSON.stringify({ email: 'unknown@example.com', password: 'long-test-password' }),
  })
  for (let i = 0; i < 10; i++) assert.equal((await attempt('203.0.113.' + (i + 1))).status, 401)
  assert.equal((await attempt('203.0.113.99')).status, 429, 'spoofed headers cannot bypass direct mode')
})


test('account export, revoke all sessions and permanent deletion are private', async t => {
  const sent = {}
  const store = fakeStore()
  const adminToken = 'unit-test-admin-secret-must-be-at-least-32-characters'
  const server = createServer({ store, adminToken, mailer: {
    async sendVerification(email, token) { sent[email] = token },
    async sendPasswordReset() {},
  } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = 'http://127.0.0.1:' + server.address().port
  const post = (route, body = {}, cookie = '', admin = false) => fetch(base + route, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Community-Request': '1',
      Cookie: cookie, ...(admin ? { Authorization: 'Bearer ' + adminToken } : {}),
    }, body: JSON.stringify(body),
  })
  const get = (route, cookie = '') => fetch(base + route, { headers: { Cookie: cookie } })
  const password = 'a-secure-test-password-2026'
  let response = await get('/api/account/export')
  assert.equal(response.status, 401, 'anonymous export must be rejected')

  response = await post('/api/auth/register', { email: 'artist@example.com', password })
  assert.equal(response.status, 201)
  response = await post('/api/auth/verify-email', { token: sent['artist@example.com'] })
  assert.equal(response.status, 200)

  async function login(email, credential = password) {
    const r = await post('/api/auth/login', { email, password: credential })
    assert.equal(r.status, 200)
    return { cookie: r.headers.get('set-cookie').split(';')[0], user: (await r.json()).user }
  }
  const first = await login('artist@example.com')
  const second = await login('artist@example.com')

  response = await post('/api/profile', { artistName: 'Original Artist', url: 'https://music.163.com/artist?id=87262' }, first.cookie)
  assert.equal(response.status, 201)
  response = await post('/api/songs', { title: 'Original Song', url: 'https://music.163.com/song?id=76272' }, first.cookie)
  assert.equal(response.status, 201)
  const songId = (await response.json()).song.id
  assert.equal((await post('/api/admin/profiles/' + first.user.id + '/approve', {}, '', true)).status, 200)
  assert.equal((await post('/api/admin/songs/' + songId + '/approve', {}, '', true)).status, 200)

  assert.equal((await post('/api/auth/register', { email: 'listener@example.com', password })).status, 201)
  const listener = await login('listener@example.com')
  assert.equal((await post('/api/songs/' + songId + '/visits', {}, listener.cookie)).status, 200)

  response = await get('/api/account/export', first.cookie)
  assert.equal(response.status, 200)
  const exported = await response.json()
  assert.equal(exported.account.email, 'artist@example.com')
  assert.equal(exported.submittedSongs.length, 1)
  assert.equal(exported.artistProfile.artistId, '87262')
  assert.equal(exported.visitedSongs.length, 0)
  assert.equal(JSON.stringify(exported).includes('passwordHash'), false)
  assert.equal(JSON.stringify(exported).includes('ac_sid'), false)

  response = await get('/api/account/export', listener.cookie)
  const listenerExport = await response.json()
  assert.equal(listenerExport.account.email, 'listener@example.com')
  assert.equal(listenerExport.submittedSongs.length, 0)
  assert.equal(listenerExport.visitedSongs.length, 1)

  response = await post('/api/account/logout-all', { password: 'wrong-long-password' }, first.cookie)
  assert.equal(response.status, 403)
  response = await post('/api/account/logout-all', { password }, first.cookie)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal((await (await get('/api/auth/me', first.cookie)).json()).user, null)
  assert.equal((await (await get('/api/auth/me', second.cookie)).json()).user, null)
  assert.equal((await (await get('/api/auth/me', listener.cookie)).json()).user.email, 'listener@example.com')

  const third = await login('artist@example.com')
  assert.equal((await post('/api/account/delete', { password, confirmation: 'delete' }, third.cookie)).status, 400)
  assert.equal((await post('/api/account/delete', { password: 'invalid-password', confirmation: 'DELETE' }, third.cookie)).status, 403)
  response = await post('/api/account/delete', { password, confirmation: 'DELETE' }, third.cookie)
  assert.equal(response.status, 200)
  assert.equal((await (await get('/api/auth/me', third.cookie)).json()).user, null)
  assert.equal((await (await get('/api/songs')).json()).songs.length, 0)
  response = await get('/api/account/export', listener.cookie)
  assert.equal((await response.json()).visitedSongs.length, 0)
  // A deleted user's unique email address is no longer reserved.
  assert.equal((await post('/api/auth/register', { email: 'artist@example.com', password })).status, 201)
})


test('verified listeners can report works; admins can dismiss, hide and restore', async t => {
  const adminToken = 'unit-test-admin-secret-at-least-thirty-two-characters'
  const verification = new Map()
  const server = createServer({ store: fakeStore(), adminToken, mailer: {
    async sendVerification(email, token) { verification.set(email, token) },
    async sendPasswordReset() {},
  } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = 'http://127.0.0.1:' + server.address().port
  const post = (url, body = {}, cookie = '', admin = false) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Community-Request': '1',
      Cookie: cookie, ...(admin ? { Authorization: 'Bearer ' + adminToken } : {}) },
    body: JSON.stringify(body),
  })
  const get = (url, cookie = '', admin = false) => fetch(base + url, {
    headers: { Cookie: cookie, ...(admin ? { Authorization: 'Bearer ' + adminToken } : {}) },
  })
  const password = 'secure-password-for-testing'
  async function member(email, verify = true) {
    assert.equal((await post('/api/auth/register', { email, password })).status, 201)
    if (verify) assert.equal((await post('/api/auth/verify-email', { token: verification.get(email) })).status, 200)
    const r = await post('/api/auth/login', { email, password })
    assert.equal(r.status, 200)
    return { cookie: r.headers.get('set-cookie').split(';')[0], id: (await r.json()).user.id }
  }
  const artist = await member('owner+moderation@example.com')
  const listener = await member('listener+moderation@example.com')
  const unverified = await member('unverified+moderation@example.com', false)
  assert.equal((await post('/api/profile', {
    artistName: 'Moderation Artist', url: 'https://music.163.com/artist?id=739293',
  }, artist.cookie)).status, 201)
  const create = await post('/api/songs', { title: 'Moderation Song', url: 'https://music.163.com/song?id=739291' }, artist.cookie)
  assert.equal(create.status, 201)
  const song = (await create.json()).song
  assert.equal((await post('/api/admin/profiles/' + artist.id + '/approve', {}, '', true)).status, 200)
  assert.equal((await post('/api/admin/songs/' + song.id + '/approve', {}, '', true)).status, 200)
  assert.equal((await post('/api/songs/' + song.id + '/reports', { reason: 'spam' })).status, 401)
  assert.equal((await post('/api/songs/' + song.id + '/reports', { reason: 'spam' }, unverified.cookie)).status, 403)
  assert.equal((await post('/api/songs/' + song.id + '/reports', { reason: 'spam' }, artist.cookie)).status, 409)
  assert.equal((await post('/api/songs/' + song.id + '/reports', { reason: 'invalid' }, listener.cookie)).status, 400)
  assert.equal((await post('/api/songs/' + song.id + '/reports', { reason: 'copyright', details: 'ownership concern' }, listener.cookie)).status, 201)
  assert.equal((await post('/api/songs/' + song.id + '/reports', { reason: 'copyright' }, listener.cookie)).status, 409)
  assert.equal((await get('/api/admin/reports')).status, 403, 'without a token admin area should be inaccessible')
  const adminReports = await get('/api/admin/reports', '', true)
  assert.equal(adminReports.status, 200)
  let queue = await adminReports.json()
  assert.equal(queue.reports.length, 1)
  assert.equal(queue.reports[0].details, 'ownership concern')
  assert.equal((await post('/api/admin/songs/' + song.id + '/hide', {}, listener.cookie)).status, 403)
  assert.equal((await post('/api/admin/songs/' + song.id + '/hide', {}, '', true)).status, 200)
  assert.equal((await (await get('/api/songs')).json()).songs.length, 0, 'hidden song must vanish from public listing')
  assert.equal((await (await get('/api/recommendations', listener.cookie)).json()).songs.length, 0, 'hidden song cannot be recommended')
  queue = await (await get('/api/admin/reports', '', true)).json()
  assert.equal(queue.reports.length, 0, 'reports are marked resolved on takedown')
  assert.equal(queue.hiddenSongs.length, 1)
  assert.equal((await post('/api/admin/songs/' + song.id + '/hide', {}, '', true)).status, 409)
  assert.equal((await post('/api/songs/' + song.id + '/visits', {}, listener.cookie)).status, 404)
  assert.equal((await post('/api/admin/songs/' + song.id + '/restore', {}, '', true)).status, 200)
  assert.equal((await (await get('/api/songs')).json()).songs.length, 1)
  assert.equal((await (await get('/api/recommendations', listener.cookie)).json()).songs.length, 1)
  assert.equal((await post('/api/admin/songs/' + song.id + '/restore', {}, '', true)).status, 409)
  // A second song exercises the independent report dismissal path.
  const another = await post('/api/songs', { title: 'Another', url: 'https://music.163.com/song?id=739292' }, artist.cookie)
  const otherId = (await another.json()).song.id
  assert.equal((await post('/api/admin/songs/' + otherId + '/approve', {}, '', true)).status, 200)
  const report = await post('/api/songs/' + otherId + '/reports', { reason: 'other' }, listener.cookie)
  const reportId = (await report.json()).report.id
  assert.equal((await post('/api/admin/reports/' + reportId + '/dismiss', {}, '', true)).status, 200)
  assert.equal((await post('/api/admin/reports/' + reportId + '/dismiss', {}, '', true)).status, 404)
  assert.equal((await (await get('/api/admin/reports', '', true)).json()).reports.length, 0)
})


test('verification email can be resent after login without a user reference error', async t => {
  const store = fakeStore()
  const emails = []
  const server = createServer({ store, mailer: {
    async sendVerification(email, token) { emails.push({ email, token }) },
    async sendPasswordReset() {},
  } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = 'http://127.0.0.1:' + server.address().port
  const post = (route, body = {}, cookie = '') => fetch(url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Community-Request': '1', Cookie: cookie },
    body: JSON.stringify(body),
  })
  assert.equal((await post('/api/auth/register', {
    email: 'resend@example.com', password: 'a-long-test-password',
  })).status, 201)
  assert.equal(emails.length, 1)
  const login = await post('/api/auth/login', {
    email: 'resend@example.com', password: 'a-long-test-password',
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await post('/api/auth/resend-verification', {}, cookie)).status, 200)
  assert.equal(emails.length, 2)
  assert.notEqual(emails[0].token, emails[1].token)
  assert.equal((await post('/api/auth/verify-email', { token: emails[0].token })).status, 400)
  assert.equal((await post('/api/auth/verify-email', { token: emails[1].token })).status, 200)
})

test('a failed Redis limiter fails closed and makes readiness unhealthy', async t => {
  const server = createServer({ store: fakeStore(), rateLimiter: {
    async check() { throw new Error('secret backend connection string') },
    async ready() { return false },
  } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = 'http://127.0.0.1:' + server.address().port
  const readiness = await fetch(base + '/api/health/ready')
  assert.equal(readiness.status, 503)
  assert.deepEqual(await readiness.json(), { ready: false })
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Community-Request': '1' },
    body: JSON.stringify({ email: 'guest@example.com', password: 'not-a-valid-password' }),
  })
  assert.equal(login.status, 503)
  const body = await login.json()
  assert.equal(body.error, '请求限制服务暂不可用')
  assert.doesNotMatch(JSON.stringify(body), /secret backend/)
})
