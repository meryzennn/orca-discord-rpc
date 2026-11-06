import { join } from 'node:path'
import type { ModelResolver } from './types.ts'
import { lastModelIn, newestWorkspaceSession, nonEmpty, readLastModel } from './session-files.ts'

export const resolveCodexModel: ModelResolver = (worktreePath, sources) => {
  const codexHome = nonEmpty(sources.env('CODEX_HOME')) ?? join(sources.home, '.codex')
  const log = newestWorkspaceSession(join(codexHome, 'sessions'), worktreePath, 'codex')
  return log === null ? null : readLastModel(log, lastModelIn)
}
