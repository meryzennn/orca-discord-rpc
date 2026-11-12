import { builtinRegistry, type AgentRegistry } from './agent-registry.ts'
import { clip, composeText, FIELD_LIMIT, FORMAT, normalizeText } from './presence-format.ts'

export type PresenceInput = {
  projectName: string | null
  /** The agent shown on line 1: the one that most recently entered its state. */
  agentType: string | null
  /** The featured agent's model, such as "Claude Opus 5.5", when its session log names it. */
  model?: string | null
  /** Agent rows with state working across every workspace. */
  runningAgentCount: number
  /** Workspaces containing at least one working agent, across the snapshot. */
  activeWorkspaceCount: number
  /** False when the featured agent is between turns. */
  agentActive?: boolean
  /** Shown as the branch icon's tooltip; the second line carries the folder instead. */
  branchName?: string | null
  repoUrl?: string | null
  startedAt: Date
  /**
   * True when the artwork has been uploaded to the Discord application. Discord will not
   * fetch a loopback URL, so uploaded assets are the only way to use the bundled PNGs;
   * without them the builder falls back to a public image URL.
   */
  useUploadedArt?: boolean
  /** Replaces the folder, branch and repository with the private label. */
  incognito?: boolean
  /** Names, artwork and model lookup for agent ids; the built-in entries when absent. */
  registry?: AgentRegistry
}

export type PresenceActivity = {
  details: string
  state: string
  startTimestamp?: Date
  largeImageKey?: string
  largeImageUrl?: string
  largeImageText?: string
  smallImageKey?: string
  smallImageUrl?: string
  smallImageText?: string
  buttons?: { label: string; url: string }[]
}

/** The daemon layout: the agent on the large icon and the branch on the small one. */
export function buildActivity(input: PresenceInput): PresenceActivity {
  const registry = input.registry ?? builtinRegistry
  const uploaded = input.useUploadedArt === true
  const agent = input.agentType === null ? null : registry.resolve(input.agentType)
  const text = composeText({
    projectName: input.projectName,
    agentName: agent?.name ?? null,
    runningAgentCount: input.runningAgentCount,
    activeWorkspaceCount: input.activeWorkspaceCount,
    ...(input.incognito !== undefined ? { incognito: input.incognito } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.agentActive !== undefined ? { agentActive: input.agentActive } : {})
  })
  if (agent === null) return { details: text.details, state: text.state, startTimestamp: input.startedAt }
  const branchText = clip(normalizeText(input.incognito ? null : input.branchName), FIELD_LIMIT) || FORMAT.branchFallback
  // Discord needs one shape per slot: an asset key or a URL, never both.
  const branchArt = uploaded
    ? { smallImageKey: registry.branchIcon.asset, smallImageText: branchText }
    : { smallImageUrl: registry.branchIcon.imageUrl, smallImageText: branchText }

  const image = (uploaded ? agent.asset : null) ?? agent.imageUrl
  const agentArt = uploaded
    ? { largeImageKey: image ?? registry.fallbackIcon.asset, largeImageText: text.iconText }
    : image !== null
      ? { largeImageUrl: image, largeImageText: text.iconText }
      : { largeImageKey: registry.fallbackIcon.asset, largeImageText: text.iconText }
  return {
    details: text.details,
    state: text.state,
    startTimestamp: input.startedAt,
    ...agentArt,
    ...branchArt
  }
}
