export type AgentModelSources = {
  env: (name: string) => string | undefined
  home: string
}

/**
 * Reads one agent's saved session metadata and returns the raw model id for a workspace, or
 * null when none is recorded. May throw on an unreadable log; the caller swallows and logs it.
 */
export type ModelResolver = (worktreePath: string, sources: AgentModelSources) => string | null
