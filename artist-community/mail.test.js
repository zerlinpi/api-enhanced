'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createMailerFromEnv } = require('./mail')

test('production account emails require HTTPS and a real SMTP configuration', () => {
  assert.throws(() => createMailerFromEnv({
    PUBLIC_BASE_URL: 'http://music.example.com', NODE_ENV: 'production',
    MAIL_MODE: 'console',
  }), /https/)
  assert.throws(() => createMailerFromEnv({
    PUBLIC_BASE_URL: 'https://music.example.com', NODE_ENV: 'production',
    MAIL_MODE: 'console',
  }), /Unknown MAIL_MODE/)
  assert.throws(() => createMailerFromEnv({
    PUBLIC_BASE_URL: 'https://music.example.com', NODE_ENV: 'production',
  }), /SMTP configuration/)
  assert.throws(() => createMailerFromEnv({
    PUBLIC_BASE_URL: 'https://username:password@music.example.com',
    NODE_ENV: 'production',
  }), /Invalid PUBLIC_BASE_URL/)
})
