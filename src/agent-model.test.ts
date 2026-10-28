import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { claudeProjectSlug, findAgentModel, lastModelIn, prettyModelName } from './agent-model.ts'

describe('prettyModelName', () => {
  it('names the model the way people write it', () => {
    const cases: Array<[string, string]> = [
      ['claude-opus-5-5', 'Claude Opus 5.5'],
      ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'],
      ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
      ['claude-opus-4-6[1m]', 'Claude Opus 4.6'],
      ['anthropic/claude-haiku-4-5', 'Claude Haiku 4.5'],
      ['gpt-5.1-codex-max', 'GPT-5.1 Codex Max'],
      ['gpt-4o', 'GPT-4o'],
      ['cmdcode', 'Cmdcode']
    ]
    for (const [raw, expected] of cases) {
      assert.equal(prettyModelName(raw), expected, raw)
    }
  })
})

describe('claudeProjectSlug', () => {
  it('turns every non-alphanumeric character into a dash', () => {
    assert.equal(claudeProjectSlug('D:/coding/orca-discord-rpc'), 'D--coding-orca-discord-rpc')
    assert.equal(claudeProjectSlug('/home/me/.config/proj'), '-home-me--config-proj')
  })
})

describe('lastModelIn', () => {
  it('takes the last real model and skips synthetic and quoted ones', () => {
    const log = [
      '{"message":{"model":"claude-sonnet-4-5"}}',
      '{"message":{"model":"claude-opus-5-5"}}',
      '{"message":{"model":"<synthetic>"}}',
      // Why: a model name quoted inside a message is escaped and must not count.
      '{"content":"use \\"model\\":\\"gpt-4o\\""}'
    ].join('\n')
    assert.equal(lastModelIn(log), 'claude-opus-5-5')
    assert.equal(lastModelIn('{}'), null)
  })
})

describe('findAgentModel', () => {
  let home = ''
  const freshHome = (): string => (home = mkdtempSync(join(tmpdir(), 'orca-model-')))
  const noEnv = (): string | undefined => undefined
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('reads Claude from the newest session of the worktree', () => {
    freshHome()
    const dir = join(home, '.claude', 'projects', '-home-me-app')
    mkdirSync(dir, { recursive: true })
    const older = join(dir, 'old.jsonl')
    writeFileSync(older, '{"type":"assistant","message":{"model":"claude-sonnet-4-5"}}\n')
    const hourAgo = new Date(Date.now() - 3_600_000)
    utimesSync(older, hourAgo, hourAgo)
    writeFileSync(join(dir, 'new.jsonl'), '{"type":"assistant","message":{"model":"claude-opus-5-5"}}\n')

    assert.equal(findAgentModel('claude', '/home/me/app', { env: noEnv, home }), 'Claude Opus 5.5')
  })

  it('reads Codex from the session whose folder matches', () => {
    freshHome()
    const day = join(home, '.codex', 'sessions', '2026', '10', '08')
    mkdirSync(day, { recursive: true })
    writeFileSync(
      join(day, 'rollout-a.jsonl'),
      '{"type":"session_meta","payload":{"cwd":"/home/me/app"}}\n{"type":"turn_context","payload":{"model":"gpt-5.1-codex"}}\n'
    )
    writeFileSync(
      join(day, 'rollout-b.jsonl'),
      '{"type":"session_meta","payload":{"cwd":"/home/me/other"}}\n{"type":"turn_context","payload":{"model":"gpt-4o"}}\n'
    )

    assert.equal(findAgentModel('codex', '/home/me/app', { env: noEnv, home }), 'GPT-5.1 Codex')
  })

  it('honours the config folder override', () => {
    freshHome()
    const custom = join(home, 'custom-claude')
    const dir = join(custom, 'projects', '-home-me-app')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 's.jsonl'), '{"message":{"model":"claude-haiku-4-5"}}\n')

    const env = (name: string): string | undefined => (name === 'CLAUDE_CONFIG_DIR' ? custom : undefined)
    assert.equal(findAgentModel('claude', '/home/me/app', { env, home }), 'Claude Haiku 4.5')
  })

  it('knows nothing for an unsupported agent or a missing log', () => {
    freshHome()
    assert.equal(findAgentModel('opencode', '/home/me/app', { env: noEnv, home }), null)
    assert.equal(findAgentModel('claude', '/home/me/app', { env: noEnv, home }), null)
    assert.equal(findAgentModel('codex', '/home/me/app', { env: noEnv, home }), null)
    assert.equal(findAgentModel(null, '/home/me/app', { env: noEnv, home }), null)
    assert.equal(findAgentModel('claude', null, { env: noEnv, home }), null)
  })
})
