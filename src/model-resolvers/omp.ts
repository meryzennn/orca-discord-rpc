import { join } from 'node:path'
import type { ModelResolver } from './types.ts'
import { newestWorkspaceSession, nonEmpty, readLastModel } from './session-files.ts'

/**
 * Why not a plain "model" scan: OMP records model changes as their own entries, separately
 * from replies, and logs auxiliary usage (such as a judge model) that must not replace the
 * conversation model.
 */
function lastOmpModelIn(text: string): string | null {
  let last: string | null = null
  for (const line of text.split('\n')) {
    try {
      const entry: unknown = JSON.parse(line)
      if (entry === null || typeof entry !== 'object' || !('type' in entry)) continue
      let model: unknown = null
      if (entry.type === 'model_change' && 'model' in entry) model = entry.model
      else if (entry.type === 'message' && 'message' in entry) {
        const message = entry.message
        if (message !== null && typeof message === 'object' && 'role' in message &&
          message.role === 'assistant' && 'model' in message) model = message.model
      }
      if (typeof model === 'string' && model.trim() && !model.startsWith('<')) last = model
    } catch {
      // A reverse-read block may start or end partway through a JSONL record.
    }
  }
  return last
}

export const resolveOmpModel: ModelResolver = (worktreePath, sources) => {
  const agentDir = nonEmpty(sources.env('PI_CODING_AGENT_DIR')) ?? join(sources.home, '.omp', 'agent')
  const log = newestWorkspaceSession(join(agentDir, 'sessions'), worktreePath, 'omp')
  return log === null ? null : readLastModel(log, lastOmpModelIn)
}
