import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST, isOriginAllowed, readConfig } from './config.mjs'
import { describeSession } from './session.mjs'
import { countPending, getFeedback, listFeedback, resolveFeedback, saveFeedback } from './store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OVERLAY_FILE = join(HERE, '..', 'extension', 'overlay.js')
const MAX_BODY = 16 * 1024 * 1024

// /health must answer every origin — it is how a page learns it is not allowed.
// The exemption lives here so the `vary` that pairs with an echoed origin cannot
// be forgotten by the route.
const PUBLIC_ROUTES = new Set(['/health'])

function cors(request, response, config, isPublic = false) {
  const origin = request.headers.origin
  if (isPublic || isOriginAllowed(origin, config)) {
    response.setHeader('access-control-allow-origin', origin ?? '*')
    response.setHeader('vary', 'origin')
  }
  response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  response.setHeader('access-control-allow-headers', 'content-type')
  // Chrome's Private Network Access check: an https page reaching 127.0.0.1
  // preflights and needs this header back or the POST never happens.
  response.setHeader('access-control-allow-private-network', 'true')
}

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  response.end(payload)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('payload too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function bookmarkletSource(endpoint, channel) {
  const settings = JSON.stringify({ endpoint, channel, source: 'bookmarklet' })
  return `window.__tidyConfig = ${settings};\n${readFileSync(OVERLAY_FILE, 'utf8')}\nwindow.__tidy.toggle();\n`
}

function setupPage(endpoint) {
  const loader = `javascript:(function(){var s=document.createElement('script');s.src='${endpoint}/bookmarklet.js?t='+Date.now();document.documentElement.appendChild(s);})()`
  const extensionPath = join(HERE, '..', 'extension')
  return `<!doctype html><html><head><meta charset="utf-8"><title>tidy</title><style>
    body{font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#111827}
    h1{font-size:22px} h2{font-size:16px;margin-top:32px}
    code,pre{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f3f4f6;border-radius:6px}
    code{padding:1px 5px} pre{padding:10px 12px;overflow:auto}
    a.bm{display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:600}
    .muted{color:#6b7280;font-size:13px}
  </style></head><body>
    <h1>tidy collector</h1>
    <p>Running at <code>${endpoint}</code>. Feedback you send from a page lands in a local inbox that a Claude Code session reads.</p>
    <h2>Option A — Chrome extension (recommended, supports screenshots)</h2>
    <ol>
      <li>Open <code>chrome://extensions</code> and turn on <b>Developer mode</b>.</li>
      <li><b>Load unpacked</b> → choose <code>${extensionPath}</code></li>
      <li>Press <code>Alt+Shift+F</code> on any page, or click the toolbar icon.</li>
    </ol>
    <h2>Option B — bookmarklet (no install, no screenshots)</h2>
    <p>Drag this to your bookmarks bar, then click it on any page:</p>
    <p><a class="bm" href="${loader.replace(/"/g, '&quot;')}">Send feedback</a></p>
    <p class="muted">Bookmarklets can't call Chrome's capture API, so items arrive with element metadata and your comment but no image.</p>
    <h2>Reading the inbox</h2>
    <pre>tidy list        # pending items
tidy show &lt;id&gt;   # one item in full
tidy watch       # stream new items</pre>
    <p>Or let Claude read them over MCP — see the package README.</p>
  </body></html>`
}

export function createCollector({ onSaved, port } = {}) {
  const config = readConfig()
  const endpoint = `http://${HOST}:${port ?? config.port}`

  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${HOST}`)
    cors(request, response, config, PUBLIC_ROUTES.has(url.pathname))

    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    if (url.pathname === '/health') {
      // The label is withheld until the origin earns it.
      const allowed = isOriginAllowed(request.headers.origin, config)
      json(response, 200, {
        ok: true,
        name: 'tidy',
        originAllowed: allowed,
        pending: allowed ? countPending() : 0,
        session: allowed ? describeSession() : undefined,
      })
      return
    }

    if (url.pathname === '/overlay.js' || url.pathname === '/bookmarklet.js') {
      const body =
        url.pathname === '/overlay.js'
          ? readFileSync(OVERLAY_FILE, 'utf8')
          : bookmarkletSource(endpoint, url.searchParams.get('channel') ?? undefined)
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      response.end(body)
      return
    }

    if (url.pathname === '/' && request.method === 'GET') {
      const body = setupPage(endpoint)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(body)
      return
    }

    if (url.pathname === '/api/feedback' && request.method === 'GET') {
      json(response, 200, {
        items: listFeedback({
          status: url.searchParams.get('status') ?? 'pending',
          channel: url.searchParams.get('channel') ?? undefined,
        }),
      })
      return
    }

    if (url.pathname === '/api/feedback' && request.method === 'POST') {
      const origin = request.headers.origin
      if (!isOriginAllowed(origin, config)) {
        json(response, 403, {
          error: `Origin ${origin} is not allowed. Run: tidy allow ${origin}`,
        })
        return
      }
      readBody(request)
        .then((payload) => {
          const item = saveFeedback(payload)
          onSaved?.(item)
          json(response, 201, { id: item.id })
        })
        .catch((error) => json(response, 400, { error: error.message }))
      return
    }

    const resolveMatch = /^\/api\/feedback\/([\w-]+)\/resolve$/.exec(url.pathname)
    if (resolveMatch !== null && request.method === 'POST') {
      readBody(request)
        .then((payload) => {
          const item = resolveFeedback(resolveMatch[1], payload.note)
          if (item === undefined) json(response, 404, { error: 'not found' })
          else json(response, 200, { id: item.id, status: item.status })
        })
        .catch((error) => json(response, 400, { error: error.message }))
      return
    }

    const getMatch = /^\/api\/feedback\/([\w-]+)$/.exec(url.pathname)
    if (getMatch !== null && request.method === 'GET') {
      const item = getFeedback(getMatch[1])
      if (item === undefined) json(response, 404, { error: 'not found' })
      else json(response, 200, item)
      return
    }

    json(response, 404, { error: 'not found' })
  })
}

/**
 * Binds the collector, or resolves `{ listening: false }` when another process
 * already owns the port — the file-backed inbox is shared, so a second session
 * still reads everything the first one collects.
 */
export function startCollector(options = {}) {
  const config = readConfig()
  const port = options.port ?? config.port
  const server = createCollector({ ...options, port })
  return new Promise((resolve) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve({ listening: false, port, server: undefined })
      else resolve({ listening: false, port, error, server: undefined })
    })
    server.listen(port, HOST, () => resolve({ listening: true, port, server }))
  })
}
