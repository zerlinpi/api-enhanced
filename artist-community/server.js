'use strict'
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const DATA_FILE = process.env.ARTIST_COMMUNITY_DATA || path.join(process.cwd(), '.artist-community-data.json')
const PORT = Number(process.env.ARTIST_COMMUNITY_PORT || 3100)
const MAX_BODY = 16 * 1024
const SONG_RE = /^https:\/\/music\.163\.com\/(?:#\/)?song\?id=(\d{1,20})(?:[&#].*)?$/

function readDb() {
  try {
    const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    return { songs: Array.isArray(value.songs) ? value.songs : [], visits: Array.isArray(value.visits) ? value.visits : [] }
  } catch (error) {
    if (error.code === 'ENOENT') return { songs: [], visits: [] }
    throw error
  }
}
function saveDb(db) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
  const temp = DATA_FILE + '.' + process.pid + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 })
  fs.renameSync(temp, DATA_FILE)
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body))
}
function bodyJson(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', chunk => {
      text += chunk
      if (text.length > MAX_BODY) { reject(new Error('body_too_large')); req.destroy() }
    })
    req.on('end', () => { try { resolve(JSON.parse(text || '{}')) } catch { reject(new Error('invalid_json')) } })
    req.on('error', reject)
  })
}
function publicSong(db, song) {
  return { ...song, communityVisitors: new Set(db.visits.filter(v => v.songId === song.id).map(v => v.visitorId)).size, officialValidPlays: null, officialTaskStatus: 'unavailable' }
}
function createServer() {
  const db = readDb()
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      return res.end(html)
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true })
    if (req.method === 'GET' && url.pathname === '/api/songs') {
      return json(res, 200, { songs: db.songs.map(song => publicSong(db, song)).reverse() })
    }
    if (req.method === 'POST' && url.pathname === '/api/songs') {
      try {
        const input = await bodyJson(req)
        const title = typeof input.title === 'string' ? input.title.trim() : ''
        const artist = typeof input.artist === 'string' ? input.artist.trim() : ''
        const link = typeof input.url === 'string' ? input.url.trim() : ''
        const match = SONG_RE.exec(link)
        if (!title || title.length > 100 || !artist || artist.length > 80 || !match) return json(res, 400, { error: '请填写合法的歌曲名称、音乐人和网易云歌曲链接' })
        const canonical = 'https://music.163.com/song?id=' + match[1]
        if (db.songs.some(s => s.url === canonical)) return json(res, 409, { error: '这首歌曲已经登记' })
        const song = { id: crypto.randomUUID(), title, artist, url: canonical, createdAt: new Date().toISOString() }
        db.songs.push(song)
        saveDb(db)
        return json(res, 201, { song: publicSong(db, song) })
      } catch (error) { return json(res, error.message === 'body_too_large' ? 413 : 400, { error: '请求格式错误' }) }
    }
    const visitMatch = /^\/api\/songs\/([0-9a-f-]{36})\/visits$/.exec(url.pathname)
    if (req.method === 'POST' && visitMatch) {
      try {
        const input = await bodyJson(req)
        const visitorId = typeof input.visitorId === 'string' ? input.visitorId : ''
        if (!/^[0-9a-f-]{36}$/.test(visitorId)) return json(res, 400, { error: '访客标识无效' })
        const song = db.songs.find(s => s.id === visitMatch[1])
        if (!song) return json(res, 404, { error: '歌曲不存在' })
        if (!db.visits.some(v => v.songId === song.id && v.visitorId === visitorId)) {
          db.visits.push({ songId: song.id, visitorId, viewedAt: new Date().toISOString() })
          saveDb(db)
        }
        return json(res, 200, { song: publicSong(db, song), notice: '仅记录站内访问；不代表网易云有效播放' })
      } catch { return json(res, 400, { error: '请求格式错误' }) }
    }
    return json(res, 404, { error: 'not_found' })
  })
}
if (require.main === module) createServer().listen(PORT, () => console.log('Artist community MVP listening on http://localhost:' + PORT))
module.exports = { createServer, publicSong, SONG_RE }
