'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

for (const name of ['index.html', 'admin.html']) {
  test('inline browser script in ' + name + ' parses', () => {
    const html = fs.readFileSync(path.join(__dirname, name), 'utf8')
    const match = /<script>([\s\S]*?)<\/script>/.exec(html)
    assert.ok(match, 'expected application script')
    assert.doesNotThrow(() => new vm.Script(match[1], { filename: name }))
  })
}


test('simple homepage exposes the core workflow without placeholder integrations', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
  for (const id of [
    'loginForm', 'registerForm', 'verifyForm', 'profileForm', 'songForm', 'songs',
    'forgotForm', 'resetForm', 'logoutAllForm', 'deleteForm',
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'), id + ' must remain accessible')
  }
  assert.match(html, /api\('\/api\/songs'\)/, 'public discovery list must load')
  assert.match(html, /api\('\/api\/my\/songs'\)/, 'submitted songs must be accessible')
  assert.match(html, /data\.songs\.filter\(song=>!ownIds\.has\(song\.id\)\)/,
    'logged-in users should not see their own works as discoveries')
  assert.doesNotMatch(html, /\/api\/official\/metrics|\/api\/recommendations|\/api\/auth\/providers/,
    'keep unconnected metrics, extra recommendations and fake sign-in off the home page')
  assert.doesNotMatch(html, /id="officialPlays"|id="neteaseLogin"/,
    'avoid prominently displaying unavailable functionality')
  assert.match(html, /网易云官方第三方登录尚未开放/)
})
