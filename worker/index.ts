interface D1Result<T = unknown> {
  results: T[]
  success: boolean
  meta: { changes?: number }
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T>(): Promise<T | null>
  all<T>(): Promise<D1Result<T>>
  run(): Promise<D1Result>
}

interface D1Database {
  prepare(query: string): D1Statement
  batch(statements: D1Statement[]): Promise<D1Result[]>
}

interface R2Object {
  body: ReadableStream<Uint8Array>
  httpMetadata?: { contentType?: string }
  size: number
}

interface R2Bucket {
  get(key: string): Promise<R2Object | null>
  head(key: string): Promise<unknown | null>
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>
  delete(key: string): Promise<void>
}

interface Env {
  DB: D1Database
  FILES: R2Bucket
  ASSETS: { fetch(request: Request): Promise<Response> }
  ACCESS_TEAM_DOMAIN: string
  ACCESS_AUD: string
  SETTINGS_ENCRYPTION_KEY: string
  DEV_AUTH_BYPASS?: string
}

type AccessClaims = {
  sub?: string
  email?: string
  aud?: string | string[]
  iss?: string
  exp?: number
  nbf?: number
}

type AccessJwk = JsonWebKey & { kid?: string }

type SessionRow = {
  id: string
  title: string
  created_at: number
  updated_at: number
  data_json?: string
}

type StoredSettings = {
  settings_json: string
  api_key_cipher: string | null
  migration_complete: number
}

type SessionInput = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Array<{ role: string; files?: Array<{ id: string; serverId?: string | null }> }>
  [key: string]: unknown
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })

const error = (message: string, status: number) => json({ error: message }, status)

const base64ToBytes = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}
const bytesToBase64 = (value: Uint8Array) => btoa(String.fromCharCode(...value))
const hex = (value: ArrayBuffer) =>
  [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const sha256 = async (value: BufferSource) => hex(await crypto.subtle.digest('SHA-256', value))

const normalizedDomain = (value: string) =>
  value.replace(/^https?:\/\//, '').replace(/\/$/, '')

let jwksCache: { domain: string; expiresAt: number; keys: AccessJwk[] } | null = null

const loadJwks = async (domain: string, force = false) => {
  if (!force && jwksCache?.domain === domain && jwksCache.expiresAt > Date.now()) {
    return jwksCache.keys
  }
  const response = await fetch(`https://${domain}/cdn-cgi/access/certs`)
  if (!response.ok) {
    throw new Error('Unable to load Cloudflare Access signing keys')
  }
  const body = (await response.json()) as { keys?: AccessJwk[] }
  if (!body.keys?.length) {
    throw new Error('Cloudflare Access returned no signing keys')
  }
  jwksCache = { domain, keys: body.keys, expiresAt: Date.now() + 5 * 60_000 }
  return body.keys
}

type AuthFailure =
  | 'worker_auth_not_configured'
  | 'malformed_token'
  | 'unsupported_token'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'token_expired_or_not_yet_valid'
  | 'signing_key_not_found'
  | 'signature_invalid'
  | 'identity_missing'
  | 'verification_error'

const verifyAccessToken = async (
  token: string,
  env: Env
): Promise<{ userId: string } | AuthFailure> => {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return 'worker_auth_not_configured'
  }
  try {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return 'malformed_token'
    }
    const header = JSON.parse(new TextDecoder().decode(base64ToBytes(parts[0]))) as {
      alg?: string
      kid?: string
    }
    const claims = JSON.parse(new TextDecoder().decode(base64ToBytes(parts[1]))) as AccessClaims
    const domain = normalizedDomain(env.ACCESS_TEAM_DOMAIN)
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    const now = Math.floor(Date.now() / 1000)
    if (header.alg !== 'RS256' || !header.kid) {
      return 'unsupported_token'
    }
    if (claims.iss !== `https://${domain}`) {
      return 'issuer_mismatch'
    }
    if (!audiences.includes(env.ACCESS_AUD)) {
      return 'audience_mismatch'
    }
    if (!claims.exp || claims.exp <= now || (claims.nbf !== undefined && claims.nbf > now)) {
      return 'token_expired_or_not_yet_valid'
    }
    let keys = await loadJwks(domain)
    let jwk = keys.find((key) => key.kid === header.kid)
    if (!jwk) {
      keys = await loadJwks(domain, true)
      jwk = keys.find((key) => key.kid === header.kid)
    }
    if (!jwk) {
      return 'signing_key_not_found'
    }
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    )
    const signature = base64ToBytes(parts[2])
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed))) {
      return 'signature_invalid'
    }
    const userId = claims.sub || claims.email
    return userId ? { userId } : 'identity_missing'
  } catch {
    return 'verification_error'
  }
}

