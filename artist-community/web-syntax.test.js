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
