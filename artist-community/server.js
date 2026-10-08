'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { promisify } = require('node:util')
const { createPgStore } = require('./db')
const { createUnavailableMetricsProvider } = require('./official-metrics')

const scrypt = promisify(crypto.scrypt)
const PORT = Number(process.env.ARTIST_COMMUNITY_PORT || 3100)
const SESSION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_BODY = 16 * 1024
const SONG_RE = /^https:\/\/music\.163\.com\/(?:#\/)?song\?id=(\d{1,20})(?:[&#].*)?$/
const ARTIST_RE = /^https:\/\/music\.163\.com\/(?:#\/)?artist\?id=(\d{1,20})(?:[&#].*)?$/
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
function fail(status, message) { throw new HttpError(status, message) }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex') }
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = await scrypt(password, salt, 64)
  return salt + ':' + hash.toString('hex')
}
async function verifyPassword(password, stored) {
  const [salt, expected] = (stored || '').split(':')
  if (!/^[0-9a-f]{32}$/.test(salt || '') || !/^[0-9a-f]{128}$/.test(expected || '')) return false
  const actual = await scrypt(password, salt, 64)
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'))
}
function safeUser(user) { return { id: user.id, email: user.email, emailVerified: Boolean(user.emailVerifiedAt) } }
function publicSong(song) {
  return { ...song, officialValidPlays: null, officialTaskStatus: 'unavailable' }
}
async function bodyJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, '需要 JSON 请求')
  let size = 0
  const parts = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) fail(413, '请求内容过大')
    parts.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'))
    if (!value || Array.isArray(value) || typeof value !== 'object') fail(400, '请求内容必须为对象')
    return value
  } catch (error) {
    if (error instanceof HttpError) throw error
    fail(400, 'JSON 格式错误')
  }
}
function sessionCookie(token, maxAge = 604800) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return 'ac_sid=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secure
}
function readCookie(req) {
  const match = /(?:^|;\s*)ac_sid=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie || '')
  return match ? match[1] : null
}
function authAdmin(req, adminToken) {
  if (!adminToken || adminToken.length < 32) fail(503, '管理端尚未配置')
  const provided = String(req.headers.authorization || '').replace(/^Bearer /, '')
  const a = Buffer.from(tokenHash(provided), 'hex')
  const b = Buffer.from(tokenHash(adminToken), 'hex')
  if (!crypto.timingSafeEqual(a, b)) fail(403, '无管理权限')
}
function guardMutation(req) {
  if (req.headers['x-community-request'] !== '1') fail(403, '缺少站内请求标识')
  if (req.headers.origin) {
    let origin
    try { origin = new URL(req.headers.origin).host } catch { fail(403, '来源无效') }
    if (origin !== req.headers.host) fail(403, '禁止跨站请求')
  }
}
function createServer({ store, mailer, metricsProvider = createUnavailableMetricsProvider(), adminToken = process.env.ARTIST_COMMUNITY_ADMIN_TOKEN } = {}) {
  if (!store) throw new Error('store is required')
  const attempts = new Map()
  async function sendAccountToken(user, purpose) {
    if (!mailer) fail(503, '邮件服务尚未配置')
    const token = crypto.randomBytes(32).toString('hex')
    const duration = purpose === 'email_verification' ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000
    await store.saveAuthToken(user.id, purpose, tokenHash(token), new Date(Date.now() + duration))
    if (purpose === 'email_verification') await mailer.sendVerification(user.email, token)
    else await mailer.sendPasswordReset(user.email, token)
  }
  function validatedToken(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(400, '链接无效或已过期')
    return tokenHash(value)
  }
  function validatedPassword(password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) fail(400, '密码必须为 12–128 个字符')
    return password
  }
  function throttle(req, action, limit) {
    const key = (req.socket.remoteAddress || '-') + ':' + action
    const now = Date.now()
    const entry = attempts.get(key)
    const fresh = !entry || entry.until < now
    const state = fresh ? { count: 0, until: now + 15 * 60 * 1000 } : entry
    state.count++
    if (attempts.size > 10000) attempts.clear()
    attempts.set(key, state)
    if (state.count > limit) fail(429, '请求过于频繁，请稍后重试')
  }
  async function userFromRequest(req) {
    const token = readCookie(req)
    return token ? store.findSession(tokenHash(token)) : null
  }
  async function requireUser(req) {
    const user = await userFromRequest(req)
    if (!user) fail(401, '请先登录')
    return user
  }
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
    res.setHeader('Cache-Control', 'no-store')
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data))
    }
    if (req.method === 'GET' && route === '/admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(path.join(__dirname, 'admin.html')))
      return
    }
    if (req.method === 'GET' && route === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(fs.readFileSync(path.join(__dirname, 'index.html')))
      return
    }
    if (req.method === 'GET' && route === '/api/health') return reply(200, { ok: true })
    if (req.method === 'GET' && route === '/api/health/ready') {
      try {
        const ready = await store.ready()
        return reply(ready ? 200 : 503, { ready: Boolean(ready) })
      } catch { return reply(503, { ready: false }) }
    }
    if (req.method === 'GET' && route === '/api/auth/providers') {
      return reply(200, {
        local: { available: true },
        netease: {
          available: false,
          reason: '请先取得网易云官方第三方登录许可、应用凭证和正式接口文档',
        },
      })
    }
    if (req.method === 'GET' && route === '/api/auth/me') {
      const user = await userFromRequest(req)
      return reply(200, { user: user ? safeUser(user) : null })
    }
    if (req.method === 'GET' && route === '/api/songs') {
      const songs = await store.listSongs()
      return reply(200, { songs: songs.map(publicSong) })
    }
    if (req.method === 'GET' && route === '/api/official/metrics') {
      const user = await requireUser(req)
      return reply(200, await metricsProvider.getMetrics({ userId: user.id, profile: await store.getProfile(user.id) }))
    }
    if (req.method === 'GET' && route === '/api/recommendations') {
      const user = await requireUser(req)
      return reply(200, { songs: (await store.recommendSongs(user.id)).map(publicSong) })
    }
    if (req.method === 'GET' && route === '/api/profile') {
      const user = await requireUser(req)
      return reply(200, { profile: await store.getProfile(user.id) })
    }
    if (req.method === 'GET' && route === '/api/my/songs') {
      const user = await requireUser(req)
      return reply(200, { songs: (await store.listMySongs(user.id)).map(publicSong) })
    }
    if (req.method === 'GET' && route === '/api/admin/review') {
      authAdmin(req, adminToken)
      return reply(200, await store.reviewQueue())
    }
    if (req.method !== 'POST') fail(404, '接口不存在')
    guardMutation(req)
    if (route === '/api/auth/register') {
      throttle(req, 'register', 5)
      const input = await bodyJson(req)
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
      const password = input.password
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) fail(400, '邮箱地址无效')
      validatedPassword(password)
      if (!mailer) fail(503, '邮件服务尚未配置')
      const user = await store.createUser({ id: crypto.randomUUID(), email, passwordHash: await hashPassword(password) })
      await sendAccountToken(user, 'email_verification')
      return reply(201, { user: safeUser(user), message: '注册成功，请查收邮箱验证邮件后登录' })
    }
    if (route === '/api/auth/verify-email') {
      throttle(req, 'email-verification', 20)
      const input = await bodyJson(req)
      const ok = await store.consumeAuthToken(validatedToken(input.token), 'email_verification')
      if (!ok) fail(400, '验证链接无效或已过期')
      return reply(200, { ok: true, message: '邮箱验证成功' })
    }
    if (route === '/api/auth/resend-verification') {
      throttle(req, 'resend-verification', 3)
      const user = await requireUser(req)
      await bodyJson(req)
      if (!user.emailVerifiedAt) await sendAccountToken(user, 'email_verification')
      return reply(200, { ok: true, message: '如需验证，已发送新的验证邮件' })
    }
    if (route === '/api/auth/forgot-password') {
      throttle(req, 'forgot-password', 5)
      const input = await bodyJson(req)
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
      if (email.length > 254) fail(400, '邮箱格式无效')
      const user = await store.findUserByEmail(email)
      if (user) {
        try { await sendAccountToken(user, 'password_reset') }
        catch (error) { console.error('[artist-community] reset email delivery unavailable') }
      }
      return reply(200, { message: '如果邮箱已注册，密码重置链接会发送到对应邮箱' })
    }
    if (route === '/api/auth/reset-password') {
      throttle(req, 'reset-password', 10)
      const input = await bodyJson(req)
      const passwordHash = await hashPassword(validatedPassword(input.password))
      const ok = await store.consumeAuthToken(validatedToken(input.token), 'password_reset', passwordHash)
      if (!ok) fail(400, '重置链接无效或已过期')
      res.setHeader('Set-Cookie', sessionCookie('', 0))
      return reply(200, { ok: true, message: '密码已重置，请重新登录' })
    }
    if (route === '/api/auth/login') {
      throttle(req, 'login', 10)
      const input = await bodyJson(req)
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
      const password = input.password
      if (typeof password !== 'string' || password.length > 128 || email.length > 254) fail(401, '邮箱或密码错误')
      const user = await store.findUserByEmail(email)
      if (!user || !(await verifyPassword(password, user.passwordHash))) fail(401, '邮箱或密码错误')
      const token = crypto.randomBytes(32).toString('hex')
      await store.createSession(tokenHash(token), user.id, new Date(Date.now() + SESSION_MS))
      res.setHeader('Set-Cookie', sessionCookie(token))
      return reply(200, { user: safeUser(user) })
    }
    if (route === '/api/auth/logout') {
      const token = readCookie(req)
      if (token) await store.deleteSession(tokenHash(token))
      res.setHeader('Set-Cookie', sessionCookie('', 0))
      return reply(200, { ok: true })
    }
    if (route === '/api/profile') {
      const user = await requireUser(req)
      if (!user.emailVerifiedAt) fail(403, '请先验证邮箱')
      throttle(req, 'profile', 5)
      const input = await bodyJson(req)
      const name = typeof input.artistName === 'string' ? input.artistName.trim() : ''
      const match = ARTIST_RE.exec(typeof input.url === 'string' ? input.url.trim() : '')
      if (!match || !name || name.length > 80) fail(400, '请填写正确的音乐人主页链接与名称')
      const proofCode = 'DISCOVERY-' + crypto.randomBytes(9).toString('hex').toUpperCase()
      const profile = await store.createProfile(user.id, { artistId: match[1], artistName: name, proofCode })
      return reply(201, { profile, notice: '请将认证码临时放入公开主页简介，等待人工审核；这并非网易云官方认证' })
    }
    if (route === '/api/songs') {
      const user = await requireUser(req)
      if (!user.emailVerifiedAt) fail(403, '请先验证邮箱')
      throttle(req, 'songs', 20)
      const profile = await store.getProfile(user.id)
      if (!profile) fail(403, '请先绑定音乐人主页')
      const input = await bodyJson(req)
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      const urlText = typeof input.url === 'string' ? input.url.trim() : ''
      const match = SONG_RE.exec(urlText)
      if (!title || title.length > 100 || !match) fail(400, '歌曲名称或链接无效')
      const song = await store.createSong({
        id: crypto.randomUUID(), ownerId: user.id, neteaseSongId: match[1],
        title, artist: profile.artistName, url: 'https://music.163.com/song?id=' + match[1],
      })
      return reply(201, { song: publicSong(song), notice: '作品已提交，等待人工审核后公开展示' })
    }
    const visit = /^\/api\/songs\/([0-9a-f-]{36})\/visits$/i.exec(route)
    if (visit) {
      const user = await requireUser(req)
      throttle(req, 'visits', 100)
      await bodyJson(req)
      if (!ID_RE.test(visit[1])) fail(400, '作品 ID 无效')
      const recorded = await store.recordVisit(visit[1], user.id)
      if (recorded === null) fail(404, '作品不存在、未审核或不可记录自己的作品')
      return reply(200, { recorded, notice: '仅记录平台登录账号的首次访问，不代表网易云有效播放或不同自然人' })
    }
    const approveProfile = /^\/api\/admin\/profiles\/([0-9a-f-]{36})\/approve$/i.exec(route)
    if (approveProfile) {
      authAdmin(req, adminToken)
      await bodyJson(req)
      const profile = await store.approveProfile(approveProfile[1])
      if (!profile) fail(404, '待审核音乐人不存在')
      await store.addAudit('profile_approved', profile.userId)
      return reply(200, { profile })
    }
    const approveSong = /^\/api\/admin\/songs\/([0-9a-f-]{36})\/approve$/i.exec(route)
    if (approveSong) {
      authAdmin(req, adminToken)
      await bodyJson(req)
      const song = await store.approveSong(approveSong[1])
      if (!song) fail(409, '歌曲不存在、已审核或音乐人尚未认证')
      await store.addAudit('song_approved', song.id)
      return reply(200, { song })
    }
    fail(404, '接口不存在')
  }
  return http.createServer((req, res) => {
    handle(req, res).catch(error => {
      const status = error instanceof HttpError ? error.status : error.code === '23505' ? 409 : 500
      if (status === 500) console.error('[artist-community]', error)
      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ error: status === 500 ? '服务器内部错误' : status === 409 ? '该账号、音乐人或歌曲已经存在' : error.message }))
      } else res.end()
    })
  })
}
async function start() {
  const store = await createPgStore()
  const { createMailerFromEnv } = require('./mail')
  const mailer = createMailerFromEnv()
  const host = process.env.ARTIST_COMMUNITY_HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')
  createServer({ store, mailer }).listen(PORT, host, () => console.log('Artist community ready on ' + host + ':' + PORT))
}
if (require.main === module) start().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { createServer, hashPassword, verifyPassword, SONG_RE, ARTIST_RE }
