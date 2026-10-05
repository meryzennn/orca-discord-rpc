/** Only the fields this tool reads from `orca worktree ps --json`. */
export type OrcaAgent = {
  state?: string
  agentType?: string
  stateStartedAt?: number
  updatedAt?: number
}

export type OrcaWorktree = {
  worktreeId?: string
  displayName?: string
  branch?: string
  path?: string
  isActive?: boolean
  lastActivityAt?: number
  /** Orca's persisted user-authored fields; only the pinned label matters here. */
  meta?: { displayNameIsPinned?: boolean }
  agents?: OrcaAgent[]
}

/** States that mean an agent is doing or awaiting work; `done` is not. */
const LIVE_AGENT_STATES = new Set(['working', 'blocked', 'waiting'])

export const MIN_AGENT_STATE_STARTED_AT = 1_000_000_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseWorktreePs(stdout: string): OrcaWorktree[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!isRecord(parsed) || parsed.ok !== true || !isRecord(parsed.result)) {
    return []
  }
  const worktrees = parsed.result.worktrees
  if (!Array.isArray(worktrees)) {
    return []
  }
  return worktrees.filter(isRecord).map((worktree) => ({
    ...worktree,
    agents: Array.isArray(worktree.agents) ? worktree.agents.filter(isRecord) : []
  })) as OrcaWorktree[]
}

export function selectActiveWorktree(worktrees: readonly OrcaWorktree[]): OrcaWorktree | null {
  return worktrees.find((worktree) => worktree.isActive === true) ?? null
}

function hasAgentType(agent: OrcaAgent): boolean {
  return typeof agent.agentType === 'string' && agent.agentType.length > 0
}

/** Every agent that can be named, whatever its state. */
export function allAgents(worktree: OrcaWorktree | null): OrcaAgent[] {
  if (!worktree) {
    return []
  }
  return (worktree.agents ?? []).filter(
    (agent) => typeof agent.state === 'string' && hasAgentType(agent)
  )
}

/** Agents doing or awaiting work right now; `done` means the agent is between turns. */
export function liveAgents(worktree: OrcaWorktree | null): OrcaAgent[] {
  return allAgents(worktree).filter((agent) => LIVE_AGENT_STATES.has(agent.state ?? ''))
}

export function hasActiveAgent(worktree: OrcaWorktree | null): boolean {
  return liveAgents(worktree).length > 0
}

/**
 * Every agent whose pane is open, whether or not it is mid-turn.
 *
 * Why done counts: an agent sits between turns far longer than it works, so counting only
 * live agents made a workspace with two open agents report one whenever the other was idle.
 * A row with no `agentType` is a plain terminal, not an agent.
 */
export function openAgents(worktree: OrcaWorktree | null): OrcaAgent[] {
  return allAgents(worktree)
}

/**
 * The agent the profile should name: the most recently active one, which Orca orders by
 * `stateStartedAt`. An agent that is `done` is still the agent the user has open — dropping
 * it made the presence read "Using Orca" for most of a session, since a coding agent sits
 * between turns far longer than it works.
 *
 * A live agent wins over a newer idle one, so the busier session is what an observer sees.
 */
export function featuredAgent(worktree: OrcaWorktree | null): OrcaAgent | null {
  const live = liveAgents(worktree)
  const candidates = live.length > 0 ? live : allAgents(worktree)
  if (candidates.length === 0) {
    return null
  }
  let best = candidates[0] ?? null
  let bestAt = stateStartedAtOf(best)
  for (const agent of candidates.slice(1)) {
    const startedAt = stateStartedAtOf(agent)
    if (startedAt > bestAt) {
      best = agent
      bestAt = startedAt
    }
  }
  return best
}

function stateStartedAtOf(agent: OrcaAgent | null): number {
  const value = agent?.stateStartedAt
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return Number.NEGATIVE_INFINITY
  }
  // Why: hydrated rows carry a small synthetic stamp; treating it as newest would hand the
  // first line to a restored session over an agent the user actually has open.
  return value >= MIN_AGENT_STATE_STARTED_AT ? value : Number.NEGATIVE_INFINITY
}

/**
 * The folder the workspace lives in, taken from the path.
 *
 * Why the path and not `displayName`: on a git worktree Orca's display name defaults to the
 * branch, so it read as the branch and the actual folder was never shown. When the user
 * renames a workspace, their label wins.
 */
export function projectNameFor(worktree: OrcaWorktree | null): string | null {
  const label = displayNameFor(worktree)
  const meta = worktree?.meta
  const pinned = meta && typeof meta.displayNameIsPinned === 'boolean' ? meta.displayNameIsPinned : false
  if (label !== null && pinned) {
    return label
  }
  const folder = folderNameFromPath(worktree?.path)
  return folder ?? label
}

function displayNameFor(worktree: OrcaWorktree | null): string | null {
  const name = worktree?.displayName
  return typeof name === 'string' && name.length > 0 ? name : null
}

function folderNameFromPath(path: string | undefined): string | null {
  if (typeof path !== 'string' || path.length === 0) {
    return null
  }
  const segment = path.split(/[\\/]/).filter((part) => part.length > 0).pop()
  return segment !== undefined && segment.length > 0 ? segment : null
}

/** The branch, with the `refs/heads/` prefix stripped, for the icon tooltip. */
export function branchNameFor(worktree: OrcaWorktree | null): string | null {
  const branch = worktree?.branch
  if (typeof branch !== 'string' || branch.length === 0) {
    return null
  }
  return branch.replace(/^refs\/heads\//, '')
}

export function runningAgentCount(worktree: OrcaWorktree | null): number {
  return openAgents(worktree).length
}
