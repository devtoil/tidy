import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_PORT = 7787
export const HOST = '127.0.0.1'

export const ROOT = process.env.TIDY_HOME ?? join(homedir(), '.tidy')
export const INBOX = join(ROOT, 'inbox')
export const ARCHIVE = join(ROOT, 'archive')
export const SHOTS = join(ROOT, 'shots')
const CONFIG_FILE = join(ROOT, 'config.json')

const DEFAULTS = {
  port: DEFAULT_PORT,
  // Origins allowed to POST feedback. localhost/127.0.0.1 (any port) and
  // bookmarklet `null` origins are always allowed; this list is for deployed
  // hosts you also want to comment on (staging, production).
  origins: [],
  anyOrigin: false,
}

export function ensureDirs() {
  for (const dir of [ROOT, INBOX, ARCHIVE, SHOTS]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export function readConfig() {
  ensureDirs()
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function writeConfig(config) {
  ensureDirs()
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

export function isOriginAllowed(origin, config) {
  if (config.anyOrigin) return true
  // A bookmarklet on a file:// page, or a request with no Origin header at all
  // (curl, the CLI itself), reports `null` or nothing.
  if (origin === undefined || origin === '' || origin === 'null') return true
  if (origin.startsWith('chrome-extension://')) return true
  if (LOCAL_ORIGIN.test(origin)) return true
  return config.origins.includes(origin)
}
