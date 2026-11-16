export type ChatRoute = { sessionId: string | null; valid: boolean }

export const readChatRoute = (pathname = window.location.pathname): ChatRoute => {
  if (pathname === '/' || pathname === '') {
    return { sessionId: null, valid: true }
  }
  const match = /^\/chat\/([^/]+)\/?$/.exec(pathname)
  if (!match) {
    return { sessionId: null, valid: false }
  }
  try {
    return { sessionId: decodeURIComponent(match[1]), valid: true }
  } catch {
    return { sessionId: null, valid: false }
  }
}

export const writeChatRoute = (sessionId: string | null, replace = false) => {
  if (typeof window === 'undefined') {
    return
  }
  const pathname = sessionId ? `/chat/${encodeURIComponent(sessionId)}` : '/'
  if (window.location.pathname === pathname && !window.location.search && !window.location.hash) {
    return
  }
  const method = replace ? 'replaceState' : 'pushState'
  window.history[method]({ sessionId }, '', pathname)
}
