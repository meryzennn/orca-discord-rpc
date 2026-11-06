import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelResolver } from './types.ts'
import { lastModelIn, newestOf, nonEmpty, readLastModel, samePath } from './session-files.ts'

/** Claude Code names a project folder after its path, with every other character a dash. */
export function claudeProjectSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-')
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

export const resolveClaudeModel: ModelResolver = (worktreePath, sources) => {
  const log = newestClaudeSession(nonEmpty(sources.env('CLAUDE_CONFIG_DIR')) ?? join(sources.home, '.claude'), worktreePath)
  return log === null ? null : readLastModel(log, lastModelIn)
}
