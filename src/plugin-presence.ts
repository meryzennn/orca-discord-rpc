import { builtinRegistry } from './agent-registry.ts'
import { sanitizeRepoWebUrl } from './git-remote.ts'
import { composeText, FORMAT } from './presence-format.ts'
import type { PresenceActivity, PresenceInput } from './presence.ts'

/** The plugin layout: Orca on the large icon and the featured agent on the small one. */
export function buildPluginActivity(input: PresenceInput): PresenceActivity {
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
  const activity: PresenceActivity = {
    details: text.details, state: text.state, startTimestamp: input.startedAt,
    largeImageText: FORMAT.brand, ...(uploaded ? { largeImageKey: registry.fallbackIcon.asset } : {})
  }
  // An agent with no artwork of its own gets the fallback icon rather than an empty slot.
  if (uploaded && agent.asset) activity.smallImageKey = agent.asset
  else if (agent.imageUrl) activity.smallImageUrl = agent.imageUrl
  else if (uploaded) activity.smallImageKey = registry.fallbackIcon.asset
  else activity.smallImageUrl = registry.fallbackIcon.imageUrl
  activity.smallImageText = text.iconText
  if (!input.incognito) {
    const repoUrl = sanitizeRepoWebUrl(input.repoUrl)
    if (repoUrl) activity.buttons = [{ label: FORMAT.repositoryButton, url: repoUrl }]
  }
  return activity
}
