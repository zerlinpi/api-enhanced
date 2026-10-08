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
