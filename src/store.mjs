import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARCHIVE, ensureDirs, INBOX, ROOT, SHOTS } from './config.mjs'

const MAX_COMMENT = 8000
const MAX_HTML = 4000
const MAX_CONSOLE = 25

function clip(value, max) {
  if (typeof value !== 'string') return undefined
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
}

function shortId() {
  return randomUUID().split('-')[0]
}

/** Newest-first list of `{ ...item, _file }` from one directory. */
function readDir(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8'))
      } catch {
        return undefined
      }
    })
    .filter((item) => item !== undefined)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

/** /health only wants the number — reading and parsing every item to get it is waste. */
export function countPending() {
  ensureDirs()
  return readdirSync(INBOX).filter((name) => name.endsWith('.json')).length
}

export function listFeedback({ status = 'pending', channel, limit = 50 } = {}) {
  ensureDirs()
  const items =
    status === 'resolved' ? readDir(ARCHIVE) : status === 'all' ? [...readDir(INBOX), ...readDir(ARCHIVE)] : readDir(INBOX)
  return items.filter((item) => channel === undefined || item.channel === channel).slice(0, limit)
}

export function getFeedback(id) {
  ensureDirs()
  for (const dir of [INBOX, ARCHIVE]) {
    const file = join(dir, `${id}.json`)
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * Normalizes and persists one submission. Everything under `page`, `element`
 * and `comment` is attacker-controllable page content — it is clipped here and
 * labelled untrusted where it is rendered.
 */
export function saveFeedback(payload) {
  ensureDirs()
  const id = shortId()
  const createdAt = new Date().toISOString()

  let screenshot
  const dataUrl = payload.screenshot
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
    const png = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
    const file = join(SHOTS, `${id}.png`)
    writeFileSync(file, png)
    screenshot = file
  }

  const item = {
    id,
    createdAt,
    status: 'pending',
    source: clip(payload.source, 40) ?? 'unknown',
    channel: clip(payload.channel, 120),
    mode: clip(payload.mode, 20) ?? 'page',
    comment: clip(payload.comment, MAX_COMMENT) ?? '',
    page: {
      url: clip(payload.page?.url, 2000),
      title: clip(payload.page?.title, 300),
      viewport: payload.page?.viewport,
      devicePixelRatio: payload.page?.devicePixelRatio,
      userAgent: clip(payload.page?.userAgent, 400),
    },
    element: payload.element === undefined || payload.element === null ? undefined : {
      ...payload.element,
      outerHTML: clip(payload.element.outerHTML, MAX_HTML),
      text: clip(payload.element.text, 600),
    },
    region: payload.region,
    console: Array.isArray(payload.console)
      ? payload.console.slice(-MAX_CONSOLE).map((entry) => ({
          level: clip(entry?.level, 20),
          text: clip(entry?.text, 1000),
          ts: entry?.ts,
        }))
      : [],
    screenshot,
  }

  writeFileSync(join(INBOX, `${id}.json`), `${JSON.stringify(item, null, 2)}\n`)
  return item
}

export function resolveFeedback(id, note) {
  const file = join(INBOX, `${id}.json`)
  if (!existsSync(file)) return undefined
  const item = { ...JSON.parse(readFileSync(file, 'utf8')), status: 'resolved', resolvedAt: new Date().toISOString() }
  if (typeof note === 'string' && note !== '') item.resolution = clip(note, 2000)
  writeFileSync(file, `${JSON.stringify(item, null, 2)}\n`)
  renameSync(file, join(ARCHIVE, `${id}.json`))
  return item
}

export function clearFeedback({ includeResolved = false } = {}) {
  ensureDirs()
  let removed = 0
  for (const item of listFeedback({ status: 'pending', limit: Infinity })) {
    resolveFeedback(item.id, 'cleared from the CLI')
    removed += 1
  }
  if (includeResolved) {
    for (const item of readDir(ARCHIVE)) {
      unlinkSync(join(ARCHIVE, `${item.id}.json`))
      if (item.screenshot !== undefined && existsSync(item.screenshot)) unlinkSync(item.screenshot)
      removed += 1
    }
  }
  return removed
}

/**
 * Resolves with items created after `sinceIso`, polling so that it sees writes
 * from a collector running in another process. Resolves empty on timeout.
 */
export async function waitForFeedback({ sinceIso, channel, timeoutMs = 60_000, pollMs = 400 }) {
  const deadline = Date.now() + timeoutMs
  const since = sinceIso ?? new Date().toISOString()
  for (;;) {
    const fresh = listFeedback({ status: 'pending', channel, limit: 50 }).filter((item) => item.createdAt > since)
    if (fresh.length > 0) return fresh.reverse()
    if (Date.now() >= deadline) return []
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export const paths = { ROOT, INBOX, ARCHIVE, SHOTS }
