import type { Session, SessionSummary } from './types.js'

/** 附件在 R2 中按内容哈希保存，file id 仅用于应用内引用。 */
export type StoredFile = { id: string; blob: Blob }
export type SessionCursor = { updatedAt: number; id: string }
export type SessionSummaryPage = {
  items: SessionSummary[]
  nextCursor: SessionCursor | null
  totalCount?: number
}

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers)
  if (!(init?.body instanceof Blob) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers,
  })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null)
    const message =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : `${response.status} ${response.statusText}`
    throw new Error(message)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}

const saveFile = async (
  { id, blob }: StoredFile,
  importId?: string | null,
  sessionId?: string
) => {
  const query = new URLSearchParams()
  if (importId) {
    query.set('import', importId)
  }
  if (sessionId) {
    query.set('session', sessionId)
  }
  const suffix = query.size > 0 ? `?${query}` : ''
  await api(`/files/${encodeURIComponent(id)}${suffix}`, {
    method: 'PUT',
    headers: blob.type ? { 'Content-Type': blob.type } : {},
    body: blob,
  })
}

const sessionWrites = new Map<string, Promise<void>>()
const enqueueSessionWrite = <T>(id: string, write: () => Promise<T>): Promise<T> => {
  const previous = sessionWrites.get(id) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(write)
  const queued = current.then(
    () => {},
    () => {}
  )
  sessionWrites.set(id, queued)
  const cleanup = () => {
    if (sessionWrites.get(id) === queued) {
      sessionWrites.delete(id)
    }
  }
  void queued.then(cleanup)
  return current
}

export const flushSessionWrites = async () => {
  await Promise.all(sessionWrites.values())
}

export const loadSessionSummaries = (cursor?: SessionCursor) => {
  const query = new URLSearchParams({ limit: '40' })
  if (cursor) {
    query.set('beforeUpdatedAt', String(cursor.updatedAt))
    query.set('beforeId', cursor.id)
  }
  return api<SessionSummaryPage>(`/sessions?${query}`)
}

export const loadSession = (id: string) =>
  api<Session | undefined>(`/sessions/${encodeURIComponent(id)}`).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'not_found') {
      return undefined
    }
    throw error
  })

export const saveSession = (session: Session, files: StoredFile[] = []) =>
  enqueueSessionWrite(session.id, async () => {
    for (const file of files) {
      await saveFile(file, null, session.id)
    }
    await api(`/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PUT',
      body: JSON.stringify(session),
    })
  })

export const renameSession = (id: string, title: string) =>
  enqueueSessionWrite(id, async () => {
    await api(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    })
  })

export const deleteSession = (id: string) =>
  enqueueSessionWrite(id, async () => {
    await api(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  })

export const loadDeepSeekFileCleanup = async () =>
  (await api<{ fileIds: string[] }>('/deepseek-file-cleanup')).fileIds

export const completeDeepSeekFileCleanup = (fileId: string) =>
  api(`/deepseek-file-cleanup/${encodeURIComponent(fileId)}`, { method: 'DELETE' })

export const saveFiles = async (files: StoredFile[]) => {
  for (const file of files) {
    await saveFile(file)
  }
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(`/api/files/${encodeURIComponent(id)}`, {
      credentials: 'include',
    })
    if (response.status === 404) {
      return undefined
    }
    if (response.status === 503 && attempt < 7) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * (attempt + 1), 1000)))
      continue
    }
    if (!response.ok) {
      throw new Error(`File read failed: ${response.status} ${response.statusText}`)
    }
    return response.blob()
  }
  return undefined
}

let importId: string | null = null
const stagingSessions = new Map<string, Session>()

/** 导入数据先存在 Worker 暂存表，提交时由 D1 原子替换当前用户的会话。 */
export const clearStaging = async () => {
  if (importId) {
    await api(`/imports/${encodeURIComponent(importId)}`, { method: 'DELETE' })
  }
  importId = crypto.randomUUID()
  stagingSessions.clear()
  await api(`/imports/${encodeURIComponent(importId)}`, { method: 'PUT' })
}

export const addStagingSession = async (session: Session) => {
  if (!importId) {
    throw new Error('Import staging has not been initialized')
  }
  stagingSessions.set(session.id, session)
  await api(`/imports/${encodeURIComponent(importId)}/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PUT',
    body: JSON.stringify(session),
  })
}

export const saveStagingFiles = async (files: StoredFile[]) => {
  if (!importId) {
    throw new Error('Import staging has not been initialized')
  }
  for (const file of files) {
    await saveFile(file, importId)
  }
}

export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>) => {
  if (!importId) {
    throw new Error('Import staging has not been initialized')
  }
  for (const [id, original] of stagingSessions) {
    let changed = false
    const session: Session = {
      ...original,
      messages: original.messages.map((message) => {
        if (message.role !== 'user') {
          return message
        }
        let messageChanged = false
        const files = message.files.map((file) => {
          const mimeType = types.get(file.id) ?? ''
          if (file.mimeType === mimeType) {
            return file
          }
          changed = true
          messageChanged = true
          return { ...file, mimeType }
        })
        return messageChanged ? { ...message, files } : message
      }),
    }
    if (changed) {
      stagingSessions.set(id, session)
      await api(`/imports/${encodeURIComponent(importId)}/sessions/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(session),
      })
    }
  }
}

export const commitStaging = async (): Promise<SessionSummaryPage> => {
  if (!importId) {
    throw new Error('Import staging has not been initialized')
  }
  const summaries = await api<SessionSummaryPage>(
    `/imports/${encodeURIComponent(importId)}/commit?limit=40`,
    { method: 'POST' }
  )
  importId = null
  stagingSessions.clear()
  return summaries
}

/** 存储失败在调用方展示可重试状态，控制台保留诊断信息。 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
