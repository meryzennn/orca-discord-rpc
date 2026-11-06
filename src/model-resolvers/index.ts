import type { ModelResolver } from './types.ts'
import { resolveAntigravityModel } from './antigravity.ts'
import { resolveClaudeModel } from './claude.ts'
import { resolveCodexModel } from './codex.ts'
import { resolveOmpModel } from './omp.ts'

/** Keyed by the `modelResolver` id used in config/agents.json and in a user's `agents` map. */
const MODEL_RESOLVERS: Record<string, ModelResolver> = {
  claude: resolveClaudeModel,
  codex: resolveCodexModel,
  omp: resolveOmpModel,
  antigravity: resolveAntigravityModel
}

/** Why hasOwn: the id comes from user config, and "constructor" must not resolve to Object's. */
export function modelResolverFor(id: string): ModelResolver | null {
  return Object.hasOwn(MODEL_RESOLVERS, id) ? MODEL_RESOLVERS[id] ?? null : null
}
