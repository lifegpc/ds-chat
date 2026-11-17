import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import type { ReasoningEffort } from './api/types.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 用户设置由 Workers API 写入 D1；API Key 在 Worker 端加密后保存。 */
export type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  safetyCheck: boolean
  thinking: boolean
  expertMode: boolean
  effort: ReasoningEffort
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  safetyCheck: 'chat-demo:safety-check',
  thinking: 'chat-demo:thinking',
  expertMode: 'chat-demo:expert-mode',
  effort: 'chat-demo:reasoning-effort',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')
const initialEffort = (): ReasoningEffort => {
  const saved = read(KEYS.effort)
  return saved === 'low' || saved === 'max' ? saved : 'high'
}

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  // Keep the existing behavior: content safety checks were previously always enabled.
  safetyCheck: read(KEYS.safetyCheck) !== 'false',
  thinking: read(KEYS.thinking) === 'true',
  expertMode: read(KEYS.expertMode) === 'true',
  effort: initialEffort(),
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

const settingsApi = async (method: 'GET' | 'PUT', value?: Settings) => {
  const response = await fetch('/api/settings', {
    method,
    credentials: 'include',
    ...(value
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }
      : {}),
  })
  if (!response.ok) {
    throw new Error(`Settings request failed: ${response.status} ${response.statusText}`)
  }
  return method === 'GET'
    ? ((await response.json()) as { settings: Settings | null }).settings
    : null
}

let initialization: Promise<void> | undefined
let writeQueue: Promise<void> = Promise.resolve()

const persistSettings = () => {
  writeQueue = writeQueue
    .catch(() => {})
    .then(async () => {
      await settingsApi('PUT', useSettings.getState())
    })
  return writeQueue
}

/** 迁移已有浏览器偏好到当前 Access 身份，并读取该身份的云端设置。 */
export const initSettings = (): Promise<void> => {
  if (initialization) {
    return initialization
  }
  initialization = (async () => {
    const remote = await settingsApi('GET')
    if (remote) {
      useSettings.setState({
        ...useSettings.getState(),
        ...remote,
        location: normalizeLocation(remote.location),
      })
    } else {
      await settingsApi('PUT', useSettings.getState())
    }
    for (const key of Object.values(KEYS)) {
      try {
        localStorage.removeItem(key)
      } catch {
        // 无持久化权限时，远端设置仍正常可用。
      }
    }
  })().finally(() => {
    initialization = undefined
  })
  return initialization
}

const reportSettingsError = (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[settings] save failed', error)
}

export const setLocale = (locale: Locale) => {
  useSettings.setState({ locale })
  void persistSettings().catch(reportSettingsError)
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  useSettings.setState({ location })
  void persistSettings().catch(reportSettingsError)
}

export const setThemePreference = (themePreference: ThemePreference) => {
  useSettings.setState({ themePreference })
  void persistSettings().catch(reportSettingsError)
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  useSettings.setState({ ttsVoice })
  void persistSettings().catch(reportSettingsError)
}

export const setSafetyCheck = (safetyCheck: boolean) => {
  useSettings.setState({ safetyCheck })
  void persistSettings().catch(reportSettingsError)
}

export const setApiKey = async (apiKey: string | null) => {
  const previous = useSettings.getState().apiKey
  useSettings.setState({ apiKey })
  try {
    await persistSettings()
  } catch (error) {
    useSettings.setState({ apiKey: previous })
    throw error
  }
}

export const setThinking = (thinking: boolean) => {
  useSettings.setState({ thinking })
  void persistSettings().catch(reportSettingsError)
}

export const setExpertMode = (expertMode: boolean) => {
  useSettings.setState({ expertMode })
  void persistSettings().catch(reportSettingsError)
}

export const setEffort = (effort: ReasoningEffort) => {
  useSettings.setState({ effort })
  void persistSettings().catch(reportSettingsError)
}

export const setSearch = (search: boolean) => {
  useSettings.setState({ search })
  void persistSettings().catch(reportSettingsError)
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  useSettings.setState({ siderCollapsed })
  void persistSettings().catch(reportSettingsError)
}
