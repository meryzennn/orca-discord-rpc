import { agentArtKey, agentFaviconUrl, BRANCH_ART_KEY, BRANCH_ICON_URL } from './agent-art.ts'

export const PRESENCE_ASSET_KEY = 'orca'

/** Brand spellings a naive title-case would mangle. */
const KNOWN_AGENT_LABELS: Record<string, string> = {
  'claude-agent-teams': 'Claude',
  opencode: 'OpenCode',
  opencode2: 'OpenCode',
  'qwen-code': 'Qwen Code'
}

/** Discord truncates activity fields at 128 characters. */
const FIELD_LIMIT = 128
const PROJECT_LIMIT = 100
/** Discord rejects any activity field shorter than this, and one bad field fails the whole update. */
const FIELD_MIN = 2

function field(value: string): string {
  return value.length >= FIELD_MIN ? value : ''
}

// Why: a workspace name can carry newlines and runs of spaces; Discord renders them as a broken line.
function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export type PresenceInput = {
  projectName: string | null
  /** The agent shown on line 1: the one that most recently entered its state. */
  agentType: string | null
  runningAgentCount: number
  /** False when the featured agent is between turns. */
  agentActive?: boolean
  /** Shown as the branch icon's tooltip; the second line carries the status instead. */
  branchName?: string | null
  startedAt: Date
  /**
   * True when the artwork has been uploaded to the Discord application. Discord will not
   * fetch a loopback URL, so uploaded assets are the only way to use the bundled PNGs;
   * without them the builder falls back to a public favicon.
   */
  useUploadedArt?: boolean
}

export type PresenceActivity = {
  details: string
  state: string
  startTimestamp: Date
  largeImageKey?: string
  largeImageUrl?: string
  largeImageText?: string
  smallImageKey?: string
  smallImageUrl?: string
  smallImageText?: string
}

export function agentDisplayName(agentType: string): string {
  const known = KNOWN_AGENT_LABELS[agentType]
  if (known) {
    return known
  }
  return agentType
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => (part[0] ?? '').toUpperCase() + part.slice(1))
    .join(' ')
}

export function agentImageUrl(agentType: string, useUploadedArt: boolean): string | null {
  if (useUploadedArt) {
    const key = agentArtKey(agentType)
    if (key !== null) {
      return key
    }
  }
  return agentFaviconUrl(agentType)
}

export function buildActivity(input: PresenceInput): PresenceActivity {
  const project = field(
    input.projectName ? normalizeName(input.projectName).slice(0, PROJECT_LIMIT) : ''
  )
  const count = Math.max(0, Math.trunc(input.runningAgentCount))
  const uploaded = input.useUploadedArt === true
  const branchText = input.branchName ? normalizeName(input.branchName).slice(0, 128) : 'Branch'
  // Discord needs one shape per slot: an asset key or a URL, never both. The branch name is
  // the icon's tooltip, since line 2 carries the agent status instead.
  const branchArt = uploaded
    ? { smallImageKey: BRANCH_ART_KEY, smallImageText: branchText }
    : { smallImageUrl: BRANCH_ICON_URL, smallImageText: branchText }

  if (input.agentType === null) {
    const state = composeStateLine(project, count)
    return {
      details: 'Using Orca',
      // Why a fallback: an empty state simply hides line 2, which beats a rejected update.
      state: state.length >= FIELD_MIN ? state : 'Orca',
      startTimestamp: input.startedAt,
      largeImageKey: PRESENCE_ASSET_KEY,
      largeImageText: 'Orca',
      ...branchArt
    }
  }

  const agent = agentDisplayName(input.agentType)
  const image = agentImageUrl(input.agentType, uploaded)
  const agentArt = uploaded
    ? { largeImageKey: image ?? PRESENCE_ASSET_KEY, largeImageText: 'Agent' }
    : image !== null
      ? { largeImageUrl: image, largeImageText: 'Agent' }
      : { largeImageKey: PRESENCE_ASSET_KEY, largeImageText: 'Agent' }
  return {
    details: field(withOtherAgents(agent, input.runningAgentCount)),
    // Why the status and not a count: "+N" on line 1 already says how many agents are open.
    state: composeAgentStateLine(project, input.agentActive !== false),
    startTimestamp: input.startedAt,
    ...agentArt,
    ...branchArt
  }
}

/**
 * Names the featured agent and, when more are open, how many others there are: "Codex +1".
 * Why on line 1: another open agent is the most useful thing an observer can be told about
 * the session, and the field limit leaves no room for it beside the project on line 2.
 */
function withOtherAgents(agent: string, runningAgentCount: number): string {
  const others = Math.max(0, Math.trunc(runningAgentCount)) - 1
  return others > 0 ? `${agent} +${others}` : agent
}

/** Line 2 for an agent row: the folder, then whether the agent is mid-turn. */
function composeAgentStateLine(project: string, active: boolean): string {
  const status = active ? 'Working' : 'Idle'
  if (project.length === 0) {
    return status
  }
  const suffix = ` · ${status}`
  const room = Math.max(0, FIELD_LIMIT - suffix.length)
  return `${project.slice(0, room)}${suffix}`
}

function composeStateLine(project: string, count: number): string {
  const suffix = count > 1 ? ` · ${count} agents` : ''
  if (project.length === 0) {
    // Why 'agents' and not the count alone: a lone digit would be under the field minimum.
    return count > 1 ? `${count} agents` : ''
  }
  const room = Math.max(0, FIELD_LIMIT - suffix.length)
  return `${project.slice(0, room)}${suffix}`
}
