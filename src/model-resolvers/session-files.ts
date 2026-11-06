import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Scan backwards in small blocks so long turns don't hide their model metadata. */
export const TAIL_BYTES = 64 * 1024
export const MODEL_OVERLAP_BYTES = 1024
/** Why so small: Codex writes the folder near the start of its first line. */
const HEAD_BYTES = 16 * 1024
/** Only recent sessions can be live; avoid reading every stored transcript. */
const SESSIONS_SCANNED = 50

/** Matches only a real JSON key; a model name quoted inside a message is escaped and never matches. */
const MODEL_FIELD = /"model":"([^"]+)"/g
const CWD_FIELD = /"cwd":("(?:[^"\\]|\\.)*")/

const IS_WINDOWS = process.platform === 'win32'

export function lastModelIn(text: string): string | null {
  let last: string | null = null
  for (const match of text.matchAll(MODEL_FIELD)) {
    const value = match[1] ?? ''
    // Why skipped: Claude Code marks its own injected messages as "<synthetic>".
    if (!value.startsWith('<')) {
      last = value
    }
  }
  return last
}

export function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

/** Why case-insensitive only on Windows: there one folder can appear as both D: and d:. */
export function samePath(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function newestOf(files: string[]): string | null {
  let best: string | null = null
  let bestAt = -Infinity
  for (const file of files) {
    const at = statSync(file).mtimeMs
    if (at > bestAt) {
      best = file
      bestAt = at
    }
  }
  return best
}

/** Newest recent session whose recorded `cwd` is the workspace, for the Codex and OMP layouts. */
export function newestWorkspaceSession(sessions: string, worktreePath: string, layout: 'codex' | 'omp'): string | null {
  if (!existsSync(sessions)) {
    return null
  }
  const wanted = normalizePath(worktreePath)
  const names = layout === 'codex'
    ? readdirSync(sessions, { recursive: true, encoding: 'utf8' })
      .filter(name => basename(name).startsWith('rollout-') && name.endsWith('.jsonl'))
    : readdirSync(sessions, { withFileTypes: true }).flatMap(bucket => bucket.isDirectory()
      ? readdirSync(join(sessions, bucket.name), { withFileTypes: true })
        .filter(file => file.isFile() && file.name.endsWith('.jsonl'))
        .map(file => join(bucket.name, file.name))
      : [])
  const recent = names
    .map((name) => {
      const file = join(sessions, name)
      return { file, at: statSync(file).mtimeMs }
    })
    .sort((a, b) => b.at - a.at)
    .slice(0, SESSIONS_SCANNED)
  for (const { file } of recent) {
    const cwd = CWD_FIELD.exec(readSlice(file, 'head', HEAD_BYTES))?.[1]
    if (cwd !== undefined && samePath(normalizePath(JSON.parse(cwd) as string), wanted)) {
      return file
    }
  }
  return null
}

export function readLastModel(path: string, parse: (text: string) => string | null): string | null {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
    let position = Math.max(0, size - TAIL_BYTES)
    while (true) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position)
      const model = parse(buffer.toString('utf8', 0, read))
      if (model !== null || position === 0) return model
      // Overlap keeps an identifier split across block boundaries intact.
      position = Math.max(0, position - TAIL_BYTES + MODEL_OVERLAP_BYTES)
    }
  } finally { closeSync(fd) }
}

function readSlice(path: string, end: 'head' | 'tail', bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const length = Math.min(bytes, size)
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, end === 'tail' ? size - length : 0)
    return buffer.toString('utf8', 0, read)
  } finally {
    closeSync(fd)
  }
}