const verifyAccessIdentity = async (request: Request, env: Env) => {
  // Prefer the assertion header, but try the browser application cookie too.
  // A Worker/static-assets route can expose one credential and omit the other.
  const cookieTokens = request.headers
    .get('Cookie')
    ?.split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('CF_Authorization='))
    .map((part) => part.slice('CF_Authorization='.length).replace(/^"|"$/g, ''))
  const tokens = [request.headers.get('Cf-Access-Jwt-Assertion'), ...(cookieTokens ?? [])].filter(
    (token): token is string => Boolean(token)
  )
  if (tokens.length === 0) {
    return { identity: null, reason: 'missing_token' }
  }
  const failures: AuthFailure[] = []
  for (const token of new Set(tokens)) {
    const result = await verifyAccessToken(token, env)
    if (typeof result === 'object') {
      return { identity: result, reason: null }
    }
    failures.push(result)
  }
  return { identity: null, reason: [...new Set(failures)].join(',') }
}

const encryptionKey = async (env: Env) =>
  crypto.subtle.importKey(
    'raw',
    base64ToBytes(env.SETTINGS_ENCRYPTION_KEY),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  )

const encrypt = async (env: Env, value: string) => {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    await encryptionKey(env),
    new TextEncoder().encode(value)
  )
  return `${bytesToBase64(nonce)}.${bytesToBase64(new Uint8Array(cipher))}`
}

const decrypt = async (env: Env, value: string) => {
  const [nonce, cipher] = value.split('.')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(nonce) },
    await encryptionKey(env),
    base64ToBytes(cipher)
  )
  return new TextDecoder().decode(plain)
}

const storageKey = (contentHash: string) => `sha256/${contentHash}`

const parseSession = async (request: Request): Promise<SessionInput | null> => {
  try {
    const value = (await request.json()) as SessionInput
    return value && typeof value.id === 'string' && Array.isArray(value.messages) ? value : null
  } catch {
    return null
  }
}

const sessionSummary = (row: SessionRow) => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const sessionPage = async (userId: string, env: Env, url: URL) => {
  const pageSize = Math.min(60, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '40', 10) || 40))
  const beforeUpdatedAt = url.searchParams.get('beforeUpdatedAt')
  const beforeId = url.searchParams.get('beforeId')
  if ((beforeUpdatedAt === null) !== (beforeId === null)) {
    return null
  }
  let rows: D1Result<SessionRow>
  if (beforeUpdatedAt !== null && beforeId !== null) {
    const timestamp = Number(beforeUpdatedAt)
    if (!Number.isSafeInteger(timestamp)) {
      return null
    }
    rows = await env.DB.prepare(
      `SELECT id, title, created_at, updated_at FROM sessions
       WHERE user_id = ? AND (updated_at, id) < (?, ?)
       ORDER BY updated_at DESC, id DESC LIMIT ?`
    )
      .bind(userId, timestamp, beforeId, pageSize + 1)
      .all<SessionRow>()
  } else {
    rows = await env.DB.prepare(
      `SELECT id, title, created_at, updated_at FROM sessions
       WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?`
    )
      .bind(userId, pageSize + 1)
      .all<SessionRow>()
  }
  const hasMore = rows.results.length > pageSize
  const items = rows.results.slice(0, pageSize)
  const last = items.at(-1)
  return {
    items: items.map(sessionSummary),
    nextCursor: hasMore && last ? { updatedAt: last.updated_at, id: last.id } : null,
  }
}

