'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const workflow = name => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8')

test('a fork never syncs upstream directly into main', () => {
  const sync = workflow('sync.yml')
  assert.match(sync, /github\.repository == 'zerlinpi\/api-enhanced'/)
  assert.match(sync, /git merge --no-ff --no-edit upstream\/main/)
  assert.match(sync, /gh pr create --base main/)
  assert.match(sync, /HEAD:refs\/heads\/sync\/upstream-proposal/)
  assert.doesNotMatch(sync, /target_sync_branch:\s*main/)
  assert.doesNotMatch(sync, /git push (?:-\S+\s+)*origin (?:HEAD:refs\/heads\/)?main(?:\s|$)/m)
})

test('upstream package publishing and external AI comment bot stay disabled in fork', () => {
  const release = workflow('release-on-version-change.yml')
  const agent = workflow('opencode.yml')
  assert.match(release, /if:\s*github\.repository == 'NeteaseCloudMusicApiEnhanced\/api-enhanced'/)
  assert.match(agent, /github\.repository == 'NeteaseCloudMusicApiEnhanced\/api-enhanced'/)
})

test('upstream API builds do not run for standalone community-only changes', () => {
  const build = workflow('build-dev.yml')
  assert.match(build, /paths:/)
  assert.match(build, /- 'module\/\*\*'/)
  assert.doesNotMatch(build, /- 'artist-community\/\*\*'/)
})

test('production deployment requires manual main branch dispatch', () => {
  const deploy = workflow('artist-community-deploy.yml')
  assert.match(deploy, /workflow_dispatch:/)
  assert.match(deploy, /github\.ref == 'refs\/heads\/main'/)
  assert.match(deploy, /inputs\.confirmation == 'DEPLOY'/)
})
