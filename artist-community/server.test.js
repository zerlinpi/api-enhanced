'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'artist-community-test-')), 'db.json')
process.env.ARTIST_COMMUNITY_DATA = file
const { createServer } = require('./server')
test('song registration, deduplication and community-only visits', async t => {
 const server = createServer()
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
 t.after(() => server.close())
 const base = 'http://127.0.0.1:' + server.address().port
 const send = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) })
 let r = await send('/api/songs', { title: '测试作品', artist: '测试音乐人', url:'https://music.163.com/song?id=123456' })
 assert.equal(r.status, 201)
 const song = (await r.json()).song
 assert.equal(song.officialValidPlays, null)
 assert.equal(song.officialTaskStatus, 'unavailable')
 r = await send('/api/songs', { title: '重复', artist: '其他', url:'https://music.163.com/song?id=123456' })
 assert.equal(r.status, 409)
 const visitorId = '11111111-1111-4111-8111-111111111111'
 for (let i = 0; i < 2; i++) {
  r = await send('/api/songs/' + song.id + '/visits', { visitorId })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).song.communityVisitors, 1)
 }
 r = await fetch(base + '/api/songs')
 assert.equal((await r.json()).songs[0].communityVisitors, 1)
 r = await send('/api/songs', { title: 'bad', artist: 'bad', url:'https://evil.example/song?id=1' })
 assert.equal(r.status, 400)
})
