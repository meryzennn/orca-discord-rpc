import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentRegistry, prettifyAgentId } from './agent-registry.ts'
import { buildActivity } from './presence.ts'
import { buildPluginActivity } from './plugin-presence.ts'
import { readConfigFile, loadConfig } from './config.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('prettifyAgentId', () => {
  it('title-cases dashes, underscores and spaces', () => {
    assert.equal(prettifyAgentId('omp'), 'Omp')
    assert.equal(prettifyAgentId('new-agent'), 'New Agent')
    assert.equal(prettifyAgentId('foo_bar'), 'Foo Bar')
    assert.equal(prettifyAgentId('some  odd--id'), 'Some Odd Id')
  })

  it('handles non-ASCII and astral first characters', () => {
    assert.equal(prettifyAgentId('éclair-agent'), 'Éclair Agent')
    assert.equal(prettifyAgentId('日本-agent'), '日本 Agent')
    assert.equal(prettifyAgentId('𐐨ix'), '𐐀ix')
  })

  it('returns the id itself when nothing is left to prettify', () => {
    assert.equal(prettifyAgentId('---'), '---')
  })
})

describe('agent registry', () => {
  it('resolves a built-in agent', () => {
    const agent = createAgentRegistry().resolve('omp')
    assert.equal(agent.name, 'Oh My Pi')
    assert.equal(agent.asset, 'omp')
    assert.match(agent.imageUrl ?? '', /^https:\/\//)
    assert.equal(agent.modelResolver, 'omp')
    assert.equal(agent.known, true)
  })

  it('gives an unknown agent a generated name, no icon of its own and no model resolver', () => {
    const logs: string[] = []
    const registry = createAgentRegistry({ log: message => logs.push(message) })
    const agent = registry.resolve('new-agent')
    assert.deepEqual(agent, { id: 'new-agent', name: 'New Agent', asset: null, imageUrl: null, modelResolver: null, known: false })
    assert.equal(registry.fallbackIcon.asset, 'orca')
    assert.match(registry.fallbackIcon.imageUrl, /^https:\/\//)
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /new-agent/)
    assert.match(logs[0]!, /config\.json/)
  })

  it('logs an unknown agent once per id, however often it is resolved', () => {
    const logs: string[] = []
    const registry = createAgentRegistry({ log: message => logs.push(message) })
    for (let poll = 0; poll < 5; poll++) { registry.resolve('alpha'); registry.resolve('beta') }
    assert.equal(logs.length, 2)
  })

  it('does not log a built-in agent that has no artwork', () => {
    const logs: string[] = []
    const agent = createAgentRegistry({ log: message => logs.push(message) }).resolve('qwen-code')
    assert.equal(agent.name, 'Qwen Code')
    assert.equal(agent.imageUrl, null)
    assert.equal(logs.length, 0)
  })

  it('merges a user override field by field over the built-in entry', () => {
    const registry = createAgentRegistry({ overrides: {
      codex: { name: 'Codex CLI' },
      'new-agent': { name: 'New One', asset: 'newone', imageUrl: 'https://example.com/n.png', modelResolver: 'codex' }
    } })
    const codex = registry.resolve('codex')
    assert.equal(codex.name, 'Codex CLI')
    assert.equal(codex.asset, 'codex')
    assert.equal(codex.modelResolver, 'codex')
    assert.deepEqual(registry.resolve('new-agent'),
      { id: 'new-agent', name: 'New One', asset: 'newone', imageUrl: 'https://example.com/n.png', modelResolver: 'codex', known: true })
  })

  it('ignores invalid override fields and reports each once without crashing', () => {
    const logs: string[] = []
    const registry = createAgentRegistry({ log: message => logs.push(message), overrides: {
      codex: { name: '   ', asset: 'has space', imageUrl: 'http://insecure.example/x.png', modelResolver: 7 },
      claude: 'not an object',
      'x-agent': null
    } })
    const codex = registry.resolve('codex')
    assert.equal(codex.name, 'Codex')
    assert.equal(codex.asset, 'codex')
    assert.match(codex.imageUrl ?? '', /openai\.com/)
    assert.equal(codex.modelResolver, 'codex')
    assert.equal(registry.resolve('claude').name, 'Claude')
    assert.equal(logs.length, 6)
    registry.resolve('codex')
    assert.equal(logs.length, 6)
  })

  it('ignores an agents value that is not an object', () => {
    for (const overrides of ['x', 5, [], null, true]) {
      const logs: string[] = []
      const registry = createAgentRegistry({ overrides, log: message => logs.push(message) })
      assert.equal(registry.resolve('claude').name, 'Claude')
      assert.equal(logs.length, 1)
    }
  })

  it('is not affected by ids that name Object.prototype members', () => {
    const registry = createAgentRegistry()
    for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(registry.resolve(id).known, false)
    }
  })

  it('survives a throwing logger', () => {
    const registry = createAgentRegistry({ log: () => { throw new Error('log failed') } })
    assert.equal(registry.resolve('new-agent').name, 'New Agent')
  })

  it('lets a new agent id be added from config.json alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-registry-'))
    try {
      const path = join(root, 'config.json')
      writeFileSync(path, JSON.stringify({ agents: { 'new-agent': { name: 'Brand New', imageUrl: 'https://example.com/b.png' } } }))
      const config = loadConfig({ env: {}, readConfigFile: () => readConfigFile(path) })
      const registry = createAgentRegistry({ overrides: config.agents })
      const input = { projectName: 'app', agentType: 'new-agent', runningAgentCount: 1, activeWorkspaceCount: 1, startedAt: new Date(0) }
      assert.equal(buildPluginActivity({ ...input, registry }).details, 'Brand New · 1 agent working')
      assert.equal(buildPluginActivity({ ...input, registry }).smallImageUrl, 'https://example.com/b.png')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('falls back and logs when config.json is malformed', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-registry-'))
    try {
      const path = join(root, 'config.json')
      writeFileSync(path, '{ "agents": { broken')
      const logs: string[] = []
      const file = readConfigFile(path, message => logs.push(message))
      const registry = createAgentRegistry({ overrides: loadConfig({ env: {}, readConfigFile: () => file }).agents })
      assert.equal(file, null)
      assert.equal(logs.length, 1)
      assert.equal(registry.resolve('claude').name, 'Claude')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('plugin and daemon share one registry and one text format', () => {
  const registry = createAgentRegistry({ overrides: { 'new-agent': { name: 'Brand New' } } })
  const startedAt = new Date('2026-11-07T00:00:00Z')
  const agents = ['claude', 'claude-agent-teams', 'codex', 'omp', 'antigravity', 'agy', 'opencode', 'cursor', 'qwen-code', 'new-agent', 'unseen-agent', 'q']
  const projects = ['sample', null, 'x', '日本語-プロジェクト', 'a  b\nc', 'a'.repeat(300), `${'a'.repeat(94)}👨‍👩‍👧`]

  it('produce the same text and tooltip for every agent, count, status, folder and privacy mode', () => {
    for (const agentType of [...agents, null]) {
      for (const [runningAgentCount, activeWorkspaceCount] of [[0, 0], [1, 1], [3, 1], [3, 2]] as const) {
        for (const projectName of projects) {
          for (const incognito of [false, true]) {
            for (const model of [null, 'Claude Opus 5.5']) {
              const input = { projectName, agentType, runningAgentCount,
                activeWorkspaceCount, incognito, model, startedAt, registry }
              const plugin = buildPluginActivity(input)
              const daemon = buildActivity(input)
              const label = JSON.stringify(input.projectName) + ' ' + String(agentType)
              assert.equal(plugin.details, daemon.details, label)
              assert.equal(plugin.state, daemon.state, label)
              if (agentType !== null) assert.equal(plugin.smallImageText, daemon.largeImageText, label)
            }
          }
        }
      }
    }
  })

  it('resolve every built-in agent to the same name in both layouts', () => {
    for (const agentType of agents) {
      const input = { projectName: 'sample', agentType, runningAgentCount: 1, activeWorkspaceCount: 1, startedAt, registry }
      const name = registry.resolve(agentType).name
      assert.equal(buildPluginActivity(input).details, buildActivity(input).details)
      if (name.length >= 2) assert.ok(buildPluginActivity(input).details.startsWith(name), agentType)
    }
  })
})
