import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST, readConfig, writeConfig } from './config.mjs'
import { formatDetail, formatSummary } from './format.mjs'
import { installPlugin, menubarHelp, renderMenubar } from './menubar.mjs'
import { runMcp } from './mcp.mjs'
import { startCollector } from './server.mjs'
import { clearFeedback, getFeedback, listFeedback, paths, resolveFeedback, waitForFeedback } from './store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXTENSION_DIR = join(HERE, '..', 'extension')

const HELP = `tidy — send page feedback from any browser tab to a Claude Code session

Usage
  tidy serve [--port N]     Run the collector (browser posts here). Ctrl-C to stop.
  tidy mcp                  Speak MCP on stdio (for .mcp.json) and run the collector.
  tidy list [--status S]    List feedback (S: pending | resolved | all)
  tidy show <id>            Print one item in full
  tidy watch                Print items as they arrive
  tidy resolve <id> [note]  Mark an item handled
  tidy clear [--all]        Resolve everything pending (--all also deletes the archive)
  tidy allow <origin>       Let a deployed site (https://app.example.com) post feedback
  tidy origins              Show the allowed-origin list
  tidy extension            Where to point Chrome's "Load unpacked"
  tidy menubar [--install D] Render the inbox as an xbar/SwiftBar menu
  tidy where                Print the inbox paths

Options
  --json                           Machine-readable output for list/show
  --port N                         Collector port (default 7787)
`

function flag(argv, name) {
  return argv.includes(`--${name}`)
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

export async function run(argv) {
  const [command = 'help', ...rest] = argv

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP)
    return
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    process.stdout.write('tidy 0.1.0\n')
    return
  }

  if (command === 'mcp') {
    await runMcp()
    return
  }

  if (command === 'serve') {
    const port = option(rest, 'port') === undefined ? undefined : Number(option(rest, 'port'))
    const collector = await startCollector({
      port,
      onSaved: (item) => process.stdout.write(`\n${formatSummary(item)}\n`),
    })
    if (!collector.listening) {
      process.stderr.write(`tidy: port ${collector.port} is already in use — another collector is probably running.\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(
      `tidy collector: http://${HOST}:${collector.port}\n` +
        `  setup + bookmarklet: http://${HOST}:${collector.port}/\n` +
        `  extension to load:   ${EXTENSION_DIR}\n` +
        `  inbox:               ${paths.INBOX}\n\nWaiting for feedback…\n`,
    )
    return
  }

  if (command === 'list') {
    const status = option(rest, 'status') ?? 'pending'
    const items = listFeedback({ status, limit: Number(option(rest, 'limit') ?? 50) })
    if (flag(rest, 'json')) {
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`)
      return
    }
    if (items.length === 0) {
      process.stdout.write(`No ${status} feedback.\n`)
      return
    }
    process.stdout.write(`${items.map(formatSummary).join('\n\n')}\n`)
    return
  }

  if (command === 'show') {
    const item = getFeedback(rest[0])
    if (item === undefined) {
      process.stderr.write(`No feedback with id ${rest[0]}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(flag(rest, 'json') ? `${JSON.stringify(item, null, 2)}\n` : `${formatDetail(item)}\n`)
    return
  }

  if (command === 'watch') {
    process.stdout.write('Watching for feedback (ctrl-c to stop)…\n')
    let since = new Date().toISOString()
    for (;;) {
      const items = await waitForFeedback({ sinceIso: since, timeoutMs: 60_000 })
      for (const item of items) {
        process.stdout.write(`\n${formatSummary(item)}\n`)
        since = item.createdAt > since ? item.createdAt : since
      }
    }
  }

  if (command === 'resolve') {
    const item = resolveFeedback(rest[0], rest.slice(1).join(' '))
    if (item === undefined) {
      process.stderr.write(`No pending feedback with id ${rest[0]}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(`Resolved ${item.id}\n`)
    return
  }

  if (command === 'clear') {
    const removed = clearFeedback({ includeResolved: flag(rest, 'all') })
    process.stdout.write(`Cleared ${removed} item(s).\n`)
    return
  }

  if (command === 'allow') {
    const origin = rest[0]
    if (origin === undefined) {
      process.stderr.write('Usage: tidy allow https://app.example.com\n')
      process.exitCode = 1
      return
    }
    const config = readConfig()
    if (!config.origins.includes(origin)) config.origins.push(origin)
    writeConfig(config)
    process.stdout.write(`Allowed ${origin}. Restart \`tidy serve\` to pick it up.\n`)
    return
  }

  if (command === 'origins') {
    const config = readConfig()
    process.stdout.write(
      `localhost and 127.0.0.1 (any port) are always allowed.\nAlso allowed: ${config.origins.length === 0 ? '(none)' : config.origins.join(', ')}\n`,
    )
    return
  }

  if (command === 'extension') {
    process.stdout.write(
      `Load unpacked from:\n  ${EXTENSION_DIR}\n\n1. chrome://extensions\n2. Enable Developer mode\n3. Load unpacked → the path above\n4. Alt+Shift+F on any page\n`,
    )
    return
  }

  if (command === 'menubar') {
    const dir = option(argv, 'install')
    if (flag(argv, 'install') && dir === undefined) {
      process.stderr.write(menubarHelp)
      process.exitCode = 1
      return
    }
    if (dir !== undefined) {
      const file = installPlugin(dir, { port: Number(option(argv, 'port') ?? 0) || undefined })
      process.stdout.write(`Wrote ${file}\nRefresh SwiftBar/xbar to pick it up.\n`)
      return
    }
    process.stdout.write(await renderMenubar({ port: Number(option(argv, 'port') ?? 0) || undefined }))
    return
  }

  if (command === 'where') {
    process.stdout.write(`root:    ${paths.ROOT}\ninbox:   ${paths.INBOX}\narchive: ${paths.ARCHIVE}\nshots:   ${paths.SHOTS}\n`)
    return
  }

  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
  process.exitCode = 1
}
