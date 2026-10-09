'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('./server')

const OWNER='owner-token-with-at-least-32-random-like-characters'
const REVIEWER='reviewer-token-with-at-least-32-random-like-characters'
const SONG_ID='11111111-1111-4111-8111-111111111111'
const REPORT_ID='22222222-2222-4222-8222-222222222222'

test('reviewer can moderate but cannot restore or inspect owner-only analytics/audit', async t => {
  const actions=[]
  const store={
    async listPendingReports(){return []},
    async listHiddenSongs(){return [{id:SONG_ID,title:'Example',status:'hidden',url:'https://music.163.com/song?id=123',artist:'Artist'}]},
    async reviewQueue(){return {profiles:[],songs:[]}},
    async adminOverview(){return {users:4,verifiedUsers:2,pendingProfiles:0,pendingSongs:0,publishedSongs:1,hiddenSongs:1,pendingReports:0,communityVisits:3}},
    async listAudit(){return [{id:1,action:'song_hidden',actor:'reviewer',targetId:SONG_ID,createdAt:new Date().toISOString()}]},
    async moderateSong(id, action, actor){actions.push({id,action,actor});return {id,status:action==='hide'?'hidden':'approved'}},
    async approveProfile(id,actor){actions.push({id,action:'approve_profile',actor});return {userId:id,status:'verified'}},
    async approveSong(id,actor){actions.push({id,action:'approve_song',actor});return {id,status:'approved'}},
    async dismissReport(id,actor){actions.push({id,action:'dismiss',actor});return {id,status:'dismissed'}},
  }
  const server=createServer({store,adminToken:OWNER,reviewerToken:REVIEWER})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>server.close())
  const base='http://127.0.0.1:'+server.address().port
  const get=(url,token)=>fetch(base+url,{headers:{Authorization:'Bearer '+token}})
  const post=(url,token)=>fetch(base+url,{
    method:'POST',headers:{Authorization:'Bearer '+token,'X-Community-Request':'1','Content-Type':'application/json'},body:'{}',
  })
  assert.equal((await get('/api/admin/me',REVIEWER)).status,200)
  assert.equal((await (await get('/api/admin/me',REVIEWER)).json()).role,'reviewer')
  assert.equal((await (await get('/api/admin/me',OWNER)).json()).canRestore,true)
  assert.equal((await get('/api/admin/review',REVIEWER)).status,200)
  assert.equal((await get('/api/admin/reports',REVIEWER)).status,200)
  assert.equal((await get('/api/admin/overview',REVIEWER)).status,403)
  assert.equal((await get('/api/admin/audit',REVIEWER)).status,403)
  assert.equal((await get('/api/admin/overview','unknown')).status,403)
  assert.equal((await post('/api/admin/songs/'+SONG_ID+'/approve',REVIEWER)).status,200)
  assert.equal((await post('/api/admin/songs/'+SONG_ID+'/hide',REVIEWER)).status,200)
  assert.equal((await post('/api/admin/reports/'+REPORT_ID+'/dismiss',REVIEWER)).status,200)
  assert.equal((await post('/api/admin/songs/'+SONG_ID+'/restore',REVIEWER)).status,403)
  assert.equal((await get('/api/admin/audit',OWNER)).status,200)
  assert.equal((await (await get('/api/admin/overview',OWNER)).json()).overview.users,4)
  assert.equal((await post('/api/admin/songs/'+SONG_ID+'/restore',OWNER)).status,200)
  assert.deepEqual(actions.map(a=>a.actor),['reviewer','reviewer','reviewer','owner'])
})

test('legacy owner-only deployments remain supported without a reviewer token', async t => {
  const server=createServer({store:{async reviewQueue(){return {profiles:[],songs:[]}}},adminToken:OWNER})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>server.close())
  const base='http://127.0.0.1:'+server.address().port
  const result=await fetch(base+'/api/admin/review',{headers:{Authorization:'Bearer '+OWNER}})
  assert.equal(result.status,200)
})
