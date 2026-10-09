'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAdminAuth } = require('./admin-auth')

test('owner and reviewer have distinct credentials and permissions', () => {
  const adminToken='owner-key-1234567890-1234567890-123456'
  const reviewerToken='reviewer-key-1234567890-1234567890-123456'
  const authorize=createAdminAuth({adminToken,reviewerToken})
  const req=token=>({headers:{authorization:'Bearer '+token}})
  assert.deepEqual(authorize(req(adminToken)),{role:'owner',actor:'owner'})
  assert.deepEqual(authorize(req(reviewerToken)),{role:'reviewer',actor:'reviewer'})
  assert.deepEqual(authorize(req(adminToken),'owner'),{role:'owner',actor:'owner'})
  assert.equal(authorize(req(reviewerToken),'owner').error,403)
  assert.equal(authorize(req('a-fake-token')).error,403)
  assert.equal(authorize({headers:{}}).error,403)
})

test('short, duplicated or missing administrative secrets never grant privilege', () => {
  const secret='a-strong-secret-with-more-than-32-characters'
  assert.throws(()=>createAdminAuth({adminToken:secret,reviewerToken:secret}),/different/)
  assert.throws(()=>createAdminAuth({adminToken:secret,reviewerToken:'short'}),/32/)
  const missing=createAdminAuth({})
  assert.equal(missing({headers:{authorization:'Bearer '+secret}}).error,503)
  const weak=createAdminAuth({adminToken:'short'})
  assert.equal(weak({headers:{authorization:'Bearer short'}}).error,503)
})
