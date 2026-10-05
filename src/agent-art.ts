/**
 * Agent artwork.
 *
 * Verified against a live Discord client: it will not load an image from a loopback URL —
 * `http://127.0.0.1:…` is accepted on the wire but never fetched — so art must come from
 * somewhere Discord can reach. Two supported sources:
 *
 * 1. an asset uploaded to the Discord application (fastest, best quality, no third party);
 * 2. a public https image, here a site favicon, as a zero-setup fallback.
 */

/** Asset keys to upload to the Discord application. The source files share the name. */
export const BRANCH_ART_KEY = 'git-branch'

export const AGENT_ART_KEYS: Record<string, string> = {
  claude: 'claude',
  'claude-agent-teams': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  opencode2: 'opencode',
  'command-code': 'commandcode',
  dsh: 'deepsek-harnnes',
  grok: 'grock',
  hermes: 'hermes',
  antigravity: 'agy',
  agy: 'agy'
}

/** Agent type -> the site whose favicon stands in when nothing is uploaded. */
const AGENT_ICON_DOMAINS: Record<string, string> = {
  claude: 'claude.ai',
  'claude-agent-teams': 'claude.ai',
  codex: 'openai.com',
  opencode: 'opencode.ai',
  opencode2: 'opencode.ai',
  'command-code': 'commandcode.ai',
  dsh: 'deepseek.com',
  grok: 'x.ai',
  hermes: 'hermes.nousresearch.com',
  antigravity: 'antigravity.google',
  agy: 'antigravity.google',
  cursor: 'cursor.com',
  gemini: 'gemini.google.com',
  copilot: 'github.com',
  amp: 'ampcode.com',
  aider: 'aider.chat',
  goose: 'block.github.io',
  devin: 'devin.ai',
  kimi: 'kimi.moonshot.cn'
}

const FAVICON = (domain: string, size: number): string =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`

/** Public stand-in for the branch slot when the uploaded asset is not in play. */
export const BRANCH_ICON_URL = FAVICON('git-scm.com', 128)

/** The uploaded asset key for an agent, or null when it has none. */
export function agentArtKey(agentType: string): string | null {
  return AGENT_ART_KEYS[agentType] ?? null
}

/** A public image URL for an agent, used when uploaded art is not in play. */
export function agentFaviconUrl(agentType: string): string | null {
  const domain = AGENT_ICON_DOMAINS[agentType]
  return domain ? FAVICON(domain, 256) : null
}
