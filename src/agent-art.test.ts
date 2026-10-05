import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agentArtKey, agentFaviconUrl, AGENT_ART_KEYS, BRANCH_ART_KEY } from './agent-art.ts'

describe('agentArtKey', () => {
  it('maps the well-known agents to their upload keys', () => {
    assert.equal(agentArtKey('claude'), 'claude')
    assert.equal(agentArtKey('codex'), 'codex')
    assert.equal(agentArtKey('antigravity'), 'agy')
    assert.equal(agentArtKey('grok'), 'grock')
  })

  it('maps both opencode generations to one key', () => {
    assert.equal(agentArtKey('opencode2'), agentArtKey('opencode'))
  })

  it('treats agent teams as Claude', () => {
    assert.equal(agentArtKey('claude-agent-teams'), 'claude')
  })

  it('returns null for an agent with no artwork', () => {
    assert.equal(agentArtKey('some-in-house-agent'), null)
  })
})

describe('agentFaviconUrl', () => {
  it('returns a public image for agents with a known site', () => {
    assert.ok(agentFaviconUrl('claude')?.startsWith('https://'))
    assert.ok(agentFaviconUrl('cursor')?.startsWith('https://'))
  })

  it('returns null for an agent with no known site', () => {
    assert.equal(agentFaviconUrl('some-in-house-agent'), null)
  })
})
