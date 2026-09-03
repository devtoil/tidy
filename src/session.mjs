/** Names the Claude Code session that owns the collector, for the overlay to show. */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

function findGitDir(from) {
  let dir = resolve(from)
  for (let depth = 0; depth < 40; depth += 1) {
    const candidate = join(dir, '.git')
    if (existsSync(candidate)) {
      // A worktree or submodule checkout has `.git` as a file: "gitdir: <path>".
      if (statSync(candidate).isFile()) {
        const pointer = readFileSync(candidate, 'utf8').trim()
        const match = /^gitdir:\s*(.+)$/.exec(pointer)
        if (match === null) return undefined
        const target = resolve(dir, match[1])
        return existsSync(target) ? target : undefined
      }
      return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

// Best-effort: an unreadable HEAD degrades the label. The collector must start regardless.
function readBranch(cwd) {
  try {
    const gitDir = findGitDir(cwd)
    if (gitDir === undefined) return undefined
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    // Detached HEAD holds a bare sha.
    return match === null ? (/^[0-9a-f]{7,40}$/.test(head) ? head.slice(0, 7) : undefined) : match[1]
  } catch {
    return undefined
  }
}

export function describeSession(cwd = process.cwd()) {
  const override = process.env.TIDY_SESSION_NAME?.trim()
  if (override !== undefined && override !== '') return { label: override }

  const project = basename(resolve(cwd))
  const branch = readBranch(cwd)
  return { label: branch === undefined ? project : `${project} · ${branch}` }
}
