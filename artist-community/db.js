'use strict'
const fs = require('node:fs')
const path = require('node:path')

/** PostgreSQL-backed store. All values are parameters; no user-provided SQL fragments. */
async function createPgStore(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('DATABASE_URL is required for the community app')
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString, max: 10 })
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'))
  } catch (error) {
    await pool.end()
    throw error
  }
  const q = (sql, values = []) => pool.query(sql, values)
  return {
    async createUser(user) {
      const { rows } = await q('INSERT INTO community_users(id,email,password_hash) VALUES ($1,$2,$3) RETURNING id,email,email_verified_at AS "emailVerifiedAt"', [user.id, user.email, user.passwordHash])
      return rows[0]
    },
    async findUserByEmail(email) {
      const { rows } = await q('SELECT id,email,password_hash AS "passwordHash",email_verified_at AS "emailVerifiedAt" FROM community_users WHERE email=$1', [email])
      return rows[0] || null
    },
    async findSession(tokenHash) {
      const { rows } = await q(`SELECT u.id,u.email,u.email_verified_at AS "emailVerifiedAt" FROM community_sessions s
        JOIN community_users u ON u.id=s.user_id
        WHERE s.token_hash=$1 AND s.expires_at > now()`, [tokenHash])
      return rows[0] || null
    },
    async createSession(tokenHash, userId, expiresAt) {
      await q('DELETE FROM community_sessions WHERE expires_at < now()')
      await q('INSERT INTO community_sessions(token_hash,user_id,expires_at) VALUES ($1,$2,$3)', [tokenHash, userId, expiresAt])
    },
    async deleteSession(tokenHash) {
      await q('DELETE FROM community_sessions WHERE token_hash=$1', [tokenHash])
    },
    async createProfile(userId, profile) {
      const { rows } = await q(`INSERT INTO community_profiles(user_id,artist_id,artist_name,proof_code)
        VALUES ($1,$2,$3,$4) RETURNING user_id AS "userId",artist_id AS "artistId",
        artist_name AS "artistName",proof_code AS "proofCode",status`,
      [userId, profile.artistId, profile.artistName, profile.proofCode])
      return rows[0]
    },
    async getProfile(userId) {
      const { rows } = await q(`SELECT user_id AS "userId",artist_id AS "artistId",
        artist_name AS "artistName",proof_code AS "proofCode",status FROM community_profiles WHERE user_id=$1`, [userId])
      return rows[0] || null
    },
    async createSong(song) {
      const { rows } = await q(`INSERT INTO community_songs(id,owner_id,netease_song_id,title,artist,url)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id, owner_id AS "ownerId",title,artist,url,status,created_at AS "createdAt"`,
      [song.id, song.ownerId, song.neteaseSongId, song.title, song.artist, song.url])
      return rows[0]
    },
    async listSongs() {
      const { rows } = await q(`SELECT s.id,s.title,s.artist,s.url,s.created_at AS "createdAt",
        count(v.user_id)::int AS "communityVisitors"
        FROM community_songs s LEFT JOIN community_visits v ON v.song_id=s.id
        WHERE s.status='approved'
        GROUP BY s.id ORDER BY s.created_at DESC LIMIT 100`)
      return rows
    },
    async recommendSongs(userId) {
      const { rows } = await q(`SELECT s.id,s.title,s.artist,s.url,s.created_at AS "createdAt",
        count(v.user_id)::int AS "communityVisitors"
        FROM community_songs s LEFT JOIN community_visits v ON v.song_id=s.id
        WHERE s.status='approved' AND s.owner_id <> $1
          AND NOT EXISTS (
            SELECT 1 FROM community_visits seen
            WHERE seen.song_id=s.id AND seen.user_id=$1
          )
        GROUP BY s.id ORDER BY count(v.user_id) ASC, s.created_at DESC LIMIT 40`, [userId])
      return rows
    },
    async listMySongs(userId) {
      const { rows } = await q(`SELECT id,title,artist,url,status,created_at AS "createdAt"
        FROM community_songs WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100`, [userId])
      return rows
    },
    async recordVisit(songId, userId) {
      const { rows } = await q(`INSERT INTO community_visits(song_id,user_id)
        SELECT id,$2 FROM community_songs
        WHERE id=$1 AND status='approved' AND owner_id <> $2
        ON CONFLICT DO NOTHING RETURNING song_id`, [songId, userId])
      if (rows.length) return true
      const { rows: songs } = await q('SELECT id,owner_id,status FROM community_songs WHERE id=$1', [songId])
      return songs.length && songs[0].status === 'approved' && songs[0].owner_id !== userId ? false : null
    },
    async reviewQueue() {
      const [profiles, songs] = await Promise.all([
        q(`SELECT user_id AS "userId",artist_id AS "artistId",artist_name AS "artistName",
          proof_code AS "proofCode",status FROM community_profiles WHERE status='pending' ORDER BY created_at ASC LIMIT 100`),
        q(`SELECT s.id,s.title,s.artist,s.url,s.owner_id AS "ownerId",p.status AS "profileStatus"
          FROM community_songs s LEFT JOIN community_profiles p ON p.user_id=s.owner_id
          WHERE s.status='pending' ORDER BY s.created_at ASC LIMIT 100`),
      ])
      return { profiles: profiles.rows, songs: songs.rows }
    },
    async approveProfile(userId) {
      const { rows } = await q(`UPDATE community_profiles SET status='verified' WHERE user_id=$1 AND status='pending'
        RETURNING user_id AS "userId",status`, [userId])
      return rows[0] || null
    },
    async approveSong(songId) {
      const { rows } = await q(`UPDATE community_songs s SET status='approved' FROM community_profiles p
        WHERE s.id=$1 AND s.owner_id=p.user_id AND p.status='verified' AND s.status='pending'
        RETURNING s.id,s.status`, [songId])
      return rows[0] || null
    },
    async submitSongReport(report) {
      const { rows } = await q(`INSERT INTO community_song_reports(id,song_id,reporter_id,reason,details)
        SELECT $1,s.id,$3,$4,$5 FROM community_songs s
        WHERE s.id=$2 AND s.status='approved' AND s.owner_id <> $3
        ON CONFLICT (song_id,reporter_id) DO NOTHING
        RETURNING id,song_id AS "songId",reason,status`,
      [report.id, report.songId, report.reporterId, report.reason, report.details])
      return rows[0] || null
    },
    async listPendingReports() {
      const { rows } = await q(`SELECT r.id,r.song_id AS "songId",r.reason,r.details,
        r.created_at AS "createdAt",s.title,s.artist,s.url,s.status AS "songStatus"
        FROM community_song_reports r JOIN community_songs s ON s.id=r.song_id
        WHERE r.status='pending'
        ORDER BY r.created_at ASC LIMIT 100`)
      return rows
    },
    async listHiddenSongs() {
      const { rows } = await q(`SELECT s.id,s.title,s.artist,s.url,
        s.created_at AS "createdAt"
        FROM community_songs s WHERE s.status='hidden'
        ORDER BY s.created_at DESC LIMIT 100`)
      return rows
    },
    async moderateSong(songId, action) {
      if (!['hide', 'restore'].includes(action)) throw new Error('Unsupported moderation action')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const { rows } = action === 'hide'
          ? await client.query(`UPDATE community_songs SET status='hidden'
              WHERE id=$1 AND status='approved' RETURNING id,status`, [songId])
          : await client.query(`UPDATE community_songs s SET status='approved'
              FROM community_profiles p
              WHERE s.id=$1 AND s.status='hidden'
                AND s.owner_id=p.user_id AND p.status='verified'
              RETURNING s.id,s.status`, [songId])
        if (!rows.length) { await client.query('ROLLBACK'); return null }
        if (action === 'hide') {
          await client.query(`UPDATE community_song_reports SET status='resolved',reviewed_at=now()
            WHERE song_id=$1 AND status='pending'`, [songId])
        }
        await client.query('INSERT INTO community_audit_log(action,target_id) VALUES ($1,$2)',
          [action === 'hide' ? 'song_hidden' : 'song_restored', songId])
        await client.query('COMMIT')
        return rows[0]
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async dismissReport(reportId) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const { rows } = await client.query(`UPDATE community_song_reports
          SET status='dismissed',reviewed_at=now()
          WHERE id=$1 AND status='pending'
          RETURNING id,status`, [reportId])
        if (!rows.length) { await client.query('ROLLBACK'); return null }
        await client.query('INSERT INTO community_audit_log(action,target_id) VALUES ($1,$2)',
          ['report_dismissed', reportId])
        await client.query('COMMIT')
        return rows[0]
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async saveAuthToken(userId, purpose, hash, expiresAt) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('DELETE FROM community_auth_tokens WHERE user_id=$1 AND purpose=$2', [userId, purpose])
        await client.query('DELETE FROM community_auth_tokens WHERE expires_at < now()')
        await client.query(
          'INSERT INTO community_auth_tokens(token_hash,user_id,purpose,expires_at) VALUES ($1,$2,$3,$4)',
          [hash, userId, purpose, expiresAt],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async consumeAuthToken(hash, purpose, newPasswordHash) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const { rows } = await client.query(
          'DELETE FROM community_auth_tokens WHERE token_hash=$1 AND purpose=$2 AND expires_at > now() RETURNING user_id',
          [hash, purpose],
        )
        if (!rows.length) {
          await client.query('ROLLBACK')
          return false
        }
        const userId = rows[0].user_id
        if (purpose === 'email_verification') {
          await client.query('UPDATE community_users SET email_verified_at=COALESCE(email_verified_at,now()) WHERE id=$1', [userId])
        } else if (purpose === 'password_reset') {
          if (!newPasswordHash) throw new Error('Password hash is required')
          await client.query('UPDATE community_users SET password_hash=$2 WHERE id=$1', [userId, newPasswordHash])
          await client.query('DELETE FROM community_sessions WHERE user_id=$1', [userId])
          await client.query('DELETE FROM community_auth_tokens WHERE user_id=$1', [userId])
        } else {
          throw new Error('Unsupported token purpose')
        }
        await client.query('COMMIT')
        return true
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async addAudit(action, targetId) {
      await q('INSERT INTO community_audit_log(action,target_id) VALUES ($1,$2)', [action, targetId])
    },
    async ready() {
      const { rows } = await q('SELECT 1 AS ok')
      return rows[0]?.ok === 1
    },
    async exportAccount(userId) {
      // Export only records belonging to the requesting account, using a
      // consistent snapshot. Never include password hashes or session tokens.
      const client = await pool.connect()
      try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const account = await client.query(
          'SELECT id,email,created_at AS "createdAt",email_verified_at AS "emailVerifiedAt" FROM community_users WHERE id=$1',
          [userId],
        )
        if (!account.rows.length) {
          await client.query('ROLLBACK')
          return null
        }
        const profile = await client.query(
          'SELECT artist_id AS "artistId",artist_name AS "artistName",status,created_at AS "createdAt" FROM community_profiles WHERE user_id=$1',
          [userId],
        )
        const songs = await client.query(
          'SELECT id,netease_song_id AS "neteaseSongId",title,artist,url,status,created_at AS "createdAt" FROM community_songs WHERE owner_id=$1 ORDER BY created_at ASC',
          [userId],
        )
        const visits = await client.query(
          'SELECT song_id AS "songId",created_at AS "createdAt" FROM community_visits WHERE user_id=$1 ORDER BY created_at ASC',
          [userId],
        )
        await client.query('COMMIT')
        return {
          version: 1,
          generatedAt: new Date().toISOString(),
          account: account.rows[0],
          artistProfile: profile.rows[0] || null,
          submittedSongs: songs.rows,
          visitedSongs: visits.rows,
        }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async revokeAllSessions(userId) {
      await q('DELETE FROM community_sessions WHERE user_id=$1', [userId])
    },
    async deleteAccount(userId) {
      // This transaction removes the user's profile, songs, visits,
      // email tokens and sessions through ON DELETE CASCADE.
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Remove directly identifying audit targets before dropping the account.
        await client.query(`DELETE FROM community_audit_log
          WHERE target_id=$1 OR target_id IN
            (SELECT id::text FROM community_songs WHERE owner_id=$2)`, [userId, userId])
        const { rowCount } = await client.query(
          'DELETE FROM community_users WHERE id=$1', [userId],
        )
        await client.query('COMMIT')
        return rowCount > 0
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
    async close() { await pool.end() },
  }
}
module.exports = { createPgStore }
