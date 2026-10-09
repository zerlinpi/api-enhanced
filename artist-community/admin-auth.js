'use strict'
const crypto = require('node:crypto')

const ROLES = Object.freeze({ reviewer: 1, owner: 2 })
function digest(token) {
  return crypto.createHash('sha256').update(token).digest()
}
function createAdminAuth({ adminToken, reviewerToken } = {}) {
  const valid = value => typeof value === 'string' && value.length >= 32
  if (reviewerToken && !valid(reviewerToken)) {
    throw new Error('Reviewer token must have at least 32 characters')
  }
  if (reviewerToken && valid(adminToken) && reviewerToken === adminToken) {
    throw new Error('Reviewer and owner tokens must be different')
  }
  const credentials = []
  if (valid(adminToken)) credentials.push({ actor: 'owner', role: 'owner', hash: digest(adminToken) })
  if (valid(reviewerToken)) credentials.push({ actor: 'reviewer', role: 'reviewer', hash: digest(reviewerToken) })

  return function authorize(req, minimumRole = 'reviewer') {
    if (!credentials.some(c => c.role === 'owner')) {
      return { error: 503 }
    }
    const bearer = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')
    // Hash the received credential and compare fixed-size buffers.
    const received = digest(bearer ? bearer[1] : '')
    let matched = null
    for (const account of credentials) {
      if (crypto.timingSafeEqual(account.hash, received)) matched = account
    }
    if (!matched) return { error: 403 }
    if (ROLES[matched.role] < ROLES[minimumRole]) return { error: 403 }
    return { role: matched.role, actor: matched.actor }
  }
}
module.exports = { createAdminAuth }
