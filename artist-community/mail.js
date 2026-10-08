'use strict'
const nodemailer = require('nodemailer')

function createMailerFromEnv(env = process.env) {
  const base = env.PUBLIC_BASE_URL
  if (!base) throw new Error('PUBLIC_BASE_URL is required to send account emails')
  const parsed = new URL(base)
  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error('PUBLIC_BASE_URL must use https in production')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Invalid PUBLIC_BASE_URL')
  }
  const mode = env.MAIL_MODE || 'smtp'
  let send
  if (mode === 'console' && env.NODE_ENV !== 'production') {
    send = async (email, kind, link) => {
      // Local-only development mode. Never enable for real accounts or production.
      process.stdout.write('[DEV EMAIL] ' + kind + ' to ' + email + ': ' + link + '\n')
    }
  } else if (mode === 'smtp') {
    if (!env.MAIL_HOST || !env.MAIL_USER || !env.MAIL_PASSWORD || !env.MAIL_FROM) {
      throw new Error('SMTP configuration MAIL_HOST, MAIL_USER, MAIL_PASSWORD and MAIL_FROM is required')
    }
    const transport = nodemailer.createTransport({
      host: env.MAIL_HOST,
      port: Number(env.MAIL_PORT || 587),
      secure: env.MAIL_SECURE === 'true',
      requireTLS: env.MAIL_SECURE !== 'true',
      auth: { user: env.MAIL_USER, pass: env.MAIL_PASSWORD },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000,
    })
    send = (email, kind, link) => transport.sendMail({
      from: env.MAIL_FROM,
      to: email,
      subject: kind === 'verify' ? '云音发现｜确认邮箱' : '云音发现｜重置密码',
      text: (kind === 'verify' ? '请确认你在云音发现注册的邮箱：\n' : '请使用以下链接重置云音发现账户密码：\n') +
        link + '\n\n此链接仅可使用一次，且会在有效期后失效。若非你本人操作，请忽略。\n',
    })
  } else {
    throw new Error('Unknown MAIL_MODE; use smtp or local-only console')
  }
  const link = (kind, token) => {
    const address = new URL('/', parsed)
    address.hash = new URLSearchParams({ [kind]: token }).toString()
    return address.toString()
  }
  return {
    async sendVerification(email, token) { await send(email, 'verify', link('verify', token)) },
    async sendPasswordReset(email, token) { await send(email, 'reset', link('reset', token)) },
  }
}
module.exports = { createMailerFromEnv }
