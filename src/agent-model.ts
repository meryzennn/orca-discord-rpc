import { homedir } from 'node:os'
import { builtinRegistry, type AgentRegistry } from './agent-registry.ts'
import { modelResolverFor } from './model-resolvers/index.ts'
import type { AgentModelSources } from './model-resolvers/types.ts'

/**
 * The model an agent is running. Orca does not report it, so the resolver the registry names
 * for the agent reads that agent's own session logs (see ./model-resolvers).
 */

const defaultSources: AgentModelSources = { env: (name) => process.env[name], home: homedir() }

export function findAgentModel(
  agentType: string | null,
  worktreePath: string | null,
  sources: AgentModelSources = defaultSources,
  registry: AgentRegistry = builtinRegistry
): string | null {
  if (!agentType || !worktreePath) {
    return null
  }
  const agent = registry.resolve(agentType)
  if (agent.modelResolver === null) {
    return null
  }
  const resolver = modelResolverFor(agent.modelResolver)
  if (resolver === null) {
    registry.noteOnce(`resolver:${agent.modelResolver}`,
      `Agent ${JSON.stringify(agentType.slice(0, 64))} names the unknown model resolver ` +
      `${JSON.stringify(agent.modelResolver.slice(0, 64))}; showing the agent name instead.`)
    return null
  }
  try {
    const raw = resolver(worktreePath, sources)
    return raw === null ? null : prettyModelName(raw)
  } catch (error) {
    // Why swallowed: an unreadable log must cost only the model name, never the presence.
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'error'
    registry.noteOnce(`model:${agentType}:${code}`,
      `Model lookup for agent ${JSON.stringify(agentType.slice(0, 64))} failed (${code}); showing the agent name instead.`)
    return null
  }
}

/** "claude-opus-5-5" becomes "Claude Opus 5.5", "gpt-5.1-codex" becomes "GPT-5.1 Codex". */
export function prettyModelName(raw: string): string {
  let id = raw.trim()
  const bracket = id.indexOf('[')
  if (bracket > 0) {
    id = id.slice(0, bracket)
  }
  // Why: a router prefixes the provider, as in "anthropic/claude-haiku-4-5".
  id = id.slice(id.lastIndexOf('/') + 1)

  const parts = id.split(/[-_]/).filter((part) => part.length > 0)
  if (parts.length > 1 && /^[0-9]{8}$/.test(parts[parts.length - 1] ?? '')) {
    parts.pop()
  }

  const words: string[] = []
  for (const part of parts) {
    const previous = words[words.length - 1]
    if (previous !== undefined && isVersion(part) && isVersion(previous)) {
      words[words.length - 1] = `${previous}.${part}`
    } else if (previous === 'GPT' && /^[0-9]/.test(part)) {
      words[words.length - 1] = `GPT-${part}`
    } else if (part.toLowerCase() === 'gpt') {
      words.push('GPT')
    } else {
      words.push(part[0]!.toUpperCase() + part.slice(1))
    }
  }
  return words.join(' ')
}

function isVersion(part: string): boolean {
  return /^[0-9.]+$/.test(part)
}
