import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Session } from './types.js'
import * as db from './db.js'

interface LegacyChatDB extends DBSchema {
  sessions: { key: string; value: Session }
  files: { key: string; value: { id: string; blob: Blob } }
}

const migrationRequest = async (path: string, method: string) => {
  const response = await fetch(`/api${path}`, { method, credentials: 'include' })
  if (!response.ok) {
    throw new Error(`Legacy migration request failed: ${response.status} ${response.statusText}`)
  }
  return response
}

const removeLegacyDatabase = () =>
  new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase('chat-demo')
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })

/** 首次登录时将原 IndexedDB 会话和附件并入当前 Access 身份；成功后清除旧库。 */
export const migrateLegacyChat = async () => {
  const status = await (await migrationRequest('/migration', 'GET')).json()
  if ((status as { complete?: boolean }).complete) {
    return
  }

  let legacy: IDBPDatabase<LegacyChatDB> | undefined
  try {
    legacy = await openDB<LegacyChatDB>('chat-demo')
    if (legacy.objectStoreNames.contains('sessions')) {
      const uploaded = new Set<string>()
      for (const id of await legacy.getAllKeys('sessions')) {
        const session = await legacy.get('sessions', id)
        if (!session) {
          continue
        }
        const fileIds = [
          ...new Set(
            session.messages.flatMap((message) =>
              message.role === 'user' ? message.files.map((file) => file.id) : []
            )
          ),
        ]
        const files: db.StoredFile[] = []
        for (const id of fileIds) {
          if (uploaded.has(id)) {
            continue
          }
          const stored = legacy.objectStoreNames.contains('files')
            ? await legacy.get('files', id)
            : undefined
          if (stored) {
            files.push(stored)
            uploaded.add(id)
          }
        }
        await db.saveSession(session, files)
      }
    }
  } finally {
    legacy?.close()
  }

  await migrationRequest('/migration/complete', 'POST')
  await removeLegacyDatabase()
}
