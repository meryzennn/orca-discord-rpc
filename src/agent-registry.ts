import builtin from '../config/agents.json' with { type: 'json' }
import { isRecord } from './type-guards.ts'

/**
 * Names, artwork and model lookup for Orca agent ids.
 *
 * Resolution order: the user's `agents` map in config.json, then the built-in registry in
 * config/agents.json, then a generated fallback. Resolution never throws.
 */

export type AgentEntry = {
  /** Display name on Discord. */
  name?: string
  /** Asset key uploaded to the Discord application; used only with `useUploadedArt`. */
  asset?: string
  /** Public https image; used when uploaded art is not in play. */
  imageUrl?: string
  /** Id of a model resolver module; absent means the tooltip names the agent. */
  modelResolver?: string
}

export type IconRef = { asset: string; imageUrl: string }

export type ResolvedAgent = {
  id: string
  name: string
  asset: string | null
  imageUrl: string | null
  modelResolver: string | null
  /** False when the id is in neither the user map nor the built-in registry. */
  known: boolean
}

export type AgentRegistry = {
  resolve(id: string): ResolvedAgent
  /** Stands in for an agent that has no artwork of its own. */
  fallbackIcon: IconRef
  branchIcon: IconRef
  /** Logs once per key, so a condition that repeats every poll costs one line. */
  noteOnce(key: string, message: string): void
}

export type AgentRegistryOptions = {
  /** The raw `agents` value from config.json; validated here. */
  overrides?: unknown
  log?: (message: string) => void
}

type RegistryFile = {
  fallback: IconRef
  branchIcon: IconRef
  agents: Record<string, AgentEntry>
}

const FIELDS = ['name', 'asset', 'imageUrl', 'modelResolver'] as const

/** "new-agent" becomes "New Agent". Splits on dashes, underscores and spaces. */
export function prettifyAgentId(id: string): string {
  const words = id.split(/[-_\s]+/).filter((part) => part.length > 0).map((part) => {
    // Why spread: the first code point may be a surrogate pair.
    const [first = ''] = part
    return first.toUpperCase() + part.slice(first.length)
  })
  return words.length > 0 ? words.join(' ') : id
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Keeps the valid fields of one user entry and reports each rejected one. */
function readOverride(id: string, raw: unknown, note: (key: string, message: string) => void): AgentEntry {
  if (!isRecord(raw)) {
    note(`override:${id}`, `config.json agents.${JSON.stringify(id)} must be an object; ignored.`)
    return {}
  }
  const entry: AgentEntry = {}
  for (const field of FIELDS) {
    const value = raw[field]
    if (value === undefined) continue
    const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
    const valid = text.length > 0 && (field === 'imageUrl' ? isHttpsUrl(text) : true) &&
      (field === 'asset' || field === 'modelResolver' ? !/\s/.test(text) : true)
    if (valid) entry[field] = text
    else note(`override:${id}:${field}`,
      `config.json agents.${JSON.stringify(id)}.${field} is not valid${field === 'imageUrl' ? ' (an https URL is required)' : ''}; ignored.`)
  }
  return entry
}

export function createAgentRegistry(options: AgentRegistryOptions = {}): AgentRegistry {
  const file = builtin as RegistryFile
  const seen = new Set<string>()
  const noteOnce = (key: string, message: string): void => {
    if (seen.has(key)) return
    seen.add(key)
    try { options.log?.(message) } catch { /* logging must never break presence */ }
  }

  // A Map, so an id such as "constructor" or "__proto__" cannot reach Object.prototype.
  const entries = new Map<string, AgentEntry>(Object.entries(file.agents))
  const { overrides } = options
  if (overrides !== undefined) {
    if (!isRecord(overrides)) {
      noteOnce('overrides', 'config.json "agents" must be an object of agent ids; ignored.')
    } else {
      for (const [id, raw] of Object.entries(overrides)) {
        entries.set(id, { ...entries.get(id), ...readOverride(id, raw, noteOnce) })
      }
    }
  }

  return {
    resolve(id: string): ResolvedAgent {
      const entry = entries.get(id)
      if (entry === undefined) {
        noteOnce(`unknown:${id}`,
          `Unknown agent id ${JSON.stringify(id.slice(0, 64))}: using a generated name and the fallback icon. ` +
          'Add it under "agents" in config.json to set a name, image and model resolver.')
        return { id, name: prettifyAgentId(id), asset: null, imageUrl: null, modelResolver: null, known: false }
      }
      return {
        id,
        name: entry.name ?? prettifyAgentId(id),
        asset: entry.asset ?? null,
        imageUrl: entry.imageUrl ?? null,
        modelResolver: entry.modelResolver ?? null,
        known: true
      }
    },
    fallbackIcon: file.fallback,
    branchIcon: file.branchIcon,
    noteOnce
  }
}

/** Built-in entries only, silent. Used when a caller supplies no registry. */
export const builtinRegistry: AgentRegistry = createAgentRegistry()