const deleteHashIfUnused = async (contentHash: string, env: Env) => {
  // Lock the hash inside D1 before deleting R2. New uploads only create refs
  // while this row is unlocked, so a racing upload cannot lose its R2 object.
  const lock = await env.DB.prepare(
    `UPDATE file_objects SET deleting = 1
     WHERE content_hash = ? AND deleting = 0
       AND NOT EXISTS (SELECT 1 FROM session_file_refs WHERE content_hash = ?)
       AND NOT EXISTS (SELECT 1 FROM user_files WHERE content_hash = ?)
       AND NOT EXISTS (SELECT 1 FROM pending_files WHERE content_hash = ?)
       AND NOT EXISTS (SELECT 1 FROM import_file_refs WHERE content_hash = ?)`
  )
    .bind(contentHash, contentHash, contentHash, contentHash, contentHash)
    .run()
  if (!lock.meta.changes) {
    return
  }
  try {
    await env.FILES.delete(storageKey(contentHash))
    await env.DB.prepare('DELETE FROM file_objects WHERE content_hash = ? AND deleting = 1')
      .bind(contentHash)
      .run()
  } catch (cause) {
    await env.DB.prepare('UPDATE file_objects SET deleting = 0 WHERE content_hash = ? AND deleting = 1')
      .bind(contentHash)
      .run()
    throw cause
  }
}

/** Remove touched, unreferenced aliases and inspect only the affected hashes. */
const collectOrphans = async (
  userId: string,
  env: Env,
  hashes: string[] = [],
  fileIds: string[] = []
) => {
  const expiredPending = await env.DB.prepare(
    `SELECT content_hash FROM pending_files WHERE user_id = ? AND created_at < ?`
  )
    .bind(userId, Date.now() - 24 * 60 * 60 * 1000)
    .all<{ content_hash: string }>()
  await env.DB.prepare('DELETE FROM pending_files WHERE user_id = ? AND created_at < ?')
    .bind(userId, Date.now() - 24 * 60 * 60 * 1000)
    .run()
  const orphanedAliases: string[] = []
  for (const fileId of new Set(fileIds)) {
    const alias = await env.DB.prepare(
      `SELECT content_hash FROM user_files f
       WHERE user_id = ? AND file_id = ? AND NOT EXISTS (
         SELECT 1 FROM session_file_refs r
         WHERE r.user_id = f.user_id AND r.file_id = f.file_id
       )`
    )
      .bind(userId, fileId)
      .first<{ content_hash: string }>()
    if (alias) {
      await env.DB.prepare(
        `DELETE FROM user_files WHERE user_id = ? AND file_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM session_file_refs r
           WHERE r.user_id = user_files.user_id AND r.file_id = user_files.file_id
         )`
      )
        .bind(userId, fileId)
        .run()
      orphanedAliases.push(alias.content_hash)
    }
  }

  for (const contentHash of new Set([
    ...hashes,
    ...expiredPending.results.map((row) => row.content_hash),
    ...orphanedAliases,
  ])) {
    await deleteHashIfUnused(contentHash, env)
  }
}

