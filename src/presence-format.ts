import format from '../config/presence-format.json' with { type: 'json' }

/**
 * The only place Discord-facing text is composed. The words live in config/presence-format.json;
 * both the plugin and the headless daemon build their lines here, so they cannot drift apart.
 */

export const FORMAT: Readonly<typeof format> = format

/** Discord truncates activity fields at 128 characters. */
export const FIELD_LIMIT = 128
/** The folder line leaves room for a trailing agent-count suffix inside FIELD_LIMIT. */
const FOLDER_LIMIT = 100
/** Discord rejects any activity field shorter than this, and one bad field fails the whole update. */
const FIELD_MIN = 2

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Collapses newlines and runs of spaces; Discord renders them as a broken line. */
export function normalizeText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

/**
 * Cuts at a grapheme boundary, so an emoji, flag or ZWJ sequence is kept whole or dropped whole.
 * The budget counts UTF-16 units: a character is never counted as less than Discord counts it.
 */
export function clip(value: string, limit: number): string {
  if (value.length <= limit) return value
  let kept = ''
  for (const { segment } of graphemes.segment(value)) {
    if (kept.length + segment.length > limit) break
    kept += segment
  }
  return kept
}

/** An empty string hides the field, which beats a rejected update. */
export function field(value: string): string {
  return value.length >= FIELD_MIN ? value : ''
}

export type TextInput = {
  projectName: string | null
  /** Replaces the folder with the private label. */
  incognito?: boolean
  /** Display name of the featured agent; null when no agent is open. */
  agentName: string | null
  model?: string | null
  /** Agent rows with state working across every workspace. */
  runningAgentCount: number
  /** Workspaces containing at least one working agent, across the snapshot. */
  activeWorkspaceCount: number
  /** False when the featured agent is between turns. */
  agentActive?: boolean
}

export type PresenceText = {
  details: string
  state: string
  /** Tooltip for the agent icon: the model when known, else the agent's name. */
  iconText: string
}

export function composeText(input: TextInput): PresenceText {
  if (input.agentName === null) {
    return { details: FORMAT.noAgentTitle, state: FORMAT.noAgentState, iconText: '' }
  }
  const count = Number.isFinite(input.runningAgentCount) ? Math.max(0, Math.trunc(input.runningAgentCount)) : 0
  // Why field(): a one-character name is dropped, as before the folder prefix existed.
  const folder = field(normalizeText(input.incognito ? FORMAT.privateProject : input.projectName))
  const folderLine = folder ? clip(`${FORMAT.folderPrefix}${folder}`, FOLDER_LIMIT) : ''

  const status = input.agentActive === false ? FORMAT.idle : FORMAT.working
  const agent = field(clip(normalizeText(input.agentName), FIELD_LIMIT))
  // Why status on line 1: Discord's narrow popouts show only the first line.
  const suffix = `${count > 1 ? ` ${FORMAT.othersMarker}${count - 1}` : ''}${FORMAT.separator}${status}`
  return {
    details: agent ? `${clip(agent, FIELD_LIMIT - suffix.length)}${suffix}` : '',
    state: folderLine || status,
    iconText: field(clip(normalizeText(input.model), FIELD_LIMIT)) || agent
  }
}
