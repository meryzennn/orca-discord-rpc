import { agentDisplayName, PRESENCE_ASSET_KEY, type PresenceActivity, type PresenceInput } from './presence.ts'
import { agentArtKey, agentFaviconUrl, BRANCH_ART_KEY, BRANCH_ICON_URL } from './agent-art.ts'
import { normalizeRepoUrl } from './git-remote.ts'

function truncate(value: string, limit: number): string {
  return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '')
}

function text(value: string | null | undefined, limit = 128): string {
  const normalized = truncate(value?.replace(/\s+/g, ' ').trim() ?? '', limit)
  return normalized.length >= 2 ? normalized : ''
}

export function buildTrayActivity(input: PresenceInput & { incognito?: boolean }): PresenceActivity {
  const uploaded = input.useUploadedArt === true
  const folder = text(input.incognito ? 'Private Project' : input.projectName)
  const project = folder ? truncate(/^folder:/i.test(folder) ? folder : `Folder: ${folder}`, 100) : ''
  const count = Number.isFinite(input.runningAgentCount) ? Math.max(0, Math.trunc(input.runningAgentCount)) : 0
  const status = input.agentActive === false ? 'Idle' : 'Working'
  const activity: PresenceActivity = {
    details: 'Using Orca', state: project || 'Orca', startTimestamp: input.startedAt,
    largeImageText: 'Orca', ...(uploaded ? { largeImageKey: PRESENCE_ASSET_KEY } : {})
  }
  if (input.agentType !== null) {
    const agent = text(agentDisplayName(input.agentType))
    const suffix = `${count > 1 ? ` +${count - 1}` : ''} · ${status}`
    activity.details = agent ? `Agent: ${truncate(agent, 128 - 7 - suffix.length)}${suffix}` : ''
    activity.state = project || status
    if (input.incognito) {
      const key = uploaded ? agentArtKey(input.agentType) : null
      const url = key ? null : agentFaviconUrl(input.agentType)
      if (key || url) {
        if (key) activity.smallImageKey = key
        else if (url) activity.smallImageUrl = url
        activity.smallImageText = text(input.model) || text(`Agent: ${agent}`)
      }
    }
  } else if (count > 1) {
    activity.state = project ? text(`${project} · ${count} agents`) : `${count} agents`
  }
  if (!input.incognito) {
    activity.smallImageText = text(input.branchName) || 'Branch'
    if (uploaded) activity.smallImageKey = BRANCH_ART_KEY
    else activity.smallImageUrl = BRANCH_ICON_URL
    const repoUrl = normalizeRepoUrl(input.repoUrl)
    if (repoUrl) activity.buttons = [{ label: 'View Repository', url: repoUrl }]
  }
  return activity
}
