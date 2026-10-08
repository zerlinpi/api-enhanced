'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer, hashPassword, verifyPassword } = require('./server')

function fakeStore() {
  const users = new Map(), sessions = new Map(), profiles = new Map(), songs = new Map(), visits = new Set(), tokens = new Map()
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
