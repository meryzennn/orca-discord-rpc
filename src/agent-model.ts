import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * The model an agent is running. Orca does not report it, so this reads the agent's own
 * session logs for Claude Code, Codex, and Oh My Pi.
 */

/** Scan backwards in small blocks so long turns don't hide their model metadata. */
const TAIL_BYTES = 64 * 1024
const MODEL_OVERLAP_BYTES = 1024
/** Why so small: Codex writes the folder near the start of its first line. */
const HEAD_BYTES = 16 * 1024
/** Only recent sessions can be live; avoid reading every stored transcript. */
const SESSIONS_SCANNED = 50

/** Matches only a real JSON key; a model name quoted inside a message is escaped and never matches. */
const MODEL_FIELD = /"model":"([^"]+)"/g
const CWD_FIELD = /"cwd":("(?:[^"\\]|\\.)*")/

const IS_WINDOWS = process.platform === 'win32'

export type AgentModelSources = {
  env: (name: string) => string | undefined
  home: string
}

const defaultSources: AgentModelSources = { env: (name) => process.env[name], home: homedir() }

export function findAgentModel(
  agentType: string | null,
  worktreePath: string | null,
  sources: AgentModelSources = defaultSources
): string | null {
  if (!agentType || !worktreePath) {
    return null
  }
  try {
    let log: string | null
    if (agentType === 'claude' || agentType === 'claude-agent-teams') {
      log = newestClaudeSession(nonEmpty(sources.env('CLAUDE_CONFIG_DIR')) ?? join(sources.home, '.claude'), worktreePath)
    } else if (agentType === 'codex') {
      const codexHome = nonEmpty(sources.env('CODEX_HOME')) ?? join(sources.home, '.codex')
      log = newestWorkspaceSession(join(codexHome, 'sessions'), worktreePath, 'codex')
    } else if (agentType === 'omp') {
      const agentDir = nonEmpty(sources.env('PI_CODING_AGENT_DIR')) ?? join(sources.home, '.omp', 'agent')
      log = newestWorkspaceSession(join(agentDir, 'sessions'), worktreePath, 'omp')
    } else {
      return null
    }
    const raw = log === null ? null : readLastModel(log)
    return raw === null ? null : prettyModelName(raw)
  } catch {
    // Why swallowed: an unreadable log must cost only the model name, never the presence.
    return null
  }
}

/** Claude Code names a project folder after its path, with every other character a dash. */
export function claudeProjectSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
}

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

/** "claude-opus-5-5" becomes "Claude Opus 5.5", "gpt-5.1-codex" becomes "GPT-5.1 Codex". */
export function prettyModelName(raw: string): string {
  let id = raw.trim()
  const bracket = id.indexOf('[')
  if (bracket > 0) {
    id = id.slice(0, bracket)
  }
  // Why: a router prefixes the provider, as in "anthropic/claude-haiku-4-5".
  id = id.slice(id.lastIndexOf('/') + 1)

  const parts = id.split(/[-_]/).filter((part) => part.length > 0)
  if (parts.length > 1 && /^[0-9]{8}$/.test(parts[parts.length - 1] ?? '')) {
    parts.pop()
  }

  const words: string[] = []
  for (const part of parts) {
    const previous = words[words.length - 1]
    if (previous !== undefined && isVersion(part) && isVersion(previous)) {
      words[words.length - 1] = `${previous}.${part}`
    } else if (previous === 'GPT' && /^[0-9]/.test(part)) {
      words[words.length - 1] = `GPT-${part}`
    } else if (part.toLowerCase() === 'gpt') {
      words.push('GPT')
    } else {
      words.push(part[0]!.toUpperCase() + part.slice(1))
    }
  }
  return words.join(' ')
}

function isVersion(part: string): boolean {
  return /^[0-9.]+$/.test(part)
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

/** Why case-insensitive only on Windows: there one folder can appear as both D: and d:. */
function samePath(a: string, b: string): boolean {
  return IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b
}

function newestOf(files: string[]): string | null {
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

function newestClaudeSession(claudeHome: string, worktreePath: string): string | null {
  const projects = join(claudeHome, 'projects')
  if (!existsSync(projects)) {
    return null
  }
  const slug = claudeProjectSlug(worktreePath.replace(/[/\\]+$/, ''))
  const files = readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && samePath(entry.name, slug))
    .flatMap((entry) =>
      readdirSync(join(projects, entry.name))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => join(projects, entry.name, name))
    )
  return newestOf(files)
}

function newestWorkspaceSession(sessions: string, worktreePath: string, layout: 'codex' | 'omp'): string | null {
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

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function readLastModel(path: string): string | null {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES))
    let position = Math.max(0, size - TAIL_BYTES)
    while (true) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position)
      const model = lastModelIn(buffer.toString('utf8', 0, read))
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