const routeApi = async (request: Request, env: Env, userId: string) => {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/'
  const method = request.method.toUpperCase()

  if (path === '/settings' && method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT settings_json, api_key_cipher FROM user_settings WHERE user_id = ?'
    )
      .bind(userId)
      .first<Pick<StoredSettings, 'settings_json' | 'api_key_cipher'>>()
    if (!row) {
      return json({ settings: null })
    }
    return json({
      settings: {
        ...JSON.parse(row.settings_json),
        apiKey: row.api_key_cipher ? await decrypt(env, row.api_key_cipher) : null,
      },
    })
  }

  if (path === '/settings' && method === 'PUT') {
    const input = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!input) {
      return error('invalid_settings', 400)
    }
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey : null
    const settings = { ...input }
    delete settings.apiKey
    const old = await env.DB.prepare(
      'SELECT api_key_cipher, migration_complete FROM user_settings WHERE user_id = ?'
    )
      .bind(userId)
      .first<Pick<StoredSettings, 'api_key_cipher' | 'migration_complete'>>()
    const cipher = Object.hasOwn(input, 'apiKey')
      ? apiKey
        ? await encrypt(env, apiKey)
        : null
      : (old?.api_key_cipher ?? null)
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, settings_json, api_key_cipher, migration_complete)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         settings_json = excluded.settings_json,
         api_key_cipher = excluded.api_key_cipher`
    )
      .bind(userId, JSON.stringify(settings), cipher, old?.migration_complete ?? 0)
      .run()
    return new Response(null, { status: 204 })
  }

  if (path === '/migration' && method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT migration_complete FROM user_settings WHERE user_id = ?'
    )
      .bind(userId)
      .first<{ migration_complete: number }>()
    return json({ complete: row?.migration_complete === 1 })
  }

  if (path === '/migration/complete' && method === 'POST') {
    await env.DB.prepare(
      `INSERT INTO user_settings (user_id, settings_json, api_key_cipher, migration_complete)
       VALUES (?, '{}', NULL, 1)
       ON CONFLICT(user_id) DO UPDATE SET migration_complete = 1`
    )
      .bind(userId)
      .run()
    return new Response(null, { status: 204 })
  }

  if (path === '/deepseek-file-cleanup' && method === 'GET') {
    const pending = await env.DB.prepare(
      `SELECT q.file_id FROM deepseek_file_cleanup q
       WHERE q.user_id = ? AND NOT EXISTS (
         SELECT 1 FROM session_deepseek_file_refs refs WHERE refs.file_id = q.file_id
       )
       ORDER BY q.created_at LIMIT 50`
    )
      .bind(userId)
      .all<{ file_id: string }>()
    return json({ fileIds: pending.results.map((row) => row.file_id) })
  }

  const deepSeekCleanupMatch = /^\/deepseek-file-cleanup\/([^/]+)$/.exec(path)
  if (deepSeekCleanupMatch && method === 'DELETE') {
    const fileId = decodeURIComponent(deepSeekCleanupMatch[1])
    await env.DB.prepare(
      'DELETE FROM deepseek_file_cleanup WHERE user_id = ? AND file_id = ?'
    )
      .bind(userId, fileId)
      .run()
    return new Response(null, { status: 204 })
  }

  if (path === '/sessions' && method === 'GET') {
    // Covered by sessions_by_user_updated; does not read the JSON conversation payload.
    const page = await sessionPage(userId, env, url)
    return page ? json(page) : error('invalid_cursor', 400)
  }

  const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path)
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1])
    if (method === 'GET') {
      const row = await env.DB.prepare(
        'SELECT data_json FROM sessions WHERE user_id = ? AND id = ?'
      )
        .bind(userId, sessionId)
        .first<{ data_json: string }>()
      return row ? json(JSON.parse(row.data_json)) : error('not_found', 404)
    }
    if (method === 'PUT') {
      const session = await parseSession(request)
      if (!session || session.id !== sessionId) {
        return error('invalid_session', 400)
      }
      const fileIds = [
        ...new Set(
          session.messages.flatMap((message) =>
            message.role === 'user' ? (message.files ?? []).map((file) => file.id) : []
          )
        ),
      ]
      const deepSeekFileIds = [
        ...new Set(
          session.messages.flatMap((message) =>
            message.role === 'user'
              ? (message.files ?? [])
                  .map((file) => file.serverId)
                  .filter((fileId): fileId is string => typeof fileId === 'string' && fileId.length > 0)
              : []
          )
        ),
      ]
      const previousFiles = await env.DB.prepare(
        'SELECT file_id, content_hash FROM session_file_refs WHERE user_id = ? AND session_id = ?'
      )
        .bind(userId, session.id)
        .all<{ file_id: string; content_hash: string }>()
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO sessions (user_id, id, title, created_at, updated_at, data_json)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, id) DO UPDATE SET
             title = excluded.title, created_at = excluded.created_at,
             updated_at = excluded.updated_at, data_json = excluded.data_json`
        ).bind(
          userId,
          session.id,
          session.title,
          session.createdAt,
          session.updatedAt,
          JSON.stringify(session)
        ),
        env.DB.prepare(
          `INSERT INTO user_files (user_id, file_id, content_hash, mime_type)
           SELECT p.user_id, p.file_id, p.content_hash, p.mime_type
           FROM pending_files p JOIN json_each(?) f
             ON p.file_id = CAST(f.value AS TEXT)
           WHERE p.user_id = ? AND (p.session_id = ? OR p.session_id IS NULL)
           ON CONFLICT(user_id, file_id) DO UPDATE SET
             content_hash = excluded.content_hash, mime_type = excluded.mime_type`
        ).bind(JSON.stringify(fileIds), userId, session.id),
        env.DB.prepare('DELETE FROM session_file_refs WHERE user_id = ? AND session_id = ?').bind(
          userId,
          session.id
        ),
        env.DB.prepare(
          `INSERT INTO session_file_refs (user_id, session_id, file_id, content_hash)
           SELECT ?, ?, CAST(f.value AS TEXT), uf.content_hash
           FROM json_each(?) f JOIN user_files uf
             ON uf.user_id = ? AND uf.file_id = CAST(f.value AS TEXT)`
        ).bind(userId, session.id, JSON.stringify(fileIds), userId),
        env.DB.prepare(
          `DELETE FROM pending_files WHERE user_id = ?
           AND (session_id = ? OR session_id IS NULL)
           AND file_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`
        ).bind(userId, session.id, JSON.stringify(fileIds)),
        env.DB.prepare(
          'DELETE FROM session_deepseek_file_refs WHERE user_id = ? AND session_id = ?'
        ).bind(userId, session.id),
        env.DB.prepare(
          `INSERT INTO session_deepseek_file_refs (user_id, session_id, file_id)
           SELECT ?, ?, CAST(value AS TEXT) FROM json_each(?) WHERE 1
           ON CONFLICT(user_id, session_id, file_id) DO NOTHING`
        ).bind(userId, session.id, JSON.stringify(deepSeekFileIds)),
      ])
      await collectOrphans(
        userId,
        env,
        previousFiles.results.map((row) => row.content_hash),
        previousFiles.results.map((row) => row.file_id)
      )
      return new Response(null, { status: 204 })
    }
    if (method === 'PATCH') {
      const input = (await request.json().catch(() => null)) as { title?: unknown } | null
      if (typeof input?.title !== 'string') {
        return error('invalid_title', 400)
      }
      const result = await env.DB.prepare(
        `UPDATE sessions SET title = ?, data_json = json_set(data_json, '$.title', ?)
         WHERE user_id = ? AND id = ?`
      )
        .bind(input.title, input.title, userId, sessionId)
        .run()
      return result.meta.changes ? new Response(null, { status: 204 }) : error('not_found', 404)
    }
    if (method === 'DELETE') {
      const [previousFiles, pendingFiles, previousDeepSeekFiles] = await Promise.all([
        env.DB.prepare(
          'SELECT file_id, content_hash FROM session_file_refs WHERE user_id = ? AND session_id = ?'
        )
          .bind(userId, sessionId)
          .all<{ file_id: string; content_hash: string }>(),
        env.DB.prepare(
          'SELECT content_hash FROM pending_files WHERE user_id = ? AND session_id = ?'
        )
          .bind(userId, sessionId)
          .all<{ content_hash: string }>(),
        env.DB.prepare(
          'SELECT file_id FROM session_deepseek_file_refs WHERE user_id = ? AND session_id = ?'
        )
          .bind(userId, sessionId)
          .all<{ file_id: string }>(),
      ])
      await env.DB.batch([
        env.DB.prepare('DELETE FROM session_file_refs WHERE user_id = ? AND session_id = ?').bind(
          userId,
          sessionId
        ),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id = ?').bind(userId, sessionId),
        env.DB.prepare('DELETE FROM pending_files WHERE user_id = ? AND session_id = ?').bind(
          userId,
          sessionId
        ),
        env.DB.prepare(
          'DELETE FROM session_deepseek_file_refs WHERE user_id = ? AND session_id = ?'
        ).bind(userId, sessionId),
        env.DB.prepare(
          `INSERT OR IGNORE INTO deepseek_file_cleanup (user_id, file_id, created_at)
           SELECT ?, CAST(input.value AS TEXT), ? FROM json_each(?) input
           WHERE NOT EXISTS (
             SELECT 1 FROM session_deepseek_file_refs refs
             WHERE refs.file_id = CAST(input.value AS TEXT)
           )`
        ).bind(
          userId,
          Date.now(),
          JSON.stringify(previousDeepSeekFiles.results.map((row) => row.file_id))
        ),
      ])
      await collectOrphans(
        userId,
        env,
        [
          ...previousFiles.results.map((row) => row.content_hash),
          ...pendingFiles.results.map((row) => row.content_hash),
        ],
        previousFiles.results.map((row) => row.file_id)
      )
      return new Response(null, { status: 204 })
    }
  }

  const fileMatch = /^\/files\/([^/]+)$/.exec(path)
  if (fileMatch) {
    const fileId = decodeURIComponent(fileMatch[1])
    if (method === 'PUT') {
      const importId = url.searchParams.get('import')
      if (importId) {
        const activeImport = await env.DB.prepare(
          'SELECT 1 AS found FROM imports WHERE user_id = ? AND import_id = ?'
        )
          .bind(userId, importId)
          .first<{ found: number }>()
        if (!activeImport) {
          return error('import_not_found', 404)
        }
      }
      const data = await request.arrayBuffer()
      const contentHash = await sha256(data)
      const mimeType = request.headers.get('Content-Type')?.split(';', 1)[0] || 'application/octet-stream'
      const objectKey = storageKey(contentHash)
      let attached = false
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const results = await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO file_objects (content_hash, byte_size, mime_type)
             VALUES (?, ?, ?)
             ON CONFLICT(content_hash) DO UPDATE SET byte_size = excluded.byte_size
             WHERE file_objects.deleting = 0`
          ).bind(contentHash, data.byteLength, mimeType),
          importId
            ? env.DB.prepare(
                `INSERT INTO import_file_refs (user_id, import_id, file_id, content_hash, mime_type)
                 SELECT ?, ?, ?, ?, ? WHERE EXISTS (
                   SELECT 1 FROM file_objects WHERE content_hash = ? AND deleting = 0
                 )
                 ON CONFLICT(user_id, import_id, file_id) DO UPDATE SET
                   content_hash = excluded.content_hash, mime_type = excluded.mime_type`
              ).bind(userId, importId, fileId, contentHash, mimeType, contentHash)
            : env.DB.prepare(
                `INSERT INTO pending_files (user_id, file_id, content_hash, mime_type, session_id, created_at)
                 SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
                   SELECT 1 FROM file_objects WHERE content_hash = ? AND deleting = 0
                 )
                 ON CONFLICT(user_id, file_id) DO UPDATE SET
                   content_hash = excluded.content_hash, mime_type = excluded.mime_type,
                   session_id = excluded.session_id, created_at = excluded.created_at`
              ).bind(
                userId,
                fileId,
                contentHash,
                mimeType,
                url.searchParams.get('session'),
                Date.now(),
                contentHash
              ),
        ])
        if (results[1]?.meta.changes) {
          attached = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!attached) {
        return error('file_busy', 503)
      }
      if (!(await env.FILES.head(objectKey))) {
        await env.FILES.put(objectKey, data, { httpMetadata: { contentType: mimeType } })
      }
      return new Response(null, { status: 204 })
    }
    if (method === 'GET') {
      const row = await env.DB.prepare(
        `SELECT content_hash, mime_type FROM pending_files
         WHERE user_id = ? AND file_id = ?
         UNION ALL
         SELECT content_hash, mime_type FROM user_files
         WHERE user_id = ? AND file_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM pending_files WHERE user_id = ? AND file_id = ?
           )
         LIMIT 1`
      )
        .bind(userId, fileId, userId, fileId, userId, fileId)
        .first<{ content_hash: string; mime_type: string }>()
      if (!row) {
        return error('not_found', 404)
      }
      const object = await env.FILES.get(storageKey(row.content_hash))
      if (!object) {
        return error('file_not_ready', 503)
      }
      return new Response(object.body, {
        headers: {
          'Content-Type': row.mime_type || object.httpMetadata?.contentType || 'application/octet-stream',
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    }
  }

  const importMatch = /^\/imports\/([^/]+)(?:\/sessions\/([^/]+))?$/.exec(path)
  const commitMatch = /^\/imports\/([^/]+)\/commit$/.exec(path)
  if (commitMatch && method === 'POST') {
    const importId = decodeURIComponent(commitMatch[1])
    const activeImport = await env.DB.prepare(
      'SELECT 1 AS found FROM imports WHERE user_id = ? AND import_id = ?'
    )
      .bind(userId, importId)
      .first<{ found: number }>()
    if (!activeImport) {
      return error('import_not_found', 404)
    }
    const importedCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM import_sessions WHERE user_id = ? AND import_id = ?'
    )
      .bind(userId, importId)
      .first<{ count: number }>()
    const [oldRefs, oldFiles, oldPendingFiles, stagedFiles, oldDeepSeekFiles] = await Promise.all([
      env.DB.prepare('SELECT content_hash FROM session_file_refs WHERE user_id = ?')
        .bind(userId)
        .all<{ content_hash: string }>(),
      env.DB.prepare('SELECT content_hash FROM user_files WHERE user_id = ?')
        .bind(userId)
        .all<{ content_hash: string }>(),
      env.DB.prepare('SELECT content_hash FROM pending_files WHERE user_id = ?')
        .bind(userId)
        .all<{ content_hash: string }>(),
      env.DB.prepare('SELECT content_hash FROM import_file_refs WHERE user_id = ? AND import_id = ?')
        .bind(userId, importId)
        .all<{ content_hash: string }>(),
      env.DB.prepare('SELECT file_id FROM session_deepseek_file_refs WHERE user_id = ?')
        .bind(userId)
        .all<{ file_id: string }>(),
    ])
    const batch = await env.DB.batch([
      env.DB.prepare('DELETE FROM session_file_refs WHERE user_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM session_deepseek_file_refs WHERE user_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM user_files WHERE user_id = ?').bind(userId),
      env.DB.prepare('DELETE FROM pending_files WHERE user_id = ?').bind(userId),
      env.DB.prepare(
        `INSERT INTO user_files (user_id, file_id, content_hash, mime_type)
         SELECT user_id, file_id, content_hash, mime_type FROM import_file_refs
         WHERE user_id = ? AND import_id = ?
         ON CONFLICT(user_id, file_id) DO UPDATE SET
           content_hash = excluded.content_hash, mime_type = excluded.mime_type`
      ).bind(userId, importId),
      env.DB.prepare(
        `INSERT INTO sessions (user_id, id, title, created_at, updated_at, data_json)
         SELECT user_id, session_id, title, created_at, updated_at, data_json
         FROM import_sessions WHERE user_id = ? AND import_id = ?`
      ).bind(userId, importId),
      env.DB.prepare(
        `INSERT INTO session_file_refs (user_id, session_id, file_id, content_hash)
         SELECT DISTINCT ?, s.session_id, CAST(json_extract(f.value, '$.id') AS TEXT), uf.content_hash
         FROM import_sessions s
         JOIN json_each(s.data_json, '$.messages') m
         JOIN json_each(m.value, '$.files') f
         JOIN user_files uf ON uf.user_id = ? AND uf.file_id = CAST(json_extract(f.value, '$.id') AS TEXT)
         WHERE s.user_id = ? AND s.import_id = ? AND json_extract(m.value, '$.role') = 'user'`
      ).bind(userId, userId, userId, importId),
      env.DB.prepare(
        `INSERT INTO session_deepseek_file_refs (user_id, session_id, file_id)
         SELECT DISTINCT ?, s.session_id, CAST(json_extract(f.value, '$.serverId') AS TEXT)
         FROM import_sessions s
         JOIN json_each(s.data_json, '$.messages') m
         JOIN json_each(m.value, '$.files') f
         WHERE s.user_id = ? AND s.import_id = ?
           AND json_extract(m.value, '$.role') = 'user'
           AND json_type(f.value, '$.serverId') = 'text'
           AND length(json_extract(f.value, '$.serverId')) > 0`
      ).bind(userId, userId, importId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO deepseek_file_cleanup (user_id, file_id, created_at)
         SELECT ?, CAST(input.value AS TEXT), ? FROM json_each(?) input
         WHERE NOT EXISTS (
           SELECT 1 FROM session_deepseek_file_refs refs
           WHERE refs.file_id = CAST(input.value AS TEXT)
         )`
      ).bind(
        userId,
        Date.now(),
        JSON.stringify(oldDeepSeekFiles.results.map((row) => row.file_id))
      ),
      env.DB.prepare('DELETE FROM import_sessions WHERE user_id = ? AND import_id = ?').bind(
        userId,
        importId
      ),
      env.DB.prepare('DELETE FROM import_file_refs WHERE user_id = ? AND import_id = ?').bind(
        userId,
        importId
      ),
      env.DB.prepare('DELETE FROM imports WHERE user_id = ? AND import_id = ?').bind(
        userId,
        importId
      ),
    ])
    if (batch.some((result) => !result.success)) {
      return error('history_replace_failed', 500)
    }
    await collectOrphans(userId, env, [
      ...oldRefs.results.map((row) => row.content_hash),
      ...oldFiles.results.map((row) => row.content_hash),
      ...oldPendingFiles.results.map((row) => row.content_hash),
      ...stagedFiles.results.map((row) => row.content_hash),
    ])
    const page = await sessionPage(userId, env, new URL(`${url.origin}/api/sessions?limit=${url.searchParams.get('limit') ?? '40'}`))
    return page
      ? json({ ...page, totalCount: importedCount?.count ?? 0 })
      : error('invalid_cursor', 400)
  }

  if (importMatch) {
    const importId = decodeURIComponent(importMatch[1])
    const sessionId = importMatch[2] ? decodeURIComponent(importMatch[2]) : null
    if (!sessionId && method === 'PUT') {
      const stale = await env.DB.prepare(
        `SELECT import_id FROM imports WHERE user_id = ? AND created_at < ?
         ORDER BY created_at ASC`
      )
        .bind(userId, Date.now() - 24 * 60 * 60 * 1000)
        .all<{ import_id: string }>()
      const staleHashes: string[] = []
      for (const old of stale.results) {
        const files = await env.DB.prepare(
          'SELECT content_hash FROM import_file_refs WHERE user_id = ? AND import_id = ?'
        )
          .bind(userId, old.import_id)
          .all<{ content_hash: string }>()
        staleHashes.push(...files.results.map((row) => row.content_hash))
        await env.DB.batch([
          env.DB.prepare('DELETE FROM import_sessions WHERE user_id = ? AND import_id = ?').bind(
            userId,
            old.import_id
          ),
          env.DB.prepare('DELETE FROM import_file_refs WHERE user_id = ? AND import_id = ?').bind(
            userId,
            old.import_id
          ),
          env.DB.prepare('DELETE FROM imports WHERE user_id = ? AND import_id = ?').bind(
            userId,
            old.import_id
          ),
        ])
      }
      await collectOrphans(userId, env, staleHashes)
      await env.DB.prepare(
        `INSERT INTO imports (user_id, import_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id, import_id) DO UPDATE SET created_at = excluded.created_at`
      )
        .bind(userId, importId, Date.now())
        .run()
      return new Response(null, { status: 204 })
    }
    if (!sessionId && method === 'DELETE') {
      const activeImport = await env.DB.prepare(
        'SELECT 1 AS found FROM imports WHERE user_id = ? AND import_id = ?'
      )
        .bind(userId, importId)
        .first<{ found: number }>()
      if (!activeImport) {
        return new Response(null, { status: 204 })
      }
      const stagedFiles = await env.DB.prepare(
        'SELECT content_hash FROM import_file_refs WHERE user_id = ? AND import_id = ?'
      )
        .bind(userId, importId)
        .all<{ content_hash: string }>()
      await env.DB.prepare('DELETE FROM import_sessions WHERE user_id = ? AND import_id = ?')
        .bind(userId, importId)
        .run()
      await env.DB.prepare('DELETE FROM import_file_refs WHERE user_id = ? AND import_id = ?')
        .bind(userId, importId)
        .run()
      await env.DB.prepare('DELETE FROM imports WHERE user_id = ? AND import_id = ?')
        .bind(userId, importId)
        .run()
      await collectOrphans(userId, env, stagedFiles.results.map((row) => row.content_hash))
      return new Response(null, { status: 204 })
    }
    if (sessionId && method === 'PUT') {
      const activeImport = await env.DB.prepare(
        'SELECT 1 AS found FROM imports WHERE user_id = ? AND import_id = ?'
      )
        .bind(userId, importId)
        .first<{ found: number }>()
      if (!activeImport) {
        return error('import_not_found', 404)
      }
      const session = await parseSession(request)
      if (!session || session.id !== sessionId) {
        return error('invalid_session', 400)
      }
      await env.DB.prepare(
        `INSERT INTO import_sessions (user_id, import_id, session_id, title, created_at, updated_at, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, import_id, session_id) DO UPDATE SET
           title = excluded.title, created_at = excluded.created_at,
           updated_at = excluded.updated_at, data_json = excluded.data_json`
      )
        .bind(
          userId,
          importId,
          session.id,
          session.title,
          session.createdAt,
          session.updatedAt,
          JSON.stringify(session)
        )
        .run()
      return new Response(null, { status: 204 })
    }
  }

  return error('not_found', 404)
}

const handle = async (request: Request, env: Env) => {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/')) {
    return env.ASSETS.fetch(request)
  }
  const origin = request.headers.get('Origin')
  if (origin && origin !== url.origin && env.DEV_AUTH_BYPASS !== 'true') {
    return error('origin_not_allowed', 403)
  }
  const verification =
    env.DEV_AUTH_BYPASS === 'true'
      ? { identity: { userId: 'local-dev' }, reason: null }
      : await verifyAccessIdentity(request, env)
  if (!verification.identity) {
    return json({ error: 'cloudflare_access_required', reason: verification.reason }, 401)
  }
  try {
    return await routeApi(request, env, verification.identity.userId)
  } catch (cause) {
    console.error('[worker] request failed', cause)
    return error('internal_error', 500)
  }
}

export default {
  fetch(request: Request, env: Env) {
    return handle(request, env)
  },
}
